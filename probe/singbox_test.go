package main

import (
	"encoding/json"
	"testing"
)

// The rewrite must not touch outbounds: they are the object under test, and any
// edit would mean measuring something the real client never sees.
func TestBuildCoreConfigPreservesOutbounds(t *testing.T) {
	subscription := []byte(`{
        "inbounds": [{"type": "tun", "tag": "tun-in"}],
        "outbounds": [
            {"type": "vless", "tag": "US Node", "server": "1.2.3.4", "server_port": 443,
             "uuid": "abc", "flow": "xtls-rprx-vision",
             "tls": {"enabled": true, "server_name": "www.microsoft.com",
                     "reality": {"enabled": true, "public_key": "key", "short_id": "aa"}}},
            {"type": "hysteria2", "tag": "DE Node Main", "server": "5.6.7.8", "server_port": 8443},
            {"type": "direct", "tag": "direct"}
        ],
        "route": {"rules": [{"outbound": "US Node"}], "final": "direct"}
    }`)

	manifest := &Manifest{
		Nodes: []ManifestNode{
			{
				NodeID: "node-us",
				Name:   "US",
				Type:   "xray",
				Inbounds: []ManifestInbound{
					{InboundID: "main", InboundTag: "vless-in", ExpectedTag: "US Node", Host: "1.2.3.4", Port: 443},
				},
			},
			{
				NodeID: "node-de",
				Name:   "DE",
				Type:   "hysteria",
				Inbounds: []ManifestInbound{
					{InboundID: "hysteria", ExpectedTag: "DE Node Main", Host: "5.6.7.8", Port: 8443},
				},
			},
		},
	}

	core, err := BuildCoreConfig(subscription, manifest, 24000, 29090)
	if err != nil {
		t.Fatalf("BuildCoreConfig failed: %v", err)
	}

	if len(core.Bindings) != 2 {
		t.Fatalf("expected 2 bindings, got %d", len(core.Bindings))
	}
	if core.Bindings[0].SocksPort != 24000 || core.Bindings[1].SocksPort != 24001 {
		t.Fatalf("listeners must be allocated sequentially, got %d and %d",
			core.Bindings[0].SocksPort, core.Bindings[1].SocksPort)
	}

	var rewritten struct {
		Inbounds  []map[string]any `json:"inbounds"`
		Outbounds []map[string]any `json:"outbounds"`
		Route     map[string]any   `json:"route"`
		Experim   map[string]any   `json:"experimental"`
	}
	if err := json.Unmarshal(core.JSON, &rewritten); err != nil {
		t.Fatalf("rewritten config is not valid JSON: %v", err)
	}

	// The original subscription inbound must be gone, replaced by one SOCKS
	// listener per checked outbound.
	if len(rewritten.Inbounds) != 2 {
		t.Fatalf("expected 2 socks inbounds, got %d", len(rewritten.Inbounds))
	}
	for _, in := range rewritten.Inbounds {
		if in["type"] != "socks" {
			t.Fatalf("expected socks inbound, got %v", in["type"])
		}
	}

	// Every original outbound survives verbatim.
	var vless map[string]any
	for _, out := range rewritten.Outbounds {
		if out["tag"] == "US Node" {
			vless = out
		}
	}
	if vless == nil {
		t.Fatal("vless outbound was dropped")
	}
	if vless["flow"] != "xtls-rprx-vision" {
		t.Fatalf("flow was modified: %v", vless["flow"])
	}
	tls, _ := vless["tls"].(map[string]any)
	if tls == nil || tls["server_name"] != "www.microsoft.com" {
		t.Fatalf("tls settings were modified: %v", vless["tls"])
	}

	rules, _ := rewritten.Route["rules"].([]any)
	if len(rules) != 2 {
		t.Fatalf("expected one routing rule per listener, got %d", len(rules))
	}
	if rewritten.Experim["clash_api"] == nil {
		t.Fatal("clash api must be enabled for group attribution")
	}
	if core.TagToNode["US Node"] != "node-us" {
		t.Fatalf("tag to node mapping is wrong: %v", core.TagToNode)
	}
}

// An inbound the subscription does not publish is skipped rather than failing
// the whole run, so a partially provisioned fleet stays checkable.
func TestBuildCoreConfigSkipsMissingTags(t *testing.T) {
	subscription := []byte(`{"outbounds": [{"type": "vless", "tag": "Known"}]}`)

	manifest := &Manifest{
		Nodes: []ManifestNode{
			{
				NodeID: "a",
				Inbounds: []ManifestInbound{
					{InboundID: "main", ExpectedTag: "Known"},
					{InboundID: "extra-1", ExpectedTag: "Not published"},
				},
			},
		},
	}

	core, err := BuildCoreConfig(subscription, manifest, 24000, 29090)
	if err != nil {
		t.Fatalf("BuildCoreConfig failed: %v", err)
	}
	if len(core.Bindings) != 1 || core.Bindings[0].InboundID != "main" {
		t.Fatalf("expected only the published inbound, got %+v", core.Bindings)
	}
}

func TestBuildCoreConfigRejectsEmptySubscription(t *testing.T) {
	if _, err := BuildCoreConfig([]byte(`{"outbounds": []}`), &Manifest{}, 24000, 29090); err == nil {
		t.Fatal("expected an error when nothing is checkable")
	}
}

// Virtual nodes are urltest groups: the group itself must be checkable, and its
// result is attributed to whichever leaf the balancer picked.
func TestBuildCoreConfigHandlesGroups(t *testing.T) {
	subscription := []byte(`{"outbounds": [
        {"type": "vless", "tag": "Leaf"},
        {"type": "urltest", "tag": "Virtual", "outbounds": ["Leaf"]}
    ]}`)

	manifest := &Manifest{
		Nodes: []ManifestNode{
			{NodeID: "leaf", Inbounds: []ManifestInbound{{InboundID: "main", ExpectedTag: "Leaf"}}},
			{
				NodeID:      "virt",
				IsGroup:     true,
				LeafNodeIDs: []string{"leaf"},
				Inbounds:    []ManifestInbound{{InboundID: "group", ExpectedTag: "Virtual"}},
			},
		},
	}

	core, err := BuildCoreConfig(subscription, manifest, 24000, 29090)
	if err != nil {
		t.Fatalf("BuildCoreConfig failed: %v", err)
	}

	var groupBinding *Binding
	for i := range core.Bindings {
		if core.Bindings[i].IsGroup {
			groupBinding = &core.Bindings[i]
		}
	}
	if groupBinding == nil {
		t.Fatal("group binding is missing")
	}
	// A group has no single endpoint, so it must not claim a tag mapping.
	if _, exists := core.TagToNode["Virtual"]; exists {
		t.Fatal("a group tag must not map to a node id")
	}
}
