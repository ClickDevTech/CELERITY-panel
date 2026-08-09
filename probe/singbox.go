package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Binding ties one local SOCKS listener to exactly one node inbound. Pinning a
// listener per outbound is what makes a check attributable: the result cannot
// be blurred by a balancer or a fallback chain.
type Binding struct {
	NodeID     string
	NodeName   string
	InboundID  string
	InboundTag string
	Tag        string
	SocksPort  int
	IsGroup    bool
	Protocol   string
	Host       string
	Port       int
}

// CoreConfig is the rewritten sing-box configuration plus the mapping the
// checks need.
type CoreConfig struct {
	JSON     []byte
	Bindings []Binding
	// TagToNode resolves a subscription outbound tag back to a panel node id,
	// used to name the leaf a urltest group actually selected.
	TagToNode map[string]string
}

type outboundHeader struct {
	Tag  string `json:"tag"`
	Type string `json:"type"`
}

// BuildCoreConfig rewrites a subscription into a probing configuration.
//
// Outbounds are copied verbatim: they are the object under test, and any edit
// (SNI, port, flow, reality keys, obfs) would mean testing something the real
// client never sees. Inbounds and routing are replaced with one local SOCKS
// listener per outbound, wired by a single deterministic rule each.
func BuildCoreConfig(subscription []byte, manifest *Manifest, basePort, clashPort int) (*CoreConfig, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(subscription, &root); err != nil {
		return nil, fmt.Errorf("parse subscription: %w", err)
	}

	rawOutbounds, ok := root["outbounds"]
	if !ok {
		return nil, fmt.Errorf("subscription has no outbounds")
	}

	var outbounds []json.RawMessage
	if err := json.Unmarshal(rawOutbounds, &outbounds); err != nil {
		return nil, fmt.Errorf("parse outbounds: %w", err)
	}

	available := make(map[string]bool, len(outbounds))
	for _, raw := range outbounds {
		var head outboundHeader
		if err := json.Unmarshal(raw, &head); err != nil || head.Tag == "" {
			continue
		}
		available[head.Tag] = true
	}

	bindings := make([]Binding, 0, len(outbounds))
	tagToNode := make(map[string]string, len(outbounds))
	port := basePort

	for _, node := range manifest.Nodes {
		for _, inbound := range node.Inbounds {
			if inbound.ExpectedTag == "" || !available[inbound.ExpectedTag] {
				// The subscription does not publish this inbound for the probe
				// user. Silently skipping keeps a partial fleet checkable.
				continue
			}
			if !node.IsGroup {
				tagToNode[inbound.ExpectedTag] = node.NodeID
			}
			bindings = append(bindings, Binding{
				NodeID:     node.NodeID,
				NodeName:   node.Name,
				InboundID:  inbound.InboundID,
				InboundTag: inbound.InboundTag,
				Tag:        inbound.ExpectedTag,
				SocksPort:  port,
				IsGroup:    node.IsGroup,
				Protocol:   inbound.Protocol,
				Host:       inbound.Host,
				Port:       inbound.Port,
			})
			port++
		}
	}

	if len(bindings) == 0 {
		return nil, fmt.Errorf("no checkable outbounds found in subscription")
	}

	inbounds := make([]map[string]any, 0, len(bindings))
	rules := make([]map[string]any, 0, len(bindings))
	for i, b := range bindings {
		tag := fmt.Sprintf("probe-in-%d", i)
		inbounds = append(inbounds, map[string]any{
			"type":        "socks",
			"tag":         tag,
			"listen":      "127.0.0.1",
			"listen_port": b.SocksPort,
		})
		rules = append(rules, map[string]any{
			"inbound":  []string{tag},
			"outbound": b.Tag,
		})
	}

	// A plain direct outbound as the routing fallback. Every listener has its
	// own rule, so this only ever catches configuration mistakes.
	outbounds = append(outbounds, json.RawMessage(`{"type":"direct","tag":"probe-direct"}`))

	cfg := map[string]any{
		"log": map[string]any{
			"level":     "info",
			"timestamp": true,
		},
		"inbounds":  inbounds,
		"outbounds": outbounds,
		"route": map[string]any{
			"rules": rules,
			"final": "probe-direct",
		},
		"experimental": map[string]any{
			"clash_api": map[string]any{
				"external_controller": fmt.Sprintf("127.0.0.1:%d", clashPort),
			},
		},
	}

	encoded, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, err
	}

	return &CoreConfig{JSON: encoded, Bindings: bindings, TagToNode: tagToNode}, nil
}

// logRing keeps the tail of the core log. Failure classification consults it to
// separate a rejected credential from a broken handshake, which the SOCKS reply
// code alone cannot express.
type logRing struct {
	mu    sync.Mutex
	lines []logLine
	max   int
}

type logLine struct {
	at   time.Time
	text string
}

func newLogRing(max int) *logRing {
	return &logRing{lines: make([]logLine, 0, max), max: max}
}

func (r *logRing) add(text string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.lines) >= r.max {
		copy(r.lines, r.lines[1:])
		r.lines = r.lines[:len(r.lines)-1]
	}
	r.lines = append(r.lines, logLine{at: time.Now(), text: text})
}

// since returns log lines produced after t.
func (r *logRing) since(t time.Time) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, 16)
	for _, l := range r.lines {
		if l.at.After(t) {
			out = append(out, l.text)
		}
	}
	return out
}

// SingboxProcess supervises the core as a child process.
type SingboxProcess struct {
	binary     string
	configPath string
	clashPort  int

	mu     sync.Mutex
	cmd    *exec.Cmd
	exited chan struct{}
	config []byte
	logs   *logRing
}

func NewSingboxProcess(binary, configPath string, clashPort int) *SingboxProcess {
	return &SingboxProcess{
		binary:     binary,
		configPath: configPath,
		clashPort:  clashPort,
		logs:       newLogRing(500),
	}
}

// CoreVersion reports the version string of the installed core.
func (s *SingboxProcess) CoreVersion() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, s.binary, "version").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// "sing-box version 1.11.0"
		if len(fields) >= 3 && fields[0] == "sing-box" && fields[1] == "version" {
			return fields[2]
		}
	}
	return ""
}

// Start writes the config and launches the core, waiting until the Clash API
// answers so callers know routing is actually live.
func (s *SingboxProcess) Start(ctx context.Context, config []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startLocked(ctx, config)
}

func (s *SingboxProcess) startLocked(ctx context.Context, config []byte) error {
	if err := os.MkdirAll(filepath.Dir(s.configPath), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(s.configPath, config, 0o600); err != nil {
		return fmt.Errorf("write core config: %w", err)
	}

	cmd := exec.Command(s.binary, "run", "-c", s.configPath)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start sing-box: %w", err)
	}

	s.cmd = cmd
	s.config = config
	exited := make(chan struct{})
	s.exited = exited

	var streams sync.WaitGroup
	streams.Add(2)
	go func() { defer streams.Done(); s.consume(stderr) }()
	go func() { defer streams.Done(); s.consume(stdout) }()

	// Reaping the child is what makes liveness observable: without Wait the
	// process state is never filled in and a dead core looks alive forever.
	go func() {
		streams.Wait()
		_ = cmd.Wait()
		close(exited)
	}()

	if err := s.waitReady(ctx, 20*time.Second); err != nil {
		s.stopLocked()
		return err
	}
	return nil
}

func (s *SingboxProcess) consume(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		s.logs.add(scanner.Text())
	}
}

func (s *SingboxProcess) waitReady(ctx context.Context, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/version", s.clashPort)

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		resp, err := client.Get(endpoint)
		if err == nil {
			resp.Body.Close()
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("sing-box did not become ready in %s: %s",
		timeout, strings.Join(lastN(s.logs.since(time.Now().Add(-timeout)), 5), " | "))
}

// Running reports whether the child process is still alive.
func (s *SingboxProcess) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.runningLocked()
}

func (s *SingboxProcess) runningLocked() bool {
	if s.cmd == nil || s.exited == nil {
		return false
	}
	select {
	case <-s.exited:
		return false
	default:
		return true
	}
}

// EnsureRunning restarts a core that died on its own. A crashed core would
// otherwise make every node look broken, which is the most misleading failure
// a diagnostic tool can produce.
func (s *SingboxProcess) EnsureRunning(ctx context.Context) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.runningLocked() {
		return false, nil
	}
	if s.config == nil {
		return false, fmt.Errorf("core was never started")
	}

	s.stopLocked()
	if err := s.startLocked(ctx, s.config); err != nil {
		return false, err
	}
	return true, nil
}

func (s *SingboxProcess) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
}

func (s *SingboxProcess) stopLocked() {
	if s.cmd == nil || s.cmd.Process == nil {
		s.cmd = nil
		s.exited = nil
		return
	}

	_ = s.cmd.Process.Kill()
	if s.exited != nil {
		// The reaper goroutine owns Wait; block until it is done so no zombie
		// and no open pipe survives the restart.
		select {
		case <-s.exited:
		case <-time.After(5 * time.Second):
		}
	}
	s.cmd = nil
	s.exited = nil
}

// LogsSince exposes the core log tail for failure classification.
func (s *SingboxProcess) LogsSince(t time.Time) []string {
	return s.logs.since(t)
}

// SelectedProxy asks the Clash API which leaf a group currently uses. Virtual
// nodes are urltest groups, so this is the only way to attribute a group result
// to the node the balancer actually picked.
func (s *SingboxProcess) SelectedProxy(groupTag string) string {
	client := &http.Client{Timeout: 3 * time.Second}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/proxies/%s", s.clashPort, url.PathEscape(groupTag))

	resp, err := client.Get(endpoint)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var payload struct {
		Now string `json:"now"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		return ""
	}
	return payload.Now
}

func lastN(items []string, n int) []string {
	if len(items) <= n {
		return items
	}
	return items[len(items)-n:]
}
