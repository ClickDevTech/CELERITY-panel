package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// TargetResult is the reachability of one checklist resource through one node.
type TargetResult struct {
	NodeID     string
	TargetID   string
	At         time.Time
	OK         bool
	Blocked    bool
	HTTPStatus int
	LatencyMs  int
	Err        string
}

// CheckTarget fetches a checklist resource through a node.
//
// The verdict is deliberately separate from transport health: a resource can be
// unreachable while the tunnel is perfectly fine, which means the node exit
// address is geo-blocked or blacklisted rather than the node being down.
func CheckTarget(ctx context.Context, b Binding, target ManifestTarget) TargetResult {
	res := TargetResult{
		NodeID:   b.NodeID,
		TargetID: target.ID,
		At:       time.Now(),
	}

	socksAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(b.SocksPort))
	client := tunnelClient(socksAddr, 20*time.Second, nil)

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.URL, nil)
	if err != nil {
		res.Err = err.Error()
		return res
	}
	// A realistic user agent matters here: some resources answer differently to
	// obviously automated clients, which would make the check lie.
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		// A failed request is not a block: the tunnel itself may be down, and
		// calling that a blocked resource would send the operator hunting for
		// a geo-restriction that does not exist.
		res.Err = truncate(err.Error(), 300)
		res.LatencyMs = int(time.Since(start).Milliseconds())
		return res
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 16*1024))

	res.LatencyMs = int(time.Since(start).Milliseconds())
	res.HTTPStatus = resp.StatusCode

	switch {
	case resp.StatusCode < 400:
		res.OK = true
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnavailableForLegalReasons:
		// The classic signature of a geo-block or an address blacklist.
		res.Blocked = true
		res.Err = fmt.Sprintf("blocked with status %d", resp.StatusCode)
	default:
		// Reachable but unhappy (404, 500, rate limit). Worth recording, not
		// worth calling a block.
		res.Err = fmt.Sprintf("unexpected status %d", resp.StatusCode)
	}

	return res
}
