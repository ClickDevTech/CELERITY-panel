// celerity-probe is an external diagnostic agent for a CELERITY panel.
//
// It holds no privileges on nodes: it enrolls once, pulls the subscription of a
// hidden probe user, and then behaves like a real client, dialling every node
// inbound through a real sing-box core and reporting the outcome.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

func main() {
	var (
		dataDir     = flag.String("dir", "", "data directory (defaults to a per-platform location)")
		panelURL    = flag.String("panel", "", "panel base URL, used for enrollment")
		enrollToken = flag.String("enroll", "", "one-time enrollment token")
		singboxPath = flag.String("singbox", "", "path to the sing-box binary")
		verbose     = flag.Bool("verbose", false, "verbose logging")
		showVersion = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("celerity-probe %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
		return
	}

	setVerbose(*verbose)

	cfg, err := LoadConfig(*dataDir)
	if err != nil {
		logError("configuration error: %v", err)
		os.Exit(1)
	}
	if *panelURL != "" {
		cfg.PanelURL = *panelURL
	}
	if *singboxPath != "" {
		cfg.SingboxPath = *singboxPath
	}
	if *verbose {
		cfg.Verbose = true
	}
	setVerbose(cfg.Verbose)

	// The enrollment token is also accepted through the environment so an
	// installer never has to put a live credential on the command line, where
	// any local user could read it from the process table.
	token := *enrollToken
	if token == "" {
		token = os.Getenv("ENROLL_TOKEN")
	}
	if token != "" {
		if err := runEnrollment(cfg, token); err != nil {
			logError("enrollment failed: %v", err)
			os.Exit(1)
		}
		return
	}

	if err := cfg.Validate(); err != nil {
		logError("%v", err)
		logError("run with -panel <url> -enroll <token> first")
		os.Exit(1)
	}

	if err := run(cfg); err != nil {
		logError("probe stopped: %v", err)
		os.Exit(1)
	}
}

// runEnrollment exchanges the one-time token and persists the permanent one.
func runEnrollment(cfg *Config, enrollToken string) error {
	if cfg.PanelURL == "" {
		return fmt.Errorf("panel URL is required for enrollment")
	}
	if err := checkPanelScheme(cfg.PanelURL); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	resp, err := Enroll(ctx, cfg.PanelURL, enrollToken)
	if err != nil {
		return err
	}

	cfg.Token = resp.Token
	if err := cfg.Save(); err != nil {
		return fmt.Errorf("save config: %w", err)
	}

	logInfo("enrolled as %q, configuration stored in %s", resp.Name, cfg.DataDir)
	return nil
}

// probeRuntime holds everything that is rebuilt when the manifest changes.
type probeRuntime struct {
	manifest *Manifest
	core     *SingboxProcess
	coreCfg  *CoreConfig
}

func run(cfg *Config) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		logInfo("shutting down")
		cancel()
	}()

	client := NewPanelClient(cfg.PanelURL, cfg.Token)
	aggregator := NewAggregator()
	shipper := NewShipper(cfg.DataDir, client)
	budget := LoadSpeedBudget(cfg.DataDir)

	identity := DetectNetIdentity(ctx)
	logInfo("vantage point: ip=%s country=%s asn=%s", identity.EgressIP, identity.Country, identity.ASN)

	rt, err := startRuntimeWithRetry(ctx, cfg, client)
	if err != nil {
		return err
	}
	// The runtime is replaced when the fleet changes, so the current core has
	// to be resolved at shutdown time rather than captured here.
	defer func() { rt.core.Stop() }()

	shipper.SetIngestURL(rt.manifest.IngestURL)

	transportEvery := interval(rt.manifest.Intervals.TransportSec, 300)
	targetsEvery := interval(rt.manifest.Intervals.TargetsSec, 3600)
	reportEvery := interval(rt.manifest.Intervals.ReportSec, 900)

	transportTicker := time.NewTicker(transportEvery)
	targetsTicker := time.NewTicker(targetsEvery)
	reportTicker := time.NewTicker(reportEvery)
	// Settings edited in the panel reach a probe only through this poll, so it
	// runs far more often than the checks themselves: the profile is a small
	// document, and an operator who changed a setting expects it to take hold.
	manifestTicker := time.NewTicker(manifestPollEvery)
	defer transportTicker.Stop()
	defer targetsTicker.Stop()
	defer reportTicker.Stop()
	defer manifestTicker.Stop()

	// First pass immediately, so a fresh install produces data at once instead
	// of staying blank for a whole interval.
	runTransportPass(ctx, rt, aggregator, false)

	for {
		select {
		case <-ctx.Done():
			flushAndShip(context.Background(), aggregator, shipper, rt, identity)
			return nil

		case <-transportTicker.C:
			ensureCore(ctx, rt)
			runTransportPass(ctx, rt, aggregator, false)

		case <-targetsTicker.C:
			ensureCore(ctx, rt)
			// The slow pass also refreshes exit addresses and spends the speed
			// budget: all the expensive work happens on one cadence.
			runTransportPass(ctx, rt, aggregator, true)
			runTargetPass(ctx, rt, aggregator)
			runSpeedPass(ctx, rt, aggregator, budget)

		case <-reportTicker.C:
			flushAndShip(ctx, aggregator, shipper, rt, identity)

		case <-manifestTicker.C:
			identity = DetectNetIdentity(ctx)
			next, err := reloadRuntime(ctx, cfg, client, rt)
			if err != nil {
				logWarn("manifest refresh failed: %v", err)
				break
			}
			rt = next
			shipper.SetIngestURL(rt.manifest.IngestURL)

			// A ticker keeps the period it was created with, so cadence edits
			// in the panel would otherwise wait for a restart of the service.
			if d := interval(rt.manifest.Intervals.TransportSec, 300); d != transportEvery {
				transportEvery = d
				transportTicker.Reset(d)
				logInfo("connection checks now run every %s", d)
			}
			if d := interval(rt.manifest.Intervals.TargetsSec, 3600); d != targetsEvery {
				targetsEvery = d
				targetsTicker.Reset(d)
				logInfo("resource checks now run every %s", d)
			}
			if d := interval(rt.manifest.Intervals.ReportSec, 900); d != reportEvery {
				reportEvery = d
				reportTicker.Reset(d)
				logInfo("reports now ship every %s", d)
			}
		}
	}
}

// How often the checking plan is re-fetched from the panel.
const manifestPollEvery = 5 * time.Minute

func interval(seconds, fallback int) time.Duration {
	if seconds <= 0 {
		seconds = fallback
	}
	return time.Duration(seconds) * time.Second
}

// ensureCore brings the core back after a crash. Checks running against a dead
// core would report the whole fleet as broken, so this runs before every pass.
func ensureCore(ctx context.Context, rt *probeRuntime) {
	restarted, err := rt.core.EnsureRunning(ctx)
	if err != nil {
		logError("core is down and could not be restarted: %v", err)
		return
	}
	if restarted {
		logWarn("core had exited, restarted before the next pass")
	}
}

// startRuntimeWithRetry keeps trying until the panel answers. A brief panel
// outage must not turn into a restart loop that produces no measurements at
// all, since the probe can keep its findings on disk meanwhile.
func startRuntimeWithRetry(ctx context.Context, cfg *Config, client *PanelClient) (*probeRuntime, error) {
	delay := 15 * time.Second
	for attempt := 1; ; attempt++ {
		rt, err := startRuntime(ctx, cfg, client)
		if err == nil {
			return rt, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}

		logWarn("startup attempt %d failed: %v, retrying in %s", attempt, err, delay)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}

		delay *= 2
		if delay > 10*time.Minute {
			delay = 10 * time.Minute
		}
	}
}

// startRuntime fetches the plan, rewrites the subscription and starts the core.
func startRuntime(ctx context.Context, cfg *Config, client *PanelClient) (*probeRuntime, error) {
	manifest, err := client.FetchManifest(ctx)
	if err != nil {
		return nil, fmt.Errorf("fetch manifest: %w", err)
	}
	if manifest.SubscriptionURL == "" {
		return nil, fmt.Errorf("panel did not provide a subscription URL")
	}

	subscription, err := client.FetchSubscription(ctx, manifest.SubscriptionURL)
	if err != nil {
		return nil, fmt.Errorf("fetch subscription: %w", err)
	}

	coreCfg, err := BuildCoreConfig(subscription, manifest, cfg.SocksBasePort, cfg.ClashAPIPort)
	if err != nil {
		return nil, err
	}

	core := NewSingboxProcess(cfg.SingboxPath, filepath.Join(cfg.DataDir, "core.json"), cfg.ClashAPIPort)
	reportCore(core, cfg, manifest)
	if err := core.Start(ctx, coreCfg.JSON); err != nil {
		return nil, fmt.Errorf("start core: %w", err)
	}

	logInfo("core started, checking %d inbounds across %d nodes",
		len(coreCfg.Bindings), len(manifest.Nodes))

	return &probeRuntime{manifest: manifest, core: core, coreCfg: coreCfg}, nil
}

// reportCore states which core is installed and warns when it cannot dial the
// whole fleet. The probe is only worth its results while it runs the same core
// as the clients: sing-box-lx, built with `with_xhttp`. Upstream sing-box
// rejects an entire configuration that contains an XHTTP node, so a mismatch
// has to be named before it turns into an unexplained startup failure.
func reportCore(core *SingboxProcess, cfg *Config, manifest *Manifest) {
	info := core.CoreInfo()
	if info.Version == "" {
		logWarn("core at %s did not answer 'version': check that the file exists and is executable", cfg.SingboxPath)
		return
	}
	logInfo("core %s at %s", info.Version, cfg.SingboxPath)

	if !info.HasTag("with_clash_api") {
		logWarn("core is built without with_clash_api: the probe cannot tell which node a balancer selected")
	}
	if fleetUsesXhttp(manifest) && !info.HasTag("with_xhttp") {
		logWarn("fleet contains XHTTP nodes and this core lacks with_xhttp: install sing-box-lx, or the core will refuse the configuration")
	}
}

func fleetUsesXhttp(manifest *Manifest) bool {
	for _, node := range manifest.Nodes {
		for _, inbound := range node.Inbounds {
			if inbound.Transport == "xhttp" {
				return true
			}
		}
	}
	return false
}

// reloadRuntime returns the current plan, restarting the core only when the
// fleet changed, so a stable fleet never sees a gap in coverage.
func reloadRuntime(ctx context.Context, cfg *Config, client *PanelClient, current *probeRuntime) (*probeRuntime, error) {
	manifest, err := client.FetchManifest(ctx)
	if err != nil {
		return nil, err
	}

	subscription, err := client.FetchSubscription(ctx, manifest.SubscriptionURL)
	if err != nil {
		return nil, err
	}

	coreCfg, err := BuildCoreConfig(subscription, manifest, cfg.SocksBasePort, cfg.ClashAPIPort)
	if err != nil {
		return nil, err
	}

	// The core only encodes the fleet, so an unchanged config still leaves the
	// checklist, the speed budget and the intervals to pick up. Keep the running
	// core and swap the plan around it.
	if string(coreCfg.JSON) == string(current.coreCfg.JSON) && current.core.Running() {
		logDebug("fleet unchanged, keeping the running core")
		return &probeRuntime{manifest: manifest, core: current.core, coreCfg: current.coreCfg}, nil
	}

	current.core.Stop()

	core := NewSingboxProcess(cfg.SingboxPath, filepath.Join(cfg.DataDir, "core.json"), cfg.ClashAPIPort)
	if err := core.Start(ctx, coreCfg.JSON); err != nil {
		return nil, fmt.Errorf("restart core: %w", err)
	}

	logInfo("core reloaded, checking %d inbounds", len(coreCfg.Bindings))
	return &probeRuntime{manifest: manifest, core: core, coreCfg: coreCfg}, nil
}

func runTransportPass(ctx context.Context, rt *probeRuntime, agg *Aggregator, wantExitIP bool) {
	for _, binding := range rt.coreCfg.Bindings {
		select {
		case <-ctx.Done():
			return
		default:
		}

		res := CheckTransport(ctx, rt.core, binding, wantExitIP)

		if !res.OK {
			logWarn("%s/%s: %s (%s)", binding.NodeName, binding.InboundID, res.Code, res.Err)

			// Confirm a first failure quickly instead of waiting a full
			// interval: a single lost packet should not look like an outage.
			// The confirmation replaces the first verdict rather than adding a
			// second attempt, otherwise every failure would halve the reported
			// success rate.
			time.Sleep(2 * time.Second)
			res = CheckTransport(ctx, rt.core, binding, false)
		} else {
			logDebug("%s/%s: ok in %dms", binding.NodeName, binding.InboundID, res.LatencyMs)
		}

		agg.AddTransport(res, rt.coreCfg.TagToNode)
	}
}

func runTargetPass(ctx context.Context, rt *probeRuntime, agg *Aggregator) {
	if len(rt.manifest.Targets) == 0 {
		return
	}

	// One binding per node is enough: the checklist measures what the node exit
	// address can reach, which does not depend on the inbound used to get there.
	seen := make(map[string]bool, len(rt.coreCfg.Bindings))
	for _, binding := range rt.coreCfg.Bindings {
		if binding.IsGroup || seen[binding.NodeID] {
			continue
		}
		seen[binding.NodeID] = true

		for _, target := range rt.manifest.Targets {
			select {
			case <-ctx.Done():
				return
			default:
			}
			agg.AddTarget(CheckTarget(ctx, binding, target))
		}
	}
}

func runSpeedPass(ctx context.Context, rt *probeRuntime, agg *Aggregator, budget *SpeedBudget) {
	settings := rt.manifest.SpeedTest
	if !settings.Enabled {
		return
	}
	if !budget.Allow(settings.MaxBytes, settings.DailyBudgetBytes) {
		logDebug("speed test skipped: daily budget exhausted")
		return
	}

	candidates := make([]Binding, 0, len(rt.coreCfg.Bindings))
	for _, b := range rt.coreCfg.Bindings {
		if !b.IsGroup {
			candidates = append(candidates, b)
		}
	}
	idx := budget.NextBinding(len(candidates))
	if idx < 0 {
		return
	}
	binding := candidates[idx]

	bps, transferred, err := MeasureSpeed(ctx, binding, settings.MaxBytes, settings.MaxSeconds)
	budget.Spend(transferred)
	if err != nil {
		logDebug("speed test on %s failed: %v", binding.NodeName, err)
		return
	}

	agg.AddSpeed(binding, bps)
	logInfo("speed on %s: %.2f Mbit/s", binding.NodeName, float64(bps*8)/1e6)
}

// flushAndShip folds the window, appends the self-report and hands the batch to
// the shipper. Enqueueing to disk happens before any network attempt, so a
// failed delivery never loses measurements. The window is only cleared once the
// batch is safely on disk, so a spool failure keeps the data for the next try.
func flushAndShip(ctx context.Context, agg *Aggregator, shipper *Shipper, rt *probeRuntime, identity NetIdentity) {
	records, commit := agg.Snapshot(identity.Fingerprint)
	if len(records) == 0 {
		return
	}

	records = append(records, Record{
		Kind:           "meta",
		Version:        Version,
		SingboxVersion: rt.core.CoreVersion(),
		OS:             runtime.GOOS,
		Arch:           runtime.GOARCH,
		EgressIP:       identity.EgressIP,
		ASN:            identity.ASN,
		Country:        identity.Country,
		NetFingerprint: identity.Fingerprint,
	})

	payload, err := EncodeNDJSON(records)
	if err != nil {
		logError("encode batch: %v", err)
		return
	}
	if err := shipper.Enqueue(payload); err != nil {
		logError("spool batch: %v", err)
		return
	}

	commit()
	shipper.Drain(ctx)
}
