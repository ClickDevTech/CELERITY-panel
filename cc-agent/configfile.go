package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// ConfigPersister keeps the on-disk Xray config.json in sync with the agent's
// authoritative user list (UserStore). Live user changes are applied to the
// running Xray over gRPC; this persister mirrors them into config.json so that
// any Xray restart (systemd/crash/OOM) reloads the correct user set instead of
// a stale snapshot. It only ever rewrites the settings.clients arrays of the
// inbounds the agent manages (cfg.Inbounds); every other part of the config
// (routing, outbounds, tls, stream, cascade inbounds) is preserved verbatim.
type ConfigPersister struct {
	path     string
	inbounds []InboundEntry
	store    *UserStore

	mu       sync.Mutex
	dirty    chan struct{}
	done     chan struct{}
	debounce time.Duration
}

func NewConfigPersister(path string, inbounds []InboundEntry, store *UserStore) *ConfigPersister {
	return &ConfigPersister{
		path:     path,
		inbounds: inbounds,
		store:    store,
		dirty:    make(chan struct{}, 1),
		done:     make(chan struct{}),
		debounce: 1 * time.Second,
	}
}

// MarkDirty schedules a debounced flush. Non-blocking and safe to call from any
// request handler; bursts coalesce into a single write.
func (p *ConfigPersister) MarkDirty() {
	select {
	case p.dirty <- struct{}{}:
	default:
	}
}

// run is the debounce loop: it flushes the config ~debounce after the last
// change, bounding writes to at most one per debounce interval regardless of
// churn. Stop() ends the loop.
func (p *ConfigPersister) run() {
	var timer *time.Timer
	var timerC <-chan time.Time
	for {
		select {
		case <-p.done:
			if timer != nil {
				timer.Stop()
			}
			return
		case <-p.dirty:
			if timer == nil {
				timer = time.NewTimer(p.debounce)
				timerC = timer.C
			} else {
				timer.Stop()
				timer.Reset(p.debounce)
			}
		case <-timerC:
			timer = nil
			timerC = nil
			if _, err := p.Flush(); err != nil {
				log.Printf("[config] Flush failed: %v", err)
			}
		}
	}
}

// Stop terminates the debounce loop. Callers should perform a final synchronous
// Flush afterwards to capture any pending change.
func (p *ConfigPersister) Stop() {
	close(p.done)
}

// Flush reads the on-disk config, replaces the clients of every managed inbound
// with the current user list, and atomically writes the file back. It returns
// changed=true only when the managed client sets actually differed (so callers
// can decide whether a one-shot xray restart is warranted). A missing config or
// missing inbounds array is treated as a no-op (not an error).
func (p *ConfigPersister) Flush() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	data, err := os.ReadFile(p.path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read %s: %w", p.path, err)
	}

	var root map[string]any
	if err := json.Unmarshal(data, &root); err != nil {
		// A hand-edited config with comments/trailing commas lands here. Keep the
		// existing file untouched; the live gRPC state is unaffected.
		return false, fmt.Errorf("parse %s: %w", p.path, err)
	}

	inboundsAny, ok := root["inbounds"].([]any)
	if !ok {
		return false, nil
	}

	managed := make(map[string]string, len(p.inbounds))
	for _, ib := range p.inbounds {
		managed[ib.Tag] = ib.Flow
	}

	users := p.store.List()

	changed := false
	for _, ibAny := range inboundsAny {
		ib, ok := ibAny.(map[string]any)
		if !ok {
			continue
		}
		tag, _ := ib["tag"].(string)
		flow, isManaged := managed[tag]
		if !isManaged {
			continue
		}

		desired := buildConfigClients(users, flow)

		settings, ok := ib["settings"].(map[string]any)
		if !ok {
			settings = map[string]any{}
			ib["settings"] = settings
		}
		existing, _ := settings["clients"].([]any)
		if clientsEqual(existing, desired) {
			continue
		}
		settings["clients"] = desired
		changed = true
	}

	if !changed {
		return false, nil
	}

	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal %s: %w", p.path, err)
	}

	if err := atomicWriteFile(p.path, out); err != nil {
		return false, err
	}
	log.Printf("[config] Rewrote %s (%d users)", p.path, len(users))
	return true, nil
}

// buildConfigClients renders the VLESS clients array. Flow is added only when
// non-empty, matching the panel's configGenerator.buildXrayClients output and
// the gRPC AddUser path (which sends per-inbound flow).
func buildConfigClients(users []*User, flow string) []any {
	clients := make([]any, 0, len(users))
	for _, u := range users {
		c := map[string]any{
			"id":    u.ID,
			"email": u.Email,
			"level": 0,
		}
		if flow != "" {
			c["flow"] = flow
		}
		clients = append(clients, c)
	}
	return clients
}

// clientsEqual compares two clients arrays as sets of (id, email, flow),
// ignoring order and the always-zero level. This avoids false "changed"
// verdicts from JSON number typing (float64) or key ordering.
func clientsEqual(existing, desired []any) bool {
	if len(existing) != len(desired) {
		return false
	}
	set := make(map[string]struct{}, len(existing))
	for _, c := range existing {
		m, ok := c.(map[string]any)
		if !ok {
			return false
		}
		set[clientKey(m)] = struct{}{}
	}
	for _, c := range desired {
		m, ok := c.(map[string]any)
		if !ok {
			return false
		}
		if _, ok := set[clientKey(m)]; !ok {
			return false
		}
	}
	return true
}

func clientKey(m map[string]any) string {
	id, _ := m["id"].(string)
	email, _ := m["email"].(string)
	flow, _ := m["flow"].(string)
	return id + "\x00" + email + "\x00" + flow
}

// targetFileAttrs returns the mode and ownership a rewritten file must keep.
// Xray runs unprivileged and reads config.json through its group, so an
// existing file keeps its own mode/owner; a missing one gets 0640 and the
// group of its directory. -1 leaves the uid/gid unchanged in os.Chown.
func targetFileAttrs(path string) (os.FileMode, int, int) {
	if fi, err := os.Stat(path); err == nil {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			return fi.Mode().Perm(), int(st.Uid), int(st.Gid)
		}
		return fi.Mode().Perm(), -1, -1
	}
	if di, err := os.Stat(filepath.Dir(path)); err == nil {
		if st, ok := di.Sys().(*syscall.Stat_t); ok {
			return 0640, -1, int(st.Gid)
		}
	}
	return 0640, -1, -1
}

// atomicWriteFile writes data to a temp file in the same directory, fsyncs it,
// then renames it over the target so a crash/power loss never leaves a partial
// config.json.
func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".xray-config-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed away

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	mode, uid, gid := targetFileAttrs(path)
	if err := os.Chown(tmpName, uid, gid); err != nil {
		return fmt.Errorf("chown temp: %w", err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return fmt.Errorf("chmod temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename temp -> %s: %w", path, err)
	}
	return nil
}
