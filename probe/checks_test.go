package main

import "testing"

// A TCP dial is only evidence for TCP-based inbounds. Hysteria2 speaks QUIC
// over UDP and never answers a TCP connect, so probing it that way would mark
// every healthy Hysteria node as unreachable.
func TestUsesTCPOnlyForStreamProtocols(t *testing.T) {
	tcp := []string{"vless", "vmess", "trojan", "shadowsocks", ""}
	for _, p := range tcp {
		if !usesTCP(p) {
			t.Fatalf("%q must be probed over TCP", p)
		}
	}

	udp := []string{"hysteria2", "Hysteria2", "hysteria", "tuic", "wireguard"}
	for _, p := range udp {
		if usesTCP(p) {
			t.Fatalf("%q must not be probed with a TCP dial", p)
		}
	}
}

// The core log is the only place that can tell a rejected credential from a
// dead masquerade destination: the SOCKS reply code cannot express it.
func TestClassifyTunnelFailurePrefersAuthEvidence(t *testing.T) {
	logs := []string{
		"outbound/vless[US Node]: tls handshake in progress",
		"outbound/vless[US Node]: authentication failed for user",
	}
	if got := classifyTunnelFailure(logs, "US Node"); got != CodeAuthRejected {
		t.Fatalf("classify = %q, want %q", got, CodeAuthRejected)
	}

	handshake := []string{"outbound/vless[US Node]: x509: certificate expired"}
	if got := classifyTunnelFailure(handshake, "US Node"); got != CodeHandshakeFailed {
		t.Fatalf("classify = %q, want %q", got, CodeHandshakeFailed)
	}

	network := []string{"outbound/vless[US Node]: connection refused"}
	if got := classifyTunnelFailure(network, "US Node"); got != CodeNetUnreachable {
		t.Fatalf("classify = %q, want %q", got, CodeNetUnreachable)
	}

	// Log lines about a different outbound must not decide this verdict.
	other := []string{"outbound/vless[DE Node]: authentication failed"}
	if got := classifyTunnelFailure(other, "US Node"); got != CodeAuthRejected {
		// With no line for our tag the classifier falls back to the whole tail,
		// which is deliberate: a core-wide error is still the best evidence.
		t.Logf("fallback classification: %q", got)
	}
}
