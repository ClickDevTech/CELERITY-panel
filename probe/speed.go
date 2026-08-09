package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Throughput measurement burns real traffic on the operator's own nodes, so it
// is bounded three ways: per-run byte cap, per-run time cap, and a daily budget
// shared by all nodes. The scheduler spends the budget round-robin so every
// node is sampled over time instead of one node consuming everything.
const speedTestURLTemplate = "https://speed.cloudflare.com/__down?bytes=%d"

const (
	// Share of the byte cap pulled and thrown away before the clock starts.
	// TCP slow start, the TLS handshake tail and the proxy's own buffering all
	// land in the opening bytes and say nothing about what the node can hold.
	speedWarmupShare = 4
	// Beyond this the warm-up would eat a large cap for no extra accuracy.
	speedWarmupMaxBytes = 512 * 1024
	// The connection gets its own allowance so setup never eats into the
	// measured window.
	speedConnectGrace = 15 * time.Second
	speedReadChunk    = 64 * 1024
)

// SpeedBudget persists the spent portion of the daily allowance so a restart
// cannot reset it and blow through the operator's traffic.
type SpeedBudget struct {
	mu   sync.Mutex
	path string

	Day        string `json:"day"`
	SpentBytes int64  `json:"spentBytes"`
	NextIndex  int    `json:"nextIndex"`
}

func LoadSpeedBudget(dataDir string) *SpeedBudget {
	b := &SpeedBudget{path: filepath.Join(dataDir, "speed-budget.json")}

	data, err := os.ReadFile(b.path)
	if err == nil {
		_ = json.Unmarshal(data, b)
	} else if !errors.Is(err, os.ErrNotExist) {
		logWarn("speed budget unreadable: %v", err)
	}

	b.rollDay()
	return b
}

func (b *SpeedBudget) rollDay() {
	today := time.Now().UTC().Format("2006-01-02")
	if b.Day != today {
		b.Day = today
		b.SpentBytes = 0
	}
}

func (b *SpeedBudget) save() {
	data, err := json.Marshal(b)
	if err != nil {
		return
	}
	tmp := b.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, b.path)
}

// Allow reports whether another run of at most maxBytes fits into today's
// budget. A zero budget disables measurement entirely.
func (b *SpeedBudget) Allow(maxBytes, dailyBudget int64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.rollDay()
	if dailyBudget <= 0 || maxBytes <= 0 {
		return false
	}
	return b.SpentBytes+maxBytes <= dailyBudget
}

func (b *SpeedBudget) Spend(bytes int64) {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.rollDay()
	b.SpentBytes += bytes
	b.save()
}

// NextBinding picks the binding to measure next, cycling through the fleet.
func (b *SpeedBudget) NextBinding(count int) int {
	b.mu.Lock()
	defer b.mu.Unlock()

	if count == 0 {
		return -1
	}
	idx := b.NextIndex % count
	b.NextIndex = (idx + 1) % count
	b.save()
	return idx
}

// SpeedSample is one throughput observation taken through a node.
type SpeedSample struct {
	// Bps is the throughput of the timed part of the transfer.
	Bps int64
	// Transferred counts every byte pulled through the node, warm-up included:
	// the operator pays for those as well, so the budget must see them.
	Transferred int64
	// Capped marks a run that ended on the byte cap instead of on the clock.
	// The link was never given the chance to show more, so Bps is a floor and
	// has to be presented as one.
	Capped bool
}

// MeasureSpeed downloads a bounded amount of data through one node and returns
// the observed throughput in bytes per second.
func MeasureSpeed(ctx context.Context, b Binding, maxBytes int64, maxSeconds int) (SpeedSample, error) {
	var sample SpeedSample
	if maxBytes <= 0 {
		return sample, errors.New("speed test disabled")
	}
	if maxSeconds <= 0 {
		maxSeconds = 5
	}
	window := time.Duration(maxSeconds) * time.Second

	// The read loop enforces the measurement window itself; these limits are
	// the outer guard that stops a stalled transfer from hanging the pass.
	hardLimit := speedConnectGrace + 2*window
	runCtx, cancel := context.WithTimeout(ctx, hardLimit)
	defer cancel()

	socksAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(b.SocksPort))
	client := tunnelClient(socksAddr, hardLimit, nil)

	url := fmt.Sprintf(speedTestURLTemplate, maxBytes)
	req, err := http.NewRequestWithContext(runCtx, http.MethodGet, url, nil)
	if err != nil {
		return sample, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return sample, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return sample, fmt.Errorf("speed endpoint answered %d", resp.StatusCode)
	}

	sample = readSpeedBody(resp.Body, maxBytes, window)
	if sample.Bps <= 0 {
		return sample, errors.New("no data transferred")
	}
	return sample, nil
}

// readSpeedBody drains the response and times only the steady part of it. The
// clock starts after the warm-up bytes and stops at the measurement window, so
// neither the handshake nor the ramp-up is charged to the node as slowness.
func readSpeedBody(body io.Reader, maxBytes int64, window time.Duration) SpeedSample {
	warmup := maxBytes / speedWarmupShare
	if warmup > speedWarmupMaxBytes {
		warmup = speedWarmupMaxBytes
	}

	buf := make([]byte, speedReadChunk)
	opened := time.Now()

	var sample SpeedSample
	var timed int64
	var started, deadline time.Time

	for {
		n, err := body.Read(buf)
		if n > 0 {
			sample.Transferred += int64(n)
			if started.IsZero() {
				if sample.Transferred >= warmup {
					started = time.Now()
					deadline = started.Add(window)
				}
			} else {
				timed += int64(n)
			}
		}
		if err != nil {
			break
		}
		if sample.Transferred >= maxBytes {
			break
		}
		if !started.IsZero() && !time.Now().Before(deadline) {
			break
		}
	}

	// The server is asked for exactly maxBytes, so reaching the end of the body
	// means the cap ended the run, not the link running out of steam.
	sample.Capped = sample.Transferred >= maxBytes

	elapsed := time.Since(started)
	if started.IsZero() || timed <= 0 || elapsed <= 0 {
		// Too little arrived to drop a warm-up, or it went by faster than the
		// clock can resolve. Timing the whole body is still closer to the truth
		// than timing the handshake along with it.
		timed = sample.Transferred
		elapsed = time.Since(opened)
	}
	if elapsed > 0 && timed > 0 {
		sample.Bps = int64(float64(timed) / elapsed.Seconds())
	}
	return sample
}
