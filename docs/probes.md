# 📡 External Diagnostic Probes

> Read this in [Russian](probes.ru.md).

A probe is a small Go binary you install on **your own** server. It gets a hidden subscription from the panel, starts the same core the Click Connect clients run, connects to your nodes exactly like a customer would and reports the result.

---

## 📖 Why This Exists

The panel sees its own control plane: whether a node agent is alive, whether the process is running and how much traffic was accounted. A node can look healthy there while:

- the port is filtered by a specific carrier,
- the REALITY masquerade destination is dead, so the TLS handshake never completes,
- the user was never pushed to the running Xray instance, so credentials are refused,
- the tunnel is established but no data flows because of a broken outbound or an ACL rule,
- the exit IP landed on a blacklist, so a specific resource is blocked.

A probe walks the client path end to end and names which of these happened.

---

## 🧭 How It Works

```
┌──────────────────────┐                              ┌──────────────────────┐
│        PROBE         │    1. enroll (one-time)      │        PANEL         │
│     your server      │ ───────────────────────────▶ │                      │
│                      │                              │                      │
│  ┌────────────────┐  │    2. profile + hidden sub   │                      │
│  │    sing-box    │  │ ◀─────────────────────────── │                      │
│  └───────┬────────┘  │                              │                      │
│          │           │    4. gzipped NDJSON         │                      │
│          │           │ ───────────────────────────▶ │                      │
└──────────┼───────────┘                              └──────────────────────┘
           │
           │  3. real connections — one SOCKS port per checked inbound
           ▼
┌────────────────────────────────────────────────────────────────────────────┐
│   node A        node B        node C        virtual node (urltest group)   │
└────────────────────────────────────────────────────────────────────────────┘
```

1. **Enrollment.** The panel issues a single-use token valid for 24 hours. The probe exchanges it once for a permanent token; only SHA-256 hashes are stored for verification.
2. **Profile.** The probe asks what to check: nodes, inbounds, the resource checklist, cadence and the speed-test budget.
3. **Subscription.** Every probe owns a hidden user with its own subscription. That user is excluded from all listings and statistics, so probe traffic never shows up as customer traffic.
4. **Checks.** One local SOCKS listener is opened per checked inbound, so every measurement is pinned to exactly one node inbound.
5. **Reporting.** Results are aggregated locally into windows and shipped gzipped. Undelivered batches are spooled on disk, so a panel outage costs no measurements.

The panel never connects to a probe: everything is initiated by the probe, so it works behind NAT and on residential links.

---

## 🚀 Installation

Enable the feature first: **Settings → Probes → Enable external probes**. While it is off, the panel refuses enrollment and reports.

Then **Probes → Add probe**, give it a name that describes the vantage point (`Moscow, MTS` is useful; `probe-1` is not), and run the generated command on the host you want to check from.

**Linux / macOS:**

```bash
curl -fsSL https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download/celerity-probe-install.sh \
  | sudo PANEL_URL='https://panel.example.com' ENROLL_TOKEN='<token>' sh
```

**Windows (elevated PowerShell):**

```powershell
$env:PANEL_URL='https://panel.example.com'; $env:ENROLL_TOKEN='<token>'
irm https://github.com/ClickDevTech/CELERITY-panel/releases/latest/download/celerity-probe-install.ps1 | iex
```

The installer downloads the probe and a core, enrolls once, and registers a service (systemd, launchd or a Windows service). The enrollment token is passed through the environment, never on the command line, because the process table is readable by other local users.

The core is [sing-box-lx](https://github.com/Leadaxe/sing-box-lx) — the same build the Click Connect apps use. It is upstream sing-box plus the transports the panel can publish; upstream refuses an entire configuration that contains an XHTTP node, so a probe on upstream would go blind on every node at once. An install that finds an upstream core in place replaces it, and the probe writes a warning to its log if the core it starts lacks `with_xhttp` while the fleet has XHTTP nodes. Set `CORE_REPO` before running the installer to pull the core from somewhere else.


| Platform | Service                                                             | Data directory                  |
| -------- | ------------------------------------------------------------------- | ------------------------------- |
| Linux    | systemd, runs as the `celerity-probe` account                       | `/var/lib/celerity-probe`       |
| macOS    | launchd                                                             | `/usr/local/var/celerity-probe` |
| Windows  | Windows service, directory ACL limited to SYSTEM and Administrators | `%ProgramData%\celerity-probe`  |


`PANEL_URL` must use HTTPS. The probe token authenticates every request and the reports describe your whole fleet, so plain HTTP is refused unless the panel is on loopback or you set `PROBE_ALLOW_INSECURE=1` for a lab setup.

---

## ⚙️ Settings


| Setting                   | Default | What it controls                                                    |
| ------------------------- | ------- | ------------------------------------------------------------------- |
| Connection check interval | 300 s   | How often every node inbound is dialled                             |
| Resource check interval   | 3600 s  | How often the checklist is fetched through every node               |
| Report interval           | 900 s   | How often windows are shipped to the panel                          |
| Retention                 | 30 days | Raw windows; hourly rollups are kept three times longer             |
| Probe traffic limit       | 5 GB    | Cap on the hidden user, applied to existing probes too              |
| Speed test                | off     | Bounded by 20 MB and 5 s per run, and 1 GB per day across all nodes |
| Resource checklist        | empty   | One `id` + `url` pair per row, checked through every node           |


Speed measurement burns real traffic on your own nodes, so it is bounded three ways, and its daily budget is spent round-robin across nodes.

**Scale note.** The number of stored series is *probes × nodes × resources*. The panel warns when that product grows past a few thousand; at that point lengthen the intervals.

---

## 🔍 Reading the Results

Results are always presented **per vantage point**, and probe verdicts never change `node.status`. A failed check can also come from the probe's own uplink; telling the two apart needs a quorum of probes on different networks.

Failure codes map directly to an action:


| Code               | What it means                            | Where to look                                               |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| `net_unreachable`  | TCP/UDP never arrives                    | Port filtered by the carrier, firewall, or the node is down |
| `handshake_failed` | TLS/REALITY does not complete            | Dead masquerade destination, wrong SNI, DPI interference    |
| `auth_rejected`    | Tunnel stands, credentials refused       | User not pushed to the running core — a sync problem        |
| `tunnel_no_data`   | Authenticated, but nothing flows         | Broken outbound or an ACL rule                              |
| `degraded`         | Works, but slowly                        | Overload, or a bad route to this vantage point              |
| `core_down`        | The probe's own sing-box was not running | The fault is on the probe host                              |


Resource results are kept separate: a blocked resource points to a geo-block or a blacklisted exit address. Only 403 and 451 count as a block; a 500 or a transport error is recorded as a failed check.

Two warnings worth acting on:

- **Same host.** If a probe's egress IP matches one of your nodes, its traffic to that node never leaves the machine. The UI flags this.
- **Virtual nodes.** A virtual node is a `urltest` group. Both the group and its leaves are checked, and the group result records which leaf the balancer actually picked.

---

## 🪝 Alerts

Webhooks fire on state transitions, so an alert arrives without waiting for the rollup:


| Event                      | Fired when                                                       |
| -------------------------- | ---------------------------------------------------------------- |
| `probe.node_unreachable`   | A node inbound moved into a failed state from this vantage point |
| `probe.target_unreachable` | A checklist resource became unreachable through a node           |
| `probe.offline`            | A probe missed three report intervals                            |


A local core failure (`core_down`) never raises a node alert.

---

## 🤖 AI Assistant

The `query_probes` MCP tool exposes the same data to an AI client. It requires its own `probes:read` scope, because probe data reveals vantage points and egress addresses. See the [MCP guide](mcp-user-guide.md).

---

## 🔐 Security Model

- A probe holds **client credentials only**. It has no rights on any node, no SSH access and no panel session.
- Tokens are verified against SHA-256 hashes and compared in constant time. The permanent token is additionally stored encrypted so the panel can re-display an install command.
- Deleting a probe removes its hidden user, its subscription and its results immediately, and pushes the removal to the running Xray instances. There is no IP or ASN pinning, so revocation speed is what bounds the lifetime of leaked credentials.
- The traffic cap on the hidden user is the second bound: a leaked probe subscription is limited to that amount of traffic.
- Ingest is idempotent. A redelivered batch is acknowledged without being stored twice, which makes at-least-once shipping safe.

---

## 🧯 Troubleshooting


| Symptom                                             | Likely cause                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Probe stays "awaiting installation"                 | The enrollment token expired (24 h) or was already used — reissue it from the panel       |
| Every node reports `core_down`                      | sing-box is missing or not executable on the probe host; check the service log            |
| Every node reports `auth_rejected`                  | The probe user did not reach the nodes — run a sync and check the node status             |
| One node reports `net_unreachable`, others are fine | Port filtered on the path from this vantage point                                         |
| No data after install                               | The feature is disabled in settings, or the probe cannot reach `PANEL_URL` over HTTPS     |


Logs: `sudo journalctl -u celerity-probe -f` (Linux — without root the journal shows nothing), `tail -f /usr/local/var/celerity-probe/probe.log` (macOS), the service log in the data directory (Windows).

---

## 📚 Sources


| File                         | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `probe/`                     | The probe itself (separate Go module)            |
| `src/routes/probe.js`        | Enroll, profile and ingest endpoints             |
| `src/services/probes/`       | Enrollment, manifest, ingest and rollup services |
| `src/routes/panel/probes.js` | Admin UI and JSON API                            |
| `src/mcp/tools/probes.js`    | `query_probes` MCP tool                          |


