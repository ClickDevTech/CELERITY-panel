package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

// NetIdentity describes where the probe is observing from. Measurements taken
// from different uplinks are not comparable, so every report carries the
// fingerprint of the environment it was produced in.
type NetIdentity struct {
	EgressIP    string
	Country     string
	ASN         string
	Fingerprint string
}

// DetectNetIdentity resolves the vantage point over a direct connection. It
// never goes through a tunnel: the point is to describe the probe uplink
// itself, not the exit of some node.
func DetectNetIdentity(ctx context.Context) NetIdentity {
	id := NetIdentity{}

	if ip, country := cloudflareTrace(ctx); ip != "" {
		id.EgressIP = ip
		id.Country = country
	}
	if asn, country := lookupASN(ctx); asn != "" {
		id.ASN = asn
		if id.Country == "" {
			id.Country = country
		}
	}

	id.Fingerprint = fingerprint(id.EgressIP, id.ASN)
	return id
}

// cloudflareTrace is a plain-text endpoint available over TLS everywhere, which
// makes it a reliable source for the observed address and country.
func cloudflareTrace(ctx context.Context) (string, string) {
	client := &http.Client{Timeout: 10 * time.Second}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.cloudflare.com/cdn-cgi/trace", nil)
	if err != nil {
		return "", ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", ""
	}

	var ip, loc string
	for _, line := range strings.Split(string(body), "\n") {
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		switch key {
		case "ip":
			ip = value
		case "loc":
			loc = value
		}
	}
	return ip, loc
}

// lookupASN is best effort: knowing the autonomous system helps explain why two
// probes disagree, but the probe stays fully functional without it.
func lookupASN(ctx context.Context) (string, string) {
	client := &http.Client{Timeout: 8 * time.Second}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://ipapi.co/json/", nil)
	if err != nil {
		return "", ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", ""
	}
	defer resp.Body.Close()

	var payload struct {
		ASN     string `json:"asn"`
		Org     string `json:"org"`
		Country string `json:"country_code"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&payload); err != nil {
		return "", ""
	}

	asn := payload.ASN
	if asn != "" && payload.Org != "" {
		asn = asn + " " + payload.Org
	}
	return truncate(asn, 64), payload.Country
}

// fingerprint hashes the stable parts of the network environment. Local
// addresses are included so switching between Wi-Fi and a mobile uplink changes
// the fingerprint even when the public address happens to stay the same.
func fingerprint(egressIP, asn string) string {
	parts := localAddresses()
	if egressIP != "" {
		parts = append(parts, "egress:"+egressIP)
	}
	if asn != "" {
		parts = append(parts, "asn:"+asn)
	}
	sort.Strings(parts)

	sum := sha256.Sum256([]byte(strings.Join(parts, "|")))
	return hex.EncodeToString(sum[:8])
}

func localAddresses() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	out := make([]string, 0, 8)
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, iface.Name+":"+ipNet.IP.String())
		}
	}
	return out
}
