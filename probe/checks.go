package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Failure taxonomy. The code is the actual product of a check: it points at a
// single cause and therefore at a single action, which a latency number never
// does.
const (
	CodeOK              = ""
	CodeNetUnreachable  = "net_unreachable"
	CodeHandshakeFailed = "handshake_failed"
	CodeAuthRejected    = "auth_rejected"
	CodeTunnelNoData    = "tunnel_no_data"
	CodeDegraded        = "degraded"
	CodeTargetBlocked   = "target_blocked"
	// The local core is down. Kept apart from every node-facing code because
	// it is a fault of the probe host, not evidence about any node.
	CodeCoreDown = "core_down"
)

// Connectivity probe used for transport checks: a tiny, cache-free, globally
// available endpoint that answers 204 with an empty body.
const connectivityURL = "https://www.gstatic.com/generate_204"

// Above this round-trip a working tunnel is still reported as usable, but
// flagged degraded so the UI can separate "broken" from "painful".
const degradedThresholdMs = 2000

// CheckResult is a single measurement of one node inbound.
type CheckResult struct {
	Binding     Binding
	At          time.Time
	OK          bool
	Code        string
	LatencyMs   int
	HandshakeMs int
	TTFBMs      int
	ExitIP      string
	SelectedTag string
	Err         string
}

// socksDial opens a tunnelled TCP connection through the local SOCKS listener
// that is pinned to one outbound.
func socksDial(ctx context.Context, socksAddr, targetAddr string) (net.Conn, error) {
	host, portStr, err := net.SplitHostPort(targetAddr)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, err
	}

	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", socksAddr)
	if err != nil {
		return nil, fmt.Errorf("core listener unreachable: %w", err)
	}

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	// Greeting: SOCKS5, one method, no authentication.
	if _, err := conn.Write([]byte{0x05, 0x01, 0x00}); err != nil {
		conn.Close()
		return nil, err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(conn, reply); err != nil {
		conn.Close()
		return nil, err
	}
	if reply[0] != 0x05 || reply[1] != 0x00 {
		conn.Close()
		return nil, fmt.Errorf("socks handshake refused")
	}

	// CONNECT with a domain address, so name resolution happens at the exit.
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(host))}
	req = append(req, host...)
	portBytes := make([]byte, 2)
	binary.BigEndian.PutUint16(portBytes, uint16(port))
	req = append(req, portBytes...)

	if _, err := conn.Write(req); err != nil {
		conn.Close()
		return nil, err
	}

	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		conn.Close()
		return nil, &socksError{code: 0xFF, cause: err}
	}
	if head[1] != 0x00 {
		conn.Close()
		return nil, &socksError{code: head[1]}
	}

	// Drain the bound address so the stream is positioned at the payload.
	switch head[3] {
	case 0x01:
		_, err = io.ReadFull(conn, make([]byte, 4+2))
	case 0x03:
		lenBuf := make([]byte, 1)
		if _, err = io.ReadFull(conn, lenBuf); err == nil {
			_, err = io.ReadFull(conn, make([]byte, int(lenBuf[0])+2))
		}
	case 0x04:
		_, err = io.ReadFull(conn, make([]byte, 16+2))
	default:
		err = fmt.Errorf("unknown socks address type %d", head[3])
	}
	if err != nil {
		conn.Close()
		return nil, err
	}

	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

type socksError struct {
	code  byte
	cause error
}

func (e *socksError) Error() string {
	if e.cause != nil {
		return fmt.Sprintf("socks connect failed: %v", e.cause)
	}
	return fmt.Sprintf("socks connect rejected with code 0x%02x", e.code)
}

// tunnelClient builds an HTTP client whose every connection goes through one
// pinned SOCKS listener, recording how long the tunnel setup took.
//
// The handshake duration is published atomically: the transport may still be
// dialling in its own goroutine when a timeout returns control to the caller.
func tunnelClient(socksAddr string, timeout time.Duration, handshake *atomic.Int64) *http.Client {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			start := time.Now()
			conn, err := socksDial(ctx, socksAddr, addr)
			if handshake != nil {
				handshake.Store(int64(time.Since(start)))
			}
			return conn, err
		},
		DisableKeepAlives:     true,
		TLSHandshakeTimeout:   timeout,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

// usesTCP reports whether a node inbound can be probed with a plain TCP dial.
// Hysteria2 speaks QUIC over UDP and never answers a TCP connect, so dialling
// it that way would report every healthy Hysteria node as unreachable.
func usesTCP(protocol string) bool {
	switch strings.ToLower(protocol) {
	case "hysteria2", "hysteria", "tuic", "wireguard", "quic":
		return false
	default:
		return true
	}
}

// directReachable answers whether the node endpoint accepts TCP at all. This
// runs outside the tunnel on purpose: it is what separates "the address or port
// is filtered / the node is down" from "the tunnel itself is broken".
func directReachable(ctx context.Context, host string, port int) bool {
	if host == "" || port <= 0 {
		return true
	}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var d net.Dialer
	conn, err := d.DialContext(dialCtx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// classifyTunnelFailure refines a failed tunnel setup using the core log tail.
// A SOCKS reply code cannot tell a rejected credential from a dead masquerade
// destination, but the core says so explicitly in its log.
func classifyTunnelFailure(logs []string, tag string) string {
	authMarkers := []string{
		"authentication failed", "auth failed", "unauthorized",
		"invalid user", "user not found", "invalid password",
		"authentication error", "auth error",
	}
	handshakeMarkers := []string{
		"tls", "handshake", "reality", "certificate", "x509",
		"unsupported protocol", "bad record", "alert",
	}
	networkMarkers := []string{
		"connection refused", "network is unreachable", "no route to host",
		"i/o timeout", "timeout", "connect failed",
	}

	relevant := make([]string, 0, len(logs))
	for _, line := range logs {
		lower := strings.ToLower(line)
		if tag == "" || strings.Contains(lower, strings.ToLower(tag)) {
			relevant = append(relevant, lower)
		}
	}
	if len(relevant) == 0 {
		for _, line := range logs {
			relevant = append(relevant, strings.ToLower(line))
		}
	}

	// Authentication is checked first: it is the most specific signal and it
	// always means a sync problem rather than a network one.
	for _, line := range relevant {
		for _, marker := range authMarkers {
			if strings.Contains(line, marker) {
				return CodeAuthRejected
			}
		}
	}
	for _, line := range relevant {
		for _, marker := range handshakeMarkers {
			if strings.Contains(line, marker) {
				return CodeHandshakeFailed
			}
		}
	}
	for _, line := range relevant {
		for _, marker := range networkMarkers {
			if strings.Contains(line, marker) {
				return CodeNetUnreachable
			}
		}
	}

	// Nothing conclusive: the tunnel refused to carry traffic, which is still
	// actionable as a handshake-stage failure.
	return CodeHandshakeFailed
}

// CheckTransport runs one full transport check for a binding.
func CheckTransport(ctx context.Context, core *SingboxProcess, b Binding, wantExitIP bool) CheckResult {
	res := CheckResult{Binding: b, At: time.Now()}
	logsFrom := time.Now()

	// Direct reachability first, but only where a TCP dial is meaningful. A
	// group has no single endpoint, so it is only judged through the tunnel.
	if !b.IsGroup && usesTCP(b.Protocol) && !directReachable(ctx, b.Host, b.Port) {
		res.Code = CodeNetUnreachable
		res.Err = fmt.Sprintf("tcp %s:%d refused or filtered", b.Host, b.Port)
		return res
	}

	socksAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(b.SocksPort))
	var handshake atomic.Int64
	client := tunnelClient(socksAddr, 15*time.Second, &handshake)

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, connectivityURL, nil)
	if err != nil {
		res.Code = CodeTunnelNoData
		res.Err = err.Error()
		return res
	}

	resp, err := client.Do(req)
	res.HandshakeMs = int(time.Duration(handshake.Load()).Milliseconds())

	if err != nil {
		logs := core.LogsSince(logsFrom)
		message := err.Error()

		switch {
		// The local listener is gone, which says nothing about the node: the
		// core itself is broken and every other verdict would be a guess.
		case strings.Contains(message, "core listener unreachable"):
			res.Code = CodeCoreDown
		// A refused SOCKS CONNECT means the core could not build the tunnel.
		case strings.Contains(message, "socks connect"):
			res.Code = classifyTunnelFailure(logs, b.Tag)
		// Anything after a successful CONNECT means the tunnel stands but does
		// not carry data.
		default:
			res.Code = CodeTunnelNoData
		}
		res.Err = truncate(message, 300)
		return res
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 8*1024))

	res.TTFBMs = int(time.Since(start).Milliseconds())
	res.LatencyMs = res.TTFBMs

	if resp.StatusCode >= 400 {
		res.Code = CodeTunnelNoData
		res.Err = fmt.Sprintf("unexpected status %d", resp.StatusCode)
		return res
	}

	res.OK = true
	if res.LatencyMs > degradedThresholdMs {
		res.Code = CodeDegraded
	}

	if b.IsGroup {
		res.SelectedTag = core.SelectedProxy(b.Tag)
	}
	if wantExitIP {
		res.ExitIP = lookupExitIP(ctx, socksAddr)
	}

	return res
}

// lookupExitIP asks a plain-text echo service for the address traffic leaves
// from. It is cheap but not free, so callers run it on the slow cadence only.
func lookupExitIP(ctx context.Context, socksAddr string) string {
	client := tunnelClient(socksAddr, 10*time.Second, nil)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ipify.org", nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return ""
	}
	ip := strings.TrimSpace(string(body))
	if net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
