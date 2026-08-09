package main

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Delivery is at-least-once and survives restarts: windows are written to disk
// before any attempt to send them, so a probe that loses connectivity keeps
// measuring and back-fills once the panel is reachable again. Records carry
// their original timestamps, so late delivery does not distort history.

const (
	spoolDirName      = "spool"
	quarantineDirName = "quarantine"

	// The spool is a safety net, not a database. Past this size the oldest
	// batches are dropped so a long outage cannot fill the operator's disk.
	maxSpoolBytes = 64 * 1024 * 1024

	// A batch the panel keeps refusing is moved aside instead of blocking the
	// queue forever.
	maxAttemptsBeforeQuarantine = 8

	// Quarantine is kept for post-mortem only, so it is capped much lower than
	// the spool and pruned oldest-first.
	maxQuarantineBytes = 8 * 1024 * 1024
)

type Shipper struct {
	dataDir    string
	client     *PanelClient
	ingestURL  string
	attempts   map[string]int
	backoffFor time.Duration
	nextTry    time.Time
}

func NewShipper(dataDir string, client *PanelClient) *Shipper {
	return &Shipper{
		dataDir:  dataDir,
		client:   client,
		attempts: make(map[string]int),
	}
}

func (s *Shipper) spoolDir() string      { return filepath.Join(s.dataDir, spoolDirName) }
func (s *Shipper) quarantineDir() string { return filepath.Join(s.dataDir, quarantineDirName) }

func (s *Shipper) SetIngestURL(url string) { s.ingestURL = url }

// Enqueue writes a batch to disk atomically. The temporary name keeps a partial
// write from ever being picked up by the drain loop.
func (s *Shipper) Enqueue(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	if err := os.MkdirAll(s.spoolDir(), 0o700); err != nil {
		return err
	}

	name := fmt.Sprintf("%d-%04d.ndjson", time.Now().UnixNano(), rand.Intn(10000))
	final := filepath.Join(s.spoolDir(), name)
	tmp := final + ".tmp"

	if err := os.WriteFile(tmp, payload, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, final); err != nil {
		return err
	}

	s.enforceCap()
	return nil
}

// enforceCap drops the oldest batches when the spool grows past its limit.
func (s *Shipper) enforceCap() {
	files, total := s.listSpool()
	if total <= maxSpoolBytes {
		return
	}

	for _, f := range files {
		if total <= maxSpoolBytes {
			return
		}
		if err := os.Remove(filepath.Join(s.spoolDir(), f.name)); err == nil {
			total -= f.size
			logWarn("spool over capacity, dropped oldest batch %s", f.name)
		}
	}
}

type spoolFile struct {
	name string
	size int64
}

// listSpool returns pending batches oldest first; names are nanosecond
// timestamps, so lexical order is chronological.
func (s *Shipper) listSpool() ([]spoolFile, int64) {
	entries, err := os.ReadDir(s.spoolDir())
	if err != nil {
		return nil, 0
	}

	files := make([]spoolFile, 0, len(entries))
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".ndjson") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, spoolFile{name: entry.Name(), size: info.Size()})
		total += info.Size()
	}

	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	return files, total
}

// Drain sends pending batches oldest first. It stops at the first transient
// failure and backs off exponentially, so a panel under load is not hammered.
func (s *Shipper) Drain(ctx context.Context) {
	if time.Now().Before(s.nextTry) {
		return
	}

	files, _ := s.listSpool()
	for _, f := range files {
		select {
		case <-ctx.Done():
			return
		default:
		}

		path := filepath.Join(s.spoolDir(), f.name)
		payload, err := os.ReadFile(path)
		if err != nil {
			_ = os.Remove(path)
			continue
		}

		result, err := s.client.Ship(ctx, s.ingestURL, payload)
		if err == nil {
			_ = os.Remove(path)
			delete(s.attempts, f.name)
			s.resetBackoff()
			continue
		}

		s.attempts[f.name]++

		if result != nil && !result.Retryable {
			// A permanent rejection will not become acceptable on retry, and
			// it concerns this batch alone: the queue keeps moving.
			s.quarantine(path, f.name, err)
			continue
		}
		if s.attempts[f.name] >= maxAttemptsBeforeQuarantine {
			s.quarantine(path, f.name, err)
			continue
		}

		// Anything transient stops the drain: retrying the rest of the queue
		// against a panel that just refused us only wastes the batches.
		s.backoff()
		logWarn("delivery deferred (%v), retrying in %s", err, s.backoffFor)
		return
	}
}

func (s *Shipper) quarantine(path, name string, cause error) {
	if err := os.MkdirAll(s.quarantineDir(), 0o700); err != nil {
		_ = os.Remove(path)
		return
	}
	dest := filepath.Join(s.quarantineDir(), name)
	if err := os.Rename(path, dest); err != nil {
		_ = os.Remove(path)
	}
	delete(s.attempts, name)
	s.pruneQuarantine()
	logWarn("batch %s quarantined: %v", name, cause)
}

// pruneQuarantine keeps rejected batches from growing without bound: they are
// diagnostic material, and the newest ones explain the problem just as well.
func (s *Shipper) pruneQuarantine() {
	entries, err := os.ReadDir(s.quarantineDir())
	if err != nil {
		return
	}

	files := make([]spoolFile, 0, len(entries))
	var total int64
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, spoolFile{name: entry.Name(), size: info.Size()})
		total += info.Size()
	}
	if total <= maxQuarantineBytes {
		return
	}

	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	for _, f := range files {
		if total <= maxQuarantineBytes {
			return
		}
		if err := os.Remove(filepath.Join(s.quarantineDir(), f.name)); err == nil {
			total -= f.size
		}
	}
}

func (s *Shipper) backoff() {
	if s.backoffFor == 0 {
		s.backoffFor = 30 * time.Second
	} else {
		s.backoffFor *= 2
		if s.backoffFor > 15*time.Minute {
			s.backoffFor = 15 * time.Minute
		}
	}
	s.nextTry = time.Now().Add(s.backoffFor)
}

func (s *Shipper) resetBackoff() {
	s.backoffFor = 0
	s.nextTry = time.Time{}
}
