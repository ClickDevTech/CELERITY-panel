package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Config is the small amount of local state a probe needs. Everything else
// (what to check, how often, budgets) comes from the panel manifest, so an
// operator never edits this file after installation.
type Config struct {
	PanelURL string `json:"panelUrl"`
	Token    string `json:"token"`

	// Absolute path of the sing-box binary. The probe manages it as a child
	// process instead of linking the core in: that keeps the probe a single
	// dependency-free binary and lets the operator upgrade the core alone.
	SingboxPath string `json:"singboxPath"`

	DataDir string `json:"-"`

	// Local listener range. One SOCKS inbound is opened per checked outbound,
	// which is how a check is pinned to exactly one node inbound.
	SocksBasePort int `json:"socksBasePort"`
	ClashAPIPort  int `json:"clashApiPort"`

	Verbose bool `json:"verbose"`
}

const (
	defaultSocksBasePort = 24000
	defaultClashAPIPort  = 29090
	configFileName       = "config.json"
)

// defaultDataDir picks a per-platform writable location. Linux installs run as
// a service under /var/lib, desktop platforms keep everything next to the user
// profile so no elevation is required.
func defaultDataDir() string {
	if env := os.Getenv("CELERITY_PROBE_DIR"); env != "" {
		return env
	}
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = os.Getenv("APPDATA")
		}
		return filepath.Join(base, "CelerityProbe")
	case "darwin":
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, "Library", "Application Support", "CelerityProbe")
		}
		return "/usr/local/var/celerity-probe"
	default:
		return "/var/lib/celerity-probe"
	}
}

// LoadConfig reads the config file, applying environment overrides. A missing
// file is not an error: the probe may be running its first enrollment.
func LoadConfig(dataDir string) (*Config, error) {
	if dataDir == "" {
		dataDir = defaultDataDir()
	}

	cfg := &Config{
		DataDir:       dataDir,
		SocksBasePort: defaultSocksBasePort,
		ClashAPIPort:  defaultClashAPIPort,
	}

	data, err := os.ReadFile(filepath.Join(dataDir, configFileName))
	if err == nil {
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parse config: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("read config: %w", err)
	}

	cfg.DataDir = dataDir
	applyEnvOverrides(cfg)
	cfg.applyDefaults()

	return cfg, nil
}

func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("PANEL_URL"); v != "" {
		cfg.PanelURL = v
	}
	if v := os.Getenv("PROBE_TOKEN"); v != "" {
		cfg.Token = v
	}
	if v := os.Getenv("SINGBOX_PATH"); v != "" {
		cfg.SingboxPath = v
	}
	if v := os.Getenv("SOCKS_BASE_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.SocksBasePort = n
		}
	}
	if v := os.Getenv("CLASH_API_PORT"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.ClashAPIPort = n
		}
	}
	if v := os.Getenv("PROBE_VERBOSE"); v == "1" || v == "true" {
		cfg.Verbose = true
	}
}

func (c *Config) applyDefaults() {
	c.PanelURL = strings.TrimRight(strings.TrimSpace(c.PanelURL), "/")
	if c.SocksBasePort <= 0 {
		c.SocksBasePort = defaultSocksBasePort
	}
	if c.ClashAPIPort <= 0 {
		c.ClashAPIPort = defaultClashAPIPort
	}
	if c.SingboxPath == "" {
		c.SingboxPath = defaultSingboxPath(c.DataDir)
	}
}

func defaultSingboxPath(dataDir string) string {
	name := "sing-box"
	if runtime.GOOS == "windows" {
		name = "sing-box.exe"
	}
	// Prefer the copy shipped next to the probe, fall back to PATH resolution
	// done later by exec.LookPath.
	local := filepath.Join(dataDir, name)
	if _, err := os.Stat(local); err == nil {
		return local
	}
	return name
}

// Save persists the config with owner-only permissions: it holds the probe
// token, which is a bearer credential for the panel.
func (c *Config) Save() error {
	if err := os.MkdirAll(c.DataDir, 0o700); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(c.DataDir, configFileName)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (c *Config) Validate() error {
	if c.PanelURL == "" {
		return errors.New("panel URL is not set")
	}
	if err := checkPanelScheme(c.PanelURL); err != nil {
		return err
	}
	if c.Token == "" {
		return errors.New("probe is not enrolled yet")
	}
	return nil
}

// checkPanelScheme refuses plain HTTP. The probe token authenticates every
// request and the reports describe the whole fleet, so an unencrypted panel URL
// hands both to anyone on the path. Loopback is exempt because nothing leaves
// the host, and an explicit environment override exists for lab setups.
func checkPanelScheme(panelURL string) error {
	lower := strings.ToLower(panelURL)
	switch {
	case strings.HasPrefix(lower, "https://"):
		return nil
	case strings.HasPrefix(lower, "http://127.0.0.1"),
		strings.HasPrefix(lower, "http://localhost"),
		strings.HasPrefix(lower, "http://[::1]"):
		return nil
	case os.Getenv("PROBE_ALLOW_INSECURE") == "1":
		return nil
	default:
		return errors.New("panel URL must use https (set PROBE_ALLOW_INSECURE=1 to override)")
	}
}
