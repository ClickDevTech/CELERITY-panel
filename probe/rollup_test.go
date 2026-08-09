package main

import (
	"testing"
	"time"
)

func TestPercentileNearestRank(t *testing.T) {
	values := []int{10, 20, 30, 40, 50, 60, 70, 80, 90, 100}

	// Nearest rank: the value at position ceil(p/100 * N), one-based.
	if got := percentile(values, 50); got != 50 {
		t.Fatalf("p50 = %d, want 50", got)
	}
	if got := percentile(values, 95); got != 100 {
		t.Fatalf("p95 = %d, want 100", got)
	}
	// A short sample must not collapse p95 onto the maximum by accident: with
	// 20 values the 95th percentile is the 19th, not the 20th.
	twenty := make([]int, 20)
	for i := range twenty {
		twenty[i] = i + 1
	}
	if got := percentile(twenty, 95); got != 19 {
		t.Fatalf("p95 of 1..20 = %d, want 19", got)
	}
	if got := percentile(nil, 50); got != 0 {
		t.Fatalf("empty sample must yield 0, got %d", got)
	}
	// The input must not be reordered: callers keep using their slice.
	if values[0] != 10 {
		t.Fatal("percentile mutated the caller slice")
	}
}

// A tie resolves to the most specific cause, because that is the one that
// points at a concrete action.
func TestDominantCodePrefersSpecificCause(t *testing.T) {
	codes := FailureCodes{AuthRejected: 2, TunnelNoData: 2}
	if got := codes.dominant(); got != CodeAuthRejected {
		t.Fatalf("dominant = %q, want %q", got, CodeAuthRejected)
	}

	empty := FailureCodes{}
	if got := empty.dominant(); got != "" {
		t.Fatalf("healthy window must have no dominant code, got %q", got)
	}
}

func TestAggregatorFoldsWindowAndResets(t *testing.T) {
	agg := NewAggregator()
	binding := Binding{NodeID: "node-1", InboundID: "main", InboundTag: "vless-in"}

	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), OK: true, LatencyMs: 100, TTFBMs: 100}, nil)
	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), OK: true, LatencyMs: 300, TTFBMs: 300}, nil)
	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), Code: CodeHandshakeFailed, Err: "tls timeout"}, nil)

	records, commit := agg.Snapshot("fp-1")
	commit()

	var transport *Record
	for i := range records {
		if records[i].Kind == "transport" {
			transport = &records[i]
		}
	}
	if transport == nil {
		t.Fatal("no transport record produced")
	}
	if transport.Attempts != 3 || transport.OK != 2 {
		t.Fatalf("attempts=%d ok=%d, want 3 and 2", transport.Attempts, transport.OK)
	}
	if transport.Codes.HandshakeFailed != 1 {
		t.Fatalf("handshake failure not counted: %+v", transport.Codes)
	}
	if transport.NetFingerprint != "fp-1" {
		t.Fatalf("fingerprint missing: %q", transport.NetFingerprint)
	}

	// A transition from healthy to failing must be reported immediately so
	// alerting does not wait for the window to close.
	var event *Record
	for i := range records {
		if records[i].Kind == "event" {
			event = &records[i]
		}
	}
	if event == nil || event.Event != "node_unreachable" || event.Code != CodeHandshakeFailed {
		t.Fatalf("expected a node_unreachable transition, got %+v", event)
	}

	// Committing resets the window, otherwise counts would accumulate forever.
	if again, _ := agg.Snapshot("fp-1"); len(again) != 0 {
		t.Fatalf("commit did not reset the aggregator, got %d records", len(again))
	}
}

// A snapshot that is never committed must leave the data in place: the caller
// only commits once the batch is on disk, and a failed spool write has to be
// recoverable on the next report.
func TestSnapshotWithoutCommitKeepsData(t *testing.T) {
	agg := NewAggregator()
	binding := Binding{NodeID: "node-1", InboundID: "main"}

	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), OK: true, LatencyMs: 10}, nil)

	first, _ := agg.Snapshot("fp-1")
	if len(first) == 0 {
		t.Fatal("snapshot produced nothing")
	}

	second, commit := agg.Snapshot("fp-1")
	if len(second) != len(first) {
		t.Fatalf("uncommitted data was lost: %d records, want %d", len(second), len(first))
	}
	commit()

	if third, _ := agg.Snapshot("fp-1"); len(third) != 0 {
		t.Fatalf("commit did not clear the window, got %d records", len(third))
	}
}

// A dead local core is a fault of the probe host. Reporting it as a node
// outage would send the operator to fix a node that is perfectly healthy.
func TestCoreDownNeverAlertsAboutNode(t *testing.T) {
	agg := NewAggregator()
	binding := Binding{NodeID: "node-1", InboundID: "main"}

	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), OK: true}, nil)
	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), Code: CodeCoreDown}, nil)

	records, _ := agg.Snapshot("")
	for _, rec := range records {
		if rec.Kind == "event" {
			t.Fatalf("core failure raised a node alert: %+v", rec)
		}
	}

	var transport *Record
	for i := range records {
		if records[i].Kind == "transport" {
			transport = &records[i]
		}
	}
	if transport == nil || transport.Codes.CoreDown != 1 {
		t.Fatalf("core failure not recorded separately: %+v", transport)
	}
	if transport.LastCode != CodeCoreDown {
		t.Fatalf("lastCode = %q, want %q", transport.LastCode, CodeCoreDown)
	}
}

// A node already broken when the probe starts has no healthy state to fall
// from, but it still has to produce an alert.
func TestFirstFailureAfterStartAlerts(t *testing.T) {
	agg := NewAggregator()
	binding := Binding{NodeID: "node-1", InboundID: "main"}

	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), Code: CodeNetUnreachable}, nil)

	records, _ := agg.Snapshot("")
	events := 0
	for _, rec := range records {
		if rec.Kind == "event" {
			events++
		}
	}
	if events != 1 {
		t.Fatalf("a node broken at startup must alert once, got %d events", events)
	}
}

func TestAggregatorEmitsOneEventPerTransition(t *testing.T) {
	agg := NewAggregator()
	binding := Binding{NodeID: "node-1", InboundID: "main"}

	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), OK: true}, nil)
	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), Code: CodeNetUnreachable}, nil)
	agg.AddTransport(CheckResult{Binding: binding, At: time.Now(), Code: CodeNetUnreachable}, nil)

	records, _ := agg.Snapshot("")

	events := 0
	for _, rec := range records {
		if rec.Kind == "event" {
			events++
		}
	}
	if events != 1 {
		t.Fatalf("a sustained outage must alert once, got %d events", events)
	}
}

func TestEncodeNDJSONProducesOneLinePerRecord(t *testing.T) {
	payload, err := EncodeNDJSON([]Record{
		{Kind: "transport", NodeID: "a"},
		{Kind: "meta", Version: "1.0"},
	})
	if err != nil {
		t.Fatalf("encode failed: %v", err)
	}

	lines := 0
	for _, b := range payload {
		if b == '\n' {
			lines++
		}
	}
	if lines != 2 {
		t.Fatalf("expected 2 NDJSON lines, got %d", lines)
	}
}
