package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// Version is stamped at build time via -ldflags.
var Version = "dev"

// PanelClient talks to the panel over plain HTTPS with a bearer token. All
// panel traffic goes directly, never through the tunnels under test, so a
// broken node can never prevent the probe from reporting the failure.
type PanelClient struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewPanelClient(baseURL, token string) *PanelClient {
	return &PanelClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// EnrollResponse is the answer to a successful one-time enrollment.
type EnrollResponse struct {
	Token   string `json:"token"`
	ProbeID string `json:"probeId"`
	Name    string `json:"name"`
}

// Enroll exchanges the single-use enrollment token for a permanent one.
func Enroll(ctx context.Context, baseURL, enrollToken string) (*EnrollResponse, error) {
	payload := map[string]string{
		"enrollToken":    enrollToken,
		"version":        Version,
		"os":             runtime.GOOS,
		"arch":           runtime.GOARCH,
		"singboxVersion": "",
	}
	body, _ := json.Marshal(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(baseURL, "/")+"/api/probe/enroll", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+enrollToken)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("enrollment rejected (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	var out EnrollResponse
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parse enrollment response: %w", err)
	}
	if out.Token == "" {
		return nil, fmt.Errorf("panel returned an empty token")
	}
	return &out, nil
}

// Manifest mirrors the payload of GET /api/probe/profile.
type Manifest struct {
	ProbeID         string `json:"probeId"`
	Name            string `json:"name"`
	SubscriptionURL string `json:"subscriptionUrl"`
	IngestURL       string `json:"ingestUrl"`

	Intervals struct {
		TransportSec int `json:"transportSec"`
		TargetsSec   int `json:"targetsSec"`
		ReportSec    int `json:"reportSec"`
	} `json:"intervals"`

	SpeedTest struct {
		Enabled bool `json:"enabled"`
		// IntervalSec is how often one node is measured. The probe divides it
		// by the number of inbounds it watches to get the gap between two
		// individual runs.
		IntervalSec      int   `json:"intervalSec"`
		MaxBytes         int64 `json:"maxBytes"`
		MaxSeconds       int   `json:"maxSeconds"`
		DailyBudgetBytes int64 `json:"dailyBudgetBytes"`
	} `json:"speedTest"`

	Targets []ManifestTarget `json:"targets"`
	Nodes   []ManifestNode   `json:"nodes"`
}

type ManifestTarget struct {
	ID    string `json:"id"`
	URL   string `json:"url"`
	Label string `json:"label"`
}

type ManifestNode struct {
	NodeID      string            `json:"nodeId"`
	Name        string            `json:"name"`
	Type        string            `json:"type"`
	IsGroup     bool              `json:"isGroup"`
	LeafNodeIDs []string          `json:"leafNodeIds"`
	Inbounds    []ManifestInbound `json:"inbounds"`
}

type ManifestInbound struct {
	InboundID  string `json:"inboundId"`
	InboundTag string `json:"inboundTag"`
	Label      string `json:"label"`
	Protocol   string `json:"protocol"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	PortRange  string `json:"portRange"`
	Transport  string `json:"transport"`
	Security   string `json:"security"`
	// ExpectedTag is the sing-box outbound tag the subscription will carry for
	// this inbound. The panel computes it with the very same code that renders
	// the subscription, which makes the mapping exact rather than heuristic.
	ExpectedTag string `json:"expectedTag"`
}

// FetchManifest pulls the current checking plan from the panel.
func (c *PanelClient) FetchManifest(ctx context.Context) (*Manifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/probe/profile", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("profile request failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse manifest: %w", err)
	}
	return &m, nil
}

// FetchSubscription downloads the sing-box config of the hidden probe user.
// The outbounds inside are the object under test and are never modified.
func (c *PanelClient) FetchSubscription(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// Ask as a sing-box client would, so the panel serves the right format.
	req.Header.Set("User-Agent", "sing-box celerity-probe/"+Version)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("subscription request failed (%d)", resp.StatusCode)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return nil, fmt.Errorf("subscription is empty")
	}
	return data, nil
}

// ShipResult reports the outcome of one delivery attempt.
type ShipResult struct {
	StatusCode int
	Duplicate  bool
	Retryable  bool
}

// Ship pushes a gzipped NDJSON batch. The batch id is the digest of the body,
// which lets the panel deduplicate redeliveries of at-least-once shipping.
func (c *PanelClient) Ship(ctx context.Context, ingestURL string, ndjson []byte) (*ShipResult, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(ndjson); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	body := buf.Bytes()

	sum := sha256.Sum256(body)
	batchID := hex.EncodeToString(sum[:])

	url := ingestURL
	if url == "" {
		url = c.baseURL + "/api/probe/ingest"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/x-ndjson")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("X-Batch-Id", batchID)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))

	res := &ShipResult{StatusCode: resp.StatusCode}
	switch {
	case resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusOK:
		return res, nil

	// 401 and 403 describe the state of the panel, not of the batch: the
	// feature can be switched back on and a token can be re-issued, so the
	// measurements must survive until then.
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		res.Retryable = true
		return res, fmt.Errorf("panel refuses probe reports for now (%d)", resp.StatusCode)

	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		res.Retryable = true
		return res, fmt.Errorf("ingest deferred (%d)", resp.StatusCode)

	default:
		// A malformed or oversized batch is the only thing the panel will
		// never accept, no matter how many times it is offered.
		return res, fmt.Errorf("ingest rejected (%d)", resp.StatusCode)
	}
}
