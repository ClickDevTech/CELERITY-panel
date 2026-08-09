package main

import (
	"encoding/json"
	"sort"
	"sync"
	"time"
)

// Local aggregation is what keeps the panel cheap. A probe checking 20 inbounds
// every 5 minutes produces thousands of raw samples per hour; folding them into
// one window per inbound per report turns that into tens of documents.

// FailureCodes mirrors the fixed taxonomy stored by the panel.
type FailureCodes struct {
	NetUnreachable  int `json:"netUnreachable"`
	HandshakeFailed int `json:"handshakeFailed"`
	AuthRejected    int `json:"authRejected"`
	TunnelNoData    int `json:"tunnelNoData"`
	Degraded        int `json:"degraded"`
	CoreDown        int `json:"coreDown"`
}

func (c *FailureCodes) add(code string) {
	switch code {
	case CodeNetUnreachable:
		c.NetUnreachable++
	case CodeHandshakeFailed:
		c.HandshakeFailed++
	case CodeAuthRejected:
		c.AuthRejected++
	case CodeTunnelNoData:
		c.TunnelNoData++
	case CodeDegraded:
		c.Degraded++
	case CodeCoreDown:
		c.CoreDown++
	}
}

// dominant returns the code that best describes the window.
func (c FailureCodes) dominant() string {
	type pair struct {
		code  string
		count int
	}
	// Ordered by how actionable the cause is, so a tie resolves to the most
	// specific explanation rather than an arbitrary one. A dead local core
	// comes first: while it is down, nothing else in the window is evidence
	// about the node.
	candidates := []pair{
		{CodeCoreDown, c.CoreDown},
		{CodeAuthRejected, c.AuthRejected},
		{CodeHandshakeFailed, c.HandshakeFailed},
		{CodeNetUnreachable, c.NetUnreachable},
		{CodeTunnelNoData, c.TunnelNoData},
		{CodeDegraded, c.Degraded},
	}
	best := ""
	bestCount := 0
	for _, p := range candidates {
		if p.count > bestCount {
			best, bestCount = p.code, p.count
		}
	}
	return best
}

type transportWindow struct {
	nodeID     string
	inboundID  string
	inboundTag string

	attempts   int
	ok         int
	codes      FailureCodes
	latencies  []int
	handshakes []int
	ttfbs      []int

	speedSum     int64
	speedMax     int64
	speedSamples int
	speedCapped  int

	exitIP         string
	selectedNodeID string
}

func (w *transportWindow) meanSpeed() int64 {
	if w.speedSamples == 0 {
		return 0
	}
	return w.speedSum / int64(w.speedSamples)
}

type targetWindow struct {
	nodeID   string
	targetID string

	attempts   int
	ok         int
	blocked    int
	httpStatus int
	latencies  []int
	lastError  string
}

// Record is one NDJSON line shipped to the panel.
type Record struct {
	Kind string `json:"kind"`
	TS   string `json:"ts,omitempty"`

	NodeID         string `json:"nodeId,omitempty"`
	InboundID      string `json:"inboundId,omitempty"`
	InboundTag     string `json:"inboundTag,omitempty"`
	SelectedNodeID string `json:"selectedNodeId,omitempty"`
	TargetID       string `json:"targetId,omitempty"`

	NetFingerprint string `json:"netFingerprint,omitempty"`

	Attempts int           `json:"attempts,omitempty"`
	OK       int           `json:"ok"`
	Blocked  int           `json:"blocked,omitempty"`
	Codes    *FailureCodes `json:"codes,omitempty"`

	LatencyP50  int `json:"latencyP50,omitempty"`
	LatencyP95  int `json:"latencyP95,omitempty"`
	HandshakeMs int `json:"handshakeMs,omitempty"`
	TTFBMs      int `json:"ttfbMs,omitempty"`
	LatencyMs   int `json:"latencyMs,omitempty"`
	HTTPStatus  int `json:"httpStatus,omitempty"`

	// SpeedBps is the mean over the samples taken in this window, SpeedBpsMax
	// the best one. The mean is what a reader should judge the node by; the max
	// only says what the link reached at its luckiest moment.
	SpeedBps     int64 `json:"speedBps,omitempty"`
	SpeedBpsMax  int64 `json:"speedBpsMax,omitempty"`
	SpeedSamples int   `json:"speedSamples,omitempty"`
	SpeedCapped  bool  `json:"speedCapped,omitempty"`

	ExitIP    string `json:"exitIp,omitempty"`
	LastCode  string `json:"lastCode,omitempty"`
	LastError string `json:"lastError,omitempty"`

	// Event fields.
	Event   string `json:"event,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`

	// Meta fields.
	Version        string `json:"version,omitempty"`
	SingboxVersion string `json:"singboxVersion,omitempty"`
	OS             string `json:"os,omitempty"`
	Arch           string `json:"arch,omitempty"`
	EgressIP       string `json:"egressIp,omitempty"`
	ASN            string `json:"asn,omitempty"`
	Country        string `json:"country,omitempty"`
}

// Aggregator folds individual checks into per-inbound windows and emits state
// transitions immediately so alerting does not wait for the window to close.
type Aggregator struct {
	mu sync.Mutex

	transport map[string]*transportWindow
	targets   map[string]*targetWindow
	events    []Record

	// Last known health per inbound, used to detect transitions.
	lastState map[string]string
}

func NewAggregator() *Aggregator {
	return &Aggregator{
		transport: make(map[string]*transportWindow),
		targets:   make(map[string]*targetWindow),
		lastState: make(map[string]string),
	}
}

func (a *Aggregator) AddTransport(res CheckResult, tagToNode map[string]string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	key := res.Binding.NodeID + "|" + res.Binding.InboundID
	w, ok := a.transport[key]
	if !ok {
		w = &transportWindow{
			nodeID:     res.Binding.NodeID,
			inboundID:  res.Binding.InboundID,
			inboundTag: res.Binding.InboundTag,
		}
		a.transport[key] = w
	}

	w.attempts++
	if res.OK {
		w.ok++
		w.latencies = append(w.latencies, res.LatencyMs)
		w.ttfbs = append(w.ttfbs, res.TTFBMs)
	}
	if res.HandshakeMs > 0 {
		w.handshakes = append(w.handshakes, res.HandshakeMs)
	}
	if res.Code != CodeOK {
		w.codes.add(res.Code)
	}
	if res.ExitIP != "" {
		w.exitIP = res.ExitIP
	}
	if res.SelectedTag != "" {
		if nodeID, found := tagToNode[res.SelectedTag]; found {
			w.selectedNodeID = nodeID
		}
	}

	a.noteTransition(key, res)
}

// noteTransition records an alertable change of health for one inbound.
func (a *Aggregator) noteTransition(key string, res CheckResult) {
	previous := a.lastState[key]

	current := "ok"
	if !res.OK {
		current = res.Code
	}
	a.lastState[key] = current

	// A local core failure says nothing about the node, so it must never raise
	// a node alert.
	if current == CodeCoreDown {
		return
	}

	// Transitions into a failed state are what deserve an alert. An unknown
	// previous state counts too: a node already broken when the probe started
	// would otherwise stay silent forever.
	if current != "ok" && previous != current {
		a.events = append(a.events, Record{
			Kind:      "event",
			Event:     "node_unreachable",
			TS:        res.At.UTC().Format(time.RFC3339),
			NodeID:    res.Binding.NodeID,
			InboundID: res.Binding.InboundID,
			Code:      res.Code,
			Message:   res.Err,
		})
	}
}

func (a *Aggregator) AddTarget(res TargetResult) {
	a.mu.Lock()
	defer a.mu.Unlock()

	key := res.NodeID + "|" + res.TargetID
	w, ok := a.targets[key]
	if !ok {
		w = &targetWindow{nodeID: res.NodeID, targetID: res.TargetID}
		a.targets[key] = w
	}

	w.attempts++
	if res.OK {
		w.ok++
	}
	if res.Blocked {
		w.blocked++
		w.lastError = res.Err
	}
	if res.HTTPStatus > 0 {
		w.httpStatus = res.HTTPStatus
	}
	if res.LatencyMs > 0 {
		w.latencies = append(w.latencies, res.LatencyMs)
	}

	stateKey := "target|" + key
	previous := a.lastState[stateKey]
	current := "ok"
	if !res.OK {
		current = CodeTargetBlocked
	}
	a.lastState[stateKey] = current

	if current != "ok" && previous != current {
		a.events = append(a.events, Record{
			Kind:       "event",
			Event:      "target_unreachable",
			TS:         res.At.UTC().Format(time.RFC3339),
			NodeID:     res.NodeID,
			TargetID:   res.TargetID,
			HTTPStatus: res.HTTPStatus,
			Message:    res.Err,
		})
	}
}

// AddSpeed attaches a throughput sample to the current window of a binding.
func (a *Aggregator) AddSpeed(b Binding, s SpeedSample) {
	a.mu.Lock()
	defer a.mu.Unlock()

	key := b.NodeID + "|" + b.InboundID
	w, ok := a.transport[key]
	if !ok {
		w = &transportWindow{nodeID: b.NodeID, inboundID: b.InboundID, inboundTag: b.InboundTag}
		a.transport[key] = w
	}
	w.speedSum += s.Bps
	w.speedSamples++
	if s.Bps > w.speedMax {
		w.speedMax = s.Bps
	}
	if s.Capped {
		w.speedCapped++
	}
}

// Snapshot turns the accumulated windows into records and returns a commit
// function that clears them. Clearing is deferred until the caller has the
// batch safely on disk: a failed spool write must not silently drop a window.
//
// Timestamps are the moment of the snapshot and are preserved through spooling,
// so an offline probe can deliver old windows later without distorting history.
func (a *Aggregator) Snapshot(netFingerprint string) ([]Record, func()) {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339)
	records := make([]Record, 0, len(a.transport)+len(a.targets)+len(a.events))

	for _, w := range a.transport {
		codes := w.codes
		records = append(records, Record{
			Kind:           "transport",
			TS:             now,
			NodeID:         w.nodeID,
			InboundID:      w.inboundID,
			InboundTag:     w.inboundTag,
			SelectedNodeID: w.selectedNodeID,
			NetFingerprint: netFingerprint,
			Attempts:       w.attempts,
			OK:             w.ok,
			Codes:          &codes,
			LatencyP50:     percentile(w.latencies, 50),
			LatencyP95:     percentile(w.latencies, 95),
			HandshakeMs:    percentile(w.handshakes, 50),
			TTFBMs:         percentile(w.ttfbs, 50),
			SpeedBps:       w.meanSpeed(),
			SpeedBpsMax:    w.speedMax,
			SpeedSamples:   w.speedSamples,
			SpeedCapped:    w.speedCapped > 0,
			ExitIP:         w.exitIP,
			LastCode:       codes.dominant(),
		})
	}

	for _, w := range a.targets {
		records = append(records, Record{
			Kind:           "target",
			TS:             now,
			NodeID:         w.nodeID,
			TargetID:       w.targetID,
			NetFingerprint: netFingerprint,
			Attempts:       w.attempts,
			OK:             w.ok,
			Blocked:        w.blocked,
			HTTPStatus:     w.httpStatus,
			LatencyMs:      percentile(w.latencies, 50),
			LastError:      w.lastError,
		})
	}

	records = append(records, a.events...)

	transport := a.transport
	targets := a.targets
	events := a.events

	commit := func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		// Only drop what was actually handed out: anything measured while the
		// batch was being written stays in the window.
		for key, w := range a.transport {
			if transport[key] == w {
				delete(a.transport, key)
			}
		}
		for key, w := range a.targets {
			if targets[key] == w {
				delete(a.targets, key)
			}
		}
		a.events = a.events[min(len(events), len(a.events)):]
	}

	return records, commit
}

// percentile returns the p-th percentile using nearest-rank: the value at rank
// ceil(p/100 * N), which needs no interpolation and behaves sensibly on the
// small samples a window holds.
func percentile(values []int, p int) int {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)

	rank := (p*len(sorted) + 99) / 100
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// EncodeNDJSON renders records as newline-delimited JSON.
func EncodeNDJSON(records []Record) ([]byte, error) {
	var out []byte
	for _, rec := range records {
		line, err := json.Marshal(rec)
		if err != nil {
			return nil, err
		}
		out = append(out, line...)
		out = append(out, '\n')
	}
	return out, nil
}
