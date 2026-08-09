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

// MeasureSpeed downloads a bounded amount of data through one node and returns
// the observed throughput in bytes per second.
func MeasureSpeed(ctx context.Context, b Binding, maxBytes int64, maxSeconds int) (int64, int64, error) {
	if maxBytes <= 0 {
		return 0, 0, errors.New("speed test disabled")
	}
	if maxSeconds <= 0 {
		maxSeconds = 5
	}

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(maxSeconds)*time.Second)
	defer cancel()

	socksAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(b.SocksPort))
	client := tunnelClient(socksAddr, time.Duration(maxSeconds+5)*time.Second, nil)

	url := fmt.Sprintf(speedTestURLTemplate, maxBytes)
	req, err := http.NewRequestWithContext(runCtx, http.MethodGet, url, nil)
	if err != nil {
		return 0, 0, err
	}

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()

	read, err := io.Copy(io.Discard, io.LimitReader(resp.Body, maxBytes))
	elapsed := time.Since(start)

	// A deadline hit is the normal way a capped measurement ends: whatever was
	// transferred is still a valid sample.
	if err != nil && read == 0 {
		return 0, 0, err
	}
	if elapsed <= 0 || read <= 0 {
		return 0, read, errors.New("no data transferred")
	}

	bps := int64(float64(read) / elapsed.Seconds())
	return bps, read, nil
}
