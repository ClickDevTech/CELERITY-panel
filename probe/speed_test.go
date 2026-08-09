package main

import (
	"io"
	"testing"
	"time"
)

// pacedReader replays a body in chunks, each preceded by a delay. It is how a
// slow start is reproduced without a network: the opening chunk trickles, the
// rest arrives at memory speed.
type pacedReader struct {
	chunks []pacedChunk
	idx    int
	served int
}

type pacedChunk struct {
	delay time.Duration
	size  int
}

func (r *pacedReader) Read(p []byte) (int, error) {
	for r.idx < len(r.chunks) && r.served >= r.chunks[r.idx].size {
		r.idx++
		r.served = 0
	}
	if r.idx >= len(r.chunks) {
		return 0, io.EOF
	}

	chunk := r.chunks[r.idx]
	if r.served == 0 && chunk.delay > 0 {
		time.Sleep(chunk.delay)
	}

	n := chunk.size - r.served
	if n > len(p) {
		n = len(p)
	}
	r.served += n
	return n, nil
}

func TestReadSpeedBodyExcludesRampUp(t *testing.T) {
	const maxBytes = 11 * (512 << 10)

	// The first 512 KB are the warm-up share of the cap and crawl in over
	// 300 ms; the remaining 5 MB arrive at full pace. Charging the crawl to the
	// node would report around 15 MB/s for a link running far above that.
	body := &pacedReader{chunks: []pacedChunk{
		{delay: 300 * time.Millisecond, size: 512 << 10},
		{delay: 20 * time.Millisecond, size: 5 * (512 << 10)},
		{delay: 20 * time.Millisecond, size: 5 * (512 << 10)},
	}}

	sample := readSpeedBody(body, maxBytes, 5*time.Second)

	if sample.Transferred != maxBytes {
		t.Fatalf("expected the whole body to be pulled, got %d bytes", sample.Transferred)
	}
	if !sample.Capped {
		t.Fatal("a run that ended on the byte cap must be reported as capped")
	}
	if sample.Bps < 40<<20 {
		t.Fatalf("ramp-up leaked into the measurement: %d B/s", sample.Bps)
	}
}

func TestReadSpeedBodyStopsOnTheWindow(t *testing.T) {
	const maxBytes = 64 << 20

	chunks := make([]pacedChunk, 0, 64)
	for i := 0; i < 64; i++ {
		chunks = append(chunks, pacedChunk{delay: 10 * time.Millisecond, size: 128 << 10})
	}

	sample := readSpeedBody(&pacedReader{chunks: chunks}, maxBytes, 200*time.Millisecond)

	if sample.Transferred >= maxBytes {
		t.Fatalf("the window should have ended the run well before the cap, got %d bytes", sample.Transferred)
	}
	if sample.Capped {
		t.Fatal("a run cut short by the clock is a real reading, not a floor")
	}
	if sample.Bps <= 0 {
		t.Fatal("expected a throughput reading")
	}
}

func TestReadSpeedBodyTimesShortBodiesWhole(t *testing.T) {
	// Less than the warm-up share arrives, so there is nothing to discard and
	// the whole transfer has to be timed instead of reported as no data.
	body := &pacedReader{chunks: []pacedChunk{{delay: 20 * time.Millisecond, size: 32 << 10}}}

	sample := readSpeedBody(body, 8<<20, time.Second)

	if sample.Transferred != 32<<10 {
		t.Fatalf("expected 32 KB, got %d bytes", sample.Transferred)
	}
	if sample.Capped {
		t.Fatal("a body that never reached the cap must not be marked capped")
	}
	if sample.Bps <= 0 {
		t.Fatal("a short body still has to produce a reading")
	}
}

func TestAggregatorAveragesSpeedSamples(t *testing.T) {
	agg := NewAggregator()
	binding := Binding{NodeID: "node-a", InboundID: "in-1", InboundTag: "tag-1"}

	agg.AddSpeed(binding, SpeedSample{Bps: 1_000_000})
	agg.AddSpeed(binding, SpeedSample{Bps: 3_000_000, Capped: true})

	records, _ := agg.Snapshot("fp")
	if len(records) != 1 {
		t.Fatalf("expected one transport record, got %d", len(records))
	}

	rec := records[0]
	if rec.SpeedBps != 2_000_000 {
		t.Fatalf("the window must carry the mean, got %d", rec.SpeedBps)
	}
	if rec.SpeedBpsMax != 3_000_000 {
		t.Fatalf("the peak must survive alongside the mean, got %d", rec.SpeedBpsMax)
	}
	if rec.SpeedSamples != 2 {
		t.Fatalf("expected 2 samples, got %d", rec.SpeedSamples)
	}
	if !rec.SpeedCapped {
		t.Fatal("a capped sample makes the window value a floor")
	}
}

func TestSpeedStepSpreadsThePeriodOverTheFleet(t *testing.T) {
	rt := &probeRuntime{
		manifest: &Manifest{},
		coreCfg: &CoreConfig{Bindings: []Binding{
			{NodeID: "a", InboundID: "1"},
			{NodeID: "a", InboundID: "2"},
			{NodeID: "b", InboundID: "1"},
			{NodeID: "group", InboundID: "g", IsGroup: true},
		}},
	}

	if step := speedStep(rt); step != 0 {
		t.Fatalf("a disabled speed test must not schedule anything, got %s", step)
	}

	rt.manifest.SpeedTest.Enabled = true
	rt.manifest.SpeedTest.IntervalSec = 3600

	// Three real bindings, the urltest group is measured through its members.
	if step := speedStep(rt); step != 20*time.Minute {
		t.Fatalf("expected a 20m step, got %s", step)
	}

	rt.manifest.SpeedTest.IntervalSec = 60
	if step := speedStep(rt); step != speedMinStep {
		t.Fatalf("the floor must hold back an over-eager period, got %s", step)
	}
}
