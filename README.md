# C³ CELERITY

⚡ **Fast. Simple. Long-lasting.**

**[English](README.md)** | [Русский](README.ru.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/clickdevtech/hysteria-panel)](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[![Docker Image Size](https://img.shields.io/docker/image-size/clickdevtech/hysteria-panel/latest)](https://hub.docker.com/r/clickdevtech/hysteria-panel)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](package.json)
[![Hysteria](https://img.shields.io/badge/Hysteria-2.x-9B59B6)](https://v2.hysteria.network/)
[![Xray](https://img.shields.io/badge/Xray-VLESS-00ADD8)](https://xtls.github.io/)
[![Telegram](https://img.shields.io/badge/Telegram-Chat-2CA5E0?logo=telegram&logoColor=white)](https://t.me/+JKFdEr7TqvIyOTFi)
[![Support](https://img.shields.io/badge/%E2%99%A5-Support-EC4899)](https://celerity.help)

**C³ CELERITY** by Click Connect — modern web panel for managing [Hysteria 2](https://v2.hysteria.network/) and [Xray VLESS](https://xtls.github.io/) proxy servers with centralized authentication, one-click node setup, and flexible user-to-server group mapping.

**Built for performance:** Lightweight architecture designed for speed at any scale.

<p align="center">
  <img src="docs/dashboard.png" alt="C³ CELERITY Dashboard" width="800">
  <br>
  <em>Dashboard — real-time server monitoring and statistics</em>
</p>

## ⚡ Quick Start

> Updating an existing installation? See [Safe Production Updates](docs/safe-update.md).

**1. Install Docker** (if not installed):
```bash
curl -fsSL https://get.docker.com | sh
```

**2. Deploy panel (Docker Hub - recommended):**
```bash
mkdir hysteria-panel && cd hysteria-panel

# Download required files
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker-compose.hub.yml
curl -O https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/docker.env.example

# Create Greenlock SSL config (required for HTTPS)
mkdir -p greenlock.d
curl -o greenlock.d/config.json https://raw.githubusercontent.com/ClickDevTech/hysteria-panel/main/greenlock.d/config.json

cp docker.env.example .env
nano .env  # Set your domain, email, and secrets
docker compose -f docker-compose.hub.yml up -d
```

**Alternative: Build from source** (for development or customization)
```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
cp docker.env.example .env
nano .env  # Set your domain, email, and secrets
docker compose up -d
```

**3. Open** `https://your-domain/panel`
> Planning to manage the panel from AI assistants? See [MCP Setup Guide](docs/mcp-user-guide.md).

**Local development (HTTP only, no domain/SSL):**

Want to try the panel on your laptop without a public domain or certificate? Use the local compose file — it sets `USE_CADDY=true` (plain HTTP, no Greenlock/ACME) and publishes port `3000` directly, with dev defaults so it boots without a `.env`:
```bash
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel
docker compose -f docker-compose.local.yml up -d
# Open http://localhost:3000/panel
```
> Local mode has **no TLS** and is not for production. Subscription/share links assume HTTPS, so use it only for UI/API testing.

**Required `.env` variables:**
```env
PANEL_DOMAIN=panel.example.com
ACME_EMAIL=admin@example.com
ENCRYPTION_KEY=your32characterkey  # openssl rand -hex 16
SESSION_SECRET=yoursessionsecret   # openssl rand -hex 32
MONGO_PASSWORD=yourmongopassword   # openssl rand -hex 16
```

---

## 🐳 Dokploy (Development and Release)

Use `docker-compose.dokploy.yml` when deploying through Dokploy with Traefik.

### Development Mode (build from current branch)

1. In Dokploy, create a project from this repository/branch.
2. Set compose path to `docker-compose.dokploy.yml`.
3. Add env vars from `docker.env.example` and set at least:
   - `MONGO_PASSWORD`
   - `PANEL_DOMAIN`
   - `ACME_EMAIL`
   - `ENCRYPTION_KEY`
   - `SESSION_SECRET`
   - `DOKPLOY_PANEL_HOST` (domain used in Traefik `Host(...)` rule)
   - `DOKPLOY_TRAEFIK_SERVICE_PORT` (Traefik target/backend port, default `3000`)
4. Deploy: Dokploy will run `build: .` and start the stack.

This mode is best when you test branch changes before publishing a release image.

### Release Mode (Docker Hub image)

If you want stable deploys from Docker Hub tags (without building), replace `backend` image source in Dokploy compose with:

```yaml
backend:
  image: clickdevtech/hysteria-panel:latest
  # or pin a release tag, e.g. clickdevtech/hysteria-panel:v1.2.3
  restart: always
  depends_on:
    mongo:
      condition: service_healthy
    redis:
      condition: service_healthy
  expose:
    - "${DOKPLOY_TRAEFIK_SERVICE_PORT:-3000}"
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.celerity.rule=Host(`${DOKPLOY_PANEL_HOST}`)"
    - "traefik.http.routers.celerity.entrypoints=websecure"
    - "traefik.http.routers.celerity.tls=true"
    - "traefik.http.services.celerity.loadbalancer.server.port=${DOKPLOY_TRAEFIK_SERVICE_PORT:-3000}"
  env_file:
    - .env
```

Use `latest` for fast updates, or pin an explicit tag for predictable production rollouts.

---

## ✨ Features

- 🖥 **Web Panel** — Full UI for managing nodes and users
- 🔐 **Dual Protocol** — Hysteria 2 and Xray VLESS on one panel
- 🛡️ **Panel 2FA (TOTP)** — Unified TOTP verification flow for admin login and sensitive security actions
- 🚀 **Auto Node Setup** — Install Hysteria/Xray, certs, port hopping in one click
- 👥 **Server Groups** — Flexible user-to-node mapping
- ⚖️ **Load Balancing** — Distribute users by server load
- 🚫 **Traffic Filtering (ACL)** — Block ads, domains, IPs; route through custom proxies
- 🧩 **Advanced Hysteria Config** — optional ACME challenge options, masquerade modes, resolver, speed test, sniffing, and QUIC tuning
- 📊 **Statistics** — Online users, traffic, server status
- 📱 **Subscriptions** — Auto-format for Clash, Sing-box, Shadowrocket, Hiddify
- 🔄 **Backup/Restore** — Automatic backups with S3 support
- 💻 **SSH Terminal** — Direct node access from browser
- 🔑 **API Keys** — Secure external access with scopes, IP allowlist, rate limiting
- 🪝 **Webhooks** — Real-time event notifications with HMAC-SHA256 signing
- 🗺 **Network Map** — Visual cascade topology with Forward/Reverse chain routing *(beta)*
- 🤖 **MCP Integration** — Native AI assistant support (Claude, Cursor, etc.) for panel management
- 📡 **External Probes** — A standalone agent with a real sing-box core verifies node connectivity from real networks ([guide](docs/probes.md))
- ☁️ **Generic CDN Nodes** — Publish Xray WebSocket, gRPC, or XHTTP inbounds through a domain or pinned edge addresses ([guide](docs/cdn-nodes.md))

---

## ⚠️ Beta Features

### Network Map & Cascade Topology

> **Status:** beta — fully functional, but manual verification after deploy is recommended.

Cascade topology allows building server chains where clients connect to one node while traffic exits through another. This is useful in scenarios where the entry point must reside in a specific network or jurisdiction — for example, when connections must originate from local cloud provider IP ranges.

#### Why Use This

Many corporate and carrier networks apply IP-range filtering. Traffic to well-known local hosting providers may pass unrestricted, while connections to foreign IPs are blocked or throttled. Cascade topology solves this: clients connect to a server in a "trusted" IP range, and traffic is transparently proxied to an external server.

#### Xray Mechanisms Used

The panel generates Xray-core configurations using the following mechanisms:

| Mechanism | Purpose |
|-----------|---------|
| **Reverse Proxy** | Xray bridge/portal — allows a server behind NAT to initiate a connection to a public node and receive traffic through it |
| **Outbound Chaining** | Sequential proxying through multiple outbounds via `proxySettings.tag` |
| **REALITY** | TLS handshake camouflage to look like a connection to a legitimate site; no domain or certificate required |
| **Transport Layer Proxy** | `transportLayer: true` mode for correct REALITY application in hop chains |

#### Link Modes

**Reverse Proxy** — classic Xray reverse scheme. The Bridge server (typically abroad) initiates a persistent connection to the Portal server. Clients connect to Portal, traffic exits through Bridge.

```
Client ──▶ Portal (entry) ◀── tunnel ── Bridge (exit) ──▶ Internet
                           (bridge initiates connection)
```

- Portal can be behind NAT or firewall — no incoming connections required
- Suitable for scenarios where the entry point must be in a specific network

**Forward Chain** — direct outbound chain. Portal establishes connections through relay nodes to the exit Bridge.

```
Client ──▶ Portal ──▶ Relay (opt.) ──▶ Bridge (exit) ──▶ Internet
           (chained outbounds)
```

- All nodes in the chain must have a public IP
- REALITY is supported on each hop to encrypt inter-server traffic

#### REALITY Between Nodes

Tunnel-REALITY is configured **independently** from the client-facing REALITY on the Portal node. This enables:

- Encrypting inter-server traffic without drawing attention
- Using different SNI/destination for clients vs. tunnels
- Auto-generating x25519 keys and shortIds when creating links

#### Post-Deploy Recommendations

1. Check hop statuses on the Network Map
2. Verify traffic exits through the expected Bridge (check exit IP)
3. For Forward Chain — confirm each relay is reachable on its `tunnelPort`

#### Limitations

| Constraint | Reason |
|------------|--------|
| REALITY + WebSocket | WebSocket doesn't support uTLS fingerprint required by REALITY |
| Forward Chain without public IP | Each hop must accept incoming connections |
| Mixed modes in one chain | Reverse and Forward use different Xray mechanisms and cannot be combined |
| Same port on relay for two hops | A relay that is both bridge and portal requires different ports for incoming and outgoing tunnels |

---

## 🏗 Architecture

```
                              ┌─────────────────┐
                              │     CLIENTS     │
                              │ Clash, Sing-box │
                              │   Shadowrocket  │
                              └────────┬────────┘
                                       │
                     hysteria2:// or vless://
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │  Hysteria Node  │      │   Xray Node     │      │  Hysteria Node  │
     │   :443 + hop    │      │  VLESS Reality  │      │   :443 + hop    │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
              │    POST /api/auth      │   CC Agent API         │
              │    GET /online         │                        │
              └────────────────────────┼────────────────────────┘
                                       ▼
                          ┌────────────────────────┐
                          │    HYSTERIA PANEL      │
                          │                        │
                          │  • Web UI (/panel)     │
                          │  • HTTP Auth API       │
                          │  • Subscriptions       │
                          │  • SSH Terminal        │
                          │  • Stats Collector     │
                          └───────────┬────────────┘
                                      │
                                      ▼
                          ┌────────────────────────┐
                          │       MongoDB          │
                          └────────────────────────┘
```

### How Authentication Works

**Hysteria:**
1. Client connects to node with `userId:password`
2. Node sends `POST /api/auth` to panel
3. Panel validates user and returns `{ "ok": true/false }`

**Xray:**
1. Client connects with UUID (xrayUuid)
2. CC Agent on node manages user list via API
3. Panel syncs users to node without restarting Xray

### Server Groups

Instead of rigid "plans", use flexible groups:
- Create group (e.g., "Europe", "Premium")
- Assign nodes to group
- Assign users to group
- User gets only nodes from their groups in subscription

---

## 🔧 Node Types

### Hysteria 2

Fast UDP protocol based on QUIC with port hopping and obfuscation support.

**Advantages:**
- High speed on unstable networks
- Port hopping to bypass blocks
- Salamander and Gecko obfuscation (Gecko requires Hysteria 2.9.x)

**Settings:**
- Port, port range for hopping
- ACME or self-signed certificates
- Obfs (`salamander` or `gecko`) with password

**Advanced Hysteria settings in panel:**
- Port Hopping interval (`hopInterval`)
- ACME advanced options (challenge type, alt ports, DNS challenge provider and config)
- Masquerade modes: `proxy` and `string`
- Bandwidth limits (`up` / `down`) and `ignoreClientBandwidth`
- Built-in `speedTest`, `disableUDP`, `udpIdleTimeout`
- Protocol sniffing (`sniff`) and QUIC parameters (`quic`)
- Custom DNS resolver (`resolver`)
- ACL source mode (`inline` or `file`) + GeoIP/GeoSite paths
- Advanced sections are optional and omitted from generated config until enabled in UI

### Xray VLESS

Modern protocol with Reality support and various transports.

**Advantages:**
- Reality — disguise as legitimate HTTPS traffic
- Multiple transports (TCP, WebSocket, gRPC, XHTTP)
- No domain required for Reality

**Transports:**

| Transport | Description | Client Support |
|-----------|-------------|----------------|
| TCP | Direct connection, max speed | All clients |
| WebSocket | Works through CDN and proxies | All clients |
| gRPC | Multiplexing, good for CDN | All clients |
| XHTTP | New splithttp transport | Limited* |

*XHTTP is not supported by all clients. sing-box forks that implement it get the full framing; Mihomo's `xhttp-opts` carries path, mode and host only, so an inbound that negotiates framing is omitted from the Clash subscription instead of being published as a proxy that fails on every request.

**Security:**

| Mode | Description |
|------|-------------|
| Reality | Disguise as popular site, no domain needed |
| TLS | Classic TLS with certificate |
| None | No encryption (not recommended) |

---

## 🚀 Xray Node Setup

### Automatic Setup (Recommended)

1. Add node in panel:
   - Type: **Xray**
   - IP, SSH credentials
   - Security: Reality (recommended)
   - Transport: TCP (recommended for Reality)

2. Click "⚙️ Auto Setup"

3. Panel will automatically:
   - Install Xray-core
   - Generate Reality keys (x25519)
   - Upload config
   - Install CC Agent for user management
   - Open firewall ports
   - Start services

### Reality Settings

| Field | Description | Example |
|-------|-------------|---------|
| Dest | Disguise destination (domain:port) | `www.google.com:443` |
| SNI | Server Name Indication | `www.google.com` |
| Private Key | x25519 private key | Auto-generated |
| Public Key | Public key (for clients) | Auto-generated |
| Short IDs | Session identifiers | Auto-generated |

### CC Agent

CC Agent is a lightweight HTTP service on the node for managing Xray users without restart.

**Features:**
- Add/remove users on the fly
- Traffic stats collection
- Health check

Agent is installed automatically during Xray node auto-setup.

---

## 🔧 Hysteria Node Setup

### Understanding Node Configuration

#### Ports
- **Main port (443)** — Port Hysteria listens on
- **Port hopping range (20000-50000)** — UDP ports for hopping
- **Stats port (9999)** — Internal port for stats collection

#### Domain vs SNI

| Field | Purpose | Example |
|-------|---------|---------|
| **Domain** | For ACME/Let's Encrypt certificates | `de1.example.com` → `1.2.3.4` |
| **SNI** | For masquerading (domain fronting) | `www.google.com` |

**Scenarios:**
1. **Simple setup**: Set domain, leave SNI empty
2. **Domain fronting**: Set domain for certs, SNI as popular domain
3. **No domain**: Leave empty — self-signed certificate will be used

### Automatic Setup (Recommended)

1. Add node in panel (IP, SSH credentials)
2. Click "⚙️ Auto Setup"
3. Panel will automatically:
   - Install Hysteria 2
   - Configure ACME or self-signed certificates
   - Set up port hopping
   - Open firewall ports
   - Start service

### Obfuscation (Salamander / Gecko)

Hysteria supports obfuscation to disguise traffic:

1. Enable **Obfs** in node settings
2. Select **Salamander** or **Gecko** (`gecko` requires Hysteria 2.9.x)
3. Set **obfuscation password**
4. Save and update config

Clients will automatically receive the selected `obfs` type and password in subscription.

### Single VPS Setup (Panel + Node)

You can run panel and node on the same VPS (panel TCP, node UDP on 443).

**Option 1: Use panel domain (recommended)**
- Set node domain same as panel domain
- Panel certificates will be copied automatically

**Option 2: No domain (self-signed)**
- Leave domain field empty
- Self-signed certificate will be generated

---

## 📖 API Reference

### API Key Authentication

All `/api/*` endpoints (except `/api/auth` and `/api/files`) require authentication.

**Create a key:** Settings → Security → API Keys → Create Key

**Usage:**
```http
# Option 1 — header
X-API-Key: ck_your_key_here

# Option 2 — Bearer token
Authorization: Bearer ck_your_key_here
```

#### Scopes

| Scope | Access |
|-------|--------|
| `users:read` | Read users |
| `users:write` | Create / update / delete users |
| `nodes:read` | Read nodes |
| `nodes:write` | Create / update / delete / sync nodes |
| `stats:read` | Read stats and groups |
| `sync:write` | Trigger sync, kick users |

#### Rate Limiting

Each key has a configurable rate limit (default: 60 req/min).  
Exceeded requests return `429` with `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers.

---

### Authentication (for nodes)

#### POST `/api/auth`

Validates user on Hysteria node connection.

```json
// Request
{ "addr": "1.2.3.4:12345", "auth": "userId:password" }

// Response (success)
{ "ok": true, "id": "userId" }

// Response (error)
{ "ok": false }
```

### Subscriptions

#### GET `/api/files/:token`

Universal subscription endpoint. Auto-detects format by User-Agent.

| User-Agent | Format |
|------------|--------|
| `shadowrocket` | Base64 URI list |
| `clash`, `stash`, `surge` | Clash YAML |
| `hiddify`, `sing-box`, `karing` | Sing-box JSON |
| Browser | HTML page with QR code |
| Other | Plain URI list |

**Query params:** `?format=clash`, `?format=singbox`, `?format=uri`

#### GET `/api/files/info/:token`

Subscription info (status, traffic, expiry).

### Users

Required scope: `users:read` (GET) / `users:write` (POST, PUT, DELETE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List users (pagination, filtering, sorting) |
| GET | `/api/users/:userId` | Get user |
| POST | `/api/users` | Create user |
| PUT | `/api/users/:userId` | Update user |
| DELETE | `/api/users/:userId` | Delete user |
| POST | `/api/users/bulk-delete` | Delete selected users (best-effort) |
| POST | `/api/users/:userId/enable` | Enable user |
| POST | `/api/users/:userId/disable` | Disable user |
| POST | `/api/users/:userId/groups` | Add user to groups |
| DELETE | `/api/users/:userId/groups/:groupId` | Remove user from group |
| POST | `/api/users/sync-from-main` | Sync from external DB |

### Nodes

Required scope: `nodes:read` (GET) / `nodes:write` (POST, PUT, DELETE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | List nodes |
| GET | `/api/nodes/:id` | Get node |
| POST | `/api/nodes` | Create node |
| PUT | `/api/nodes/:id` | Update node |
| DELETE | `/api/nodes/:id` | Delete node |
| GET | `/api/nodes/:id/config` | Get node config (YAML/JSON) |
| GET | `/api/nodes/:id/status` | Get node status |
| POST | `/api/nodes/:id/reset-status` | Reset status to online |
| GET | `/api/nodes/:id/users` | Get users on node |
| POST | `/api/nodes/:id/sync` | Sync specific node |
| POST | `/api/nodes/:id/update-config` | Push config via SSH |
| POST | `/api/nodes/:id/setup` | Auto-setup node via SSH |
| POST | `/api/nodes/:id/setup-port-hopping` | Setup port hopping |
| POST | `/api/nodes/:id/groups` | Add node to groups |
| DELETE | `/api/nodes/:id/groups/:groupId` | Remove from group |
| GET | `/api/nodes/:id/agent-info` | Get CC Agent info (Xray) |

### Stats & Sync

| Method | Endpoint | Scope | Description |
|--------|----------|-------|-------------|
| GET | `/api/stats` | `stats:read` | Panel statistics |
| GET | `/api/groups` | `stats:read` | List server groups |
| POST | `/api/sync` | `sync:write` | Sync all nodes |
| POST | `/api/kick/:userId` | `sync:write` | Kick user from all nodes |

---

## 🪝 Webhooks

Send real-time event notifications to any HTTP endpoint.

**Configure:** Settings → Security → Webhooks

### Request Format

```http
POST https://your-endpoint.com/webhook
Content-Type: application/json
X-Webhook-Event: user.created
X-Webhook-Timestamp: 1700000000
X-Webhook-Signature: sha256=<hmac>
User-Agent: C3-Celerity-Webhook/1.0

{
  "event": "user.created",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": { ... }
}
```

### Signature Verification

```js
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', YOUR_SECRET)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
// compare with X-Webhook-Signature header
```

### Events

| Event | Trigger |
|-------|---------|
| `user.created` | User created |
| `user.updated` | User updated |
| `user.deleted` | User deleted |
| `user.enabled` | User enabled |
| `user.disabled` | User disabled |
| `user.traffic_exceeded` | User traffic limit reached |
| `user.expired` | User subscription expired |
| `node.online` | Node came online |
| `node.offline` | Node went offline |
| `node.error` | Node error |
| `host.disk_low` | Panel host free disk dropped below the warning threshold |
| `host.disk_critical` | Panel host free disk dropped below the critical threshold |
| `host.disk_recovered` | Panel host free disk recovered above the warning threshold |
| `sync.completed` | Sync cycle finished |
| `probe.node_unreachable` | A probe cannot reach a node inbound from its vantage point |
| `probe.target_unreachable` | A checklist resource became unreachable through a node |
| `probe.offline` | A probe stopped reporting |

Disk alert thresholds are configured under **Settings → Security → Webhooks**
(`Warning: free space below %` and `Critical: free space below GB`). Alerts fire
once per threshold crossing with hysteresis to avoid spam, and a recovery event
is sent once free space climbs back above the warning level.

---

## 📡 External Diagnostic Probes

A probe is a separate Go binary installed on your own server. It receives a
hidden subscription, runs a real sing-box core and connects to your nodes the
same way a customer does, which shows whether a node is reachable from that
particular network.

Enable it under **Settings → Probes**, then add a probe and run the generated
install command on the host you want to check from. Every result is stored per
vantage point and never overrides `node.status`, since a failure can also come
from the probe's own uplink.

Each failure code points at a specific cause: `net_unreachable` (port filtered
on the path), `handshake_failed` (dead REALITY destination or DPI),
`auth_rejected` (user not pushed to the running core), `tunnel_no_data` (broken
outbound or ACL), `degraded`, and `core_down` for a failure of the probe's own
core.

📖 **Full guide:** [English](docs/probes.md) · [Русский](docs/probes.ru.md)

---

## 🧹 Disk Space & Maintenance

MongoDB and the panel stop working when the host runs out of disk, so keep an
eye on free space (the dashboard shows a **Disk** chart and webhooks can alert
you — see above). The most common cause of a full disk is Docker accumulating
unused images, containers and logs over time.

**Cap container log size** (prevents logs from filling the disk). Add to each
service in your `docker-compose.yml`:

```yaml
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

**Periodically reclaim space** used by dangling/unused Docker data:

```bash
# Safe: remove only dangling images and build cache
docker image prune -f
docker builder prune -f

# Aggressive: also removes ALL unused images (next deploy re-pulls them)
docker system prune -a -f
```

A weekly `cron` job running `docker image prune -f` is usually enough to keep
disk usage in check.

---

## 📊 Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| `userId` | String | Unique ID |
| `username` | String | Display name |
| `subscriptionToken` | String | URL token for subscription |
| `xrayUuid` | String | UUID for Xray VLESS (auto-generated) |
| `enabled` | Boolean | User active status |
| `groups` | [ObjectId] | Server groups |
| `nodes` | [ObjectId] | Direct node assignments |
| `traffic` | Object | `{ tx, rx, lastUpdate }` — used traffic |
| `trafficLimit` | Number | Traffic limit in bytes (0 = unlimited) |
| `maxDevices` | Number | Device limit (0 = group limit, -1 = unlimited) |
| `expireAt` | Date | Expiration date |

### Node

| Field | Type | Description |
|-------|------|-------------|
| `type` | String | `hysteria` or `xray` |
| `name` | String | Display name |
| `flag` | String | Country flag (emoji) |
| `ip` | String | IP address |
| `domain` | String | Domain for SNI/ACME |
| `sni` | String | Custom SNI for masquerading |
| `port` | Number | Main port (443) |
| `portRange` | String | Port hopping range |
| `portConfigs` | Array | Multi-port: `[{ name, port, portRange, enabled }]` |
| `obfs` | Object | Obfuscation: `{ type: 'salamander' \| 'gecko', password }` |
| `statsPort` | Number | Hysteria stats port (9999) |
| `statsSecret` | String | Stats API secret |
| `groups` | [ObjectId] | Server groups |
| `outbounds` | Array | Proxies for ACL: `[{ name, type, addr }]` |
| `aclRules` | [String] | ACL rules |
| `maxOnlineUsers` | Number | Max online for load balancing |
| `rankingCoefficient` | Number | Sorting coefficient (1.0) |
| `status` | String | online/offline/error/syncing |
| `traffic` | Object | `{ tx, rx, lastUpdate }` — node traffic |
| `xray` | Object | Xray settings (see below) |

#### Xray Settings (node.xray)

| Field | Type | Description |
|-------|------|-------------|
| `transport` | String | tcp, ws, grpc, xhttp |
| `security` | String | reality, tls, none |
| `flow` | String | xtls-rprx-vision (for tcp) |
| `fingerprint` | String | chrome, firefox, safari, etc. |
| `alpn` | [String] | ALPN protocols (h3, h2, http/1.1) |
| `realityDest` | String | Disguise destination |
| `realitySni` | [String] | Server names |
| `realityPrivateKey` | String | x25519 private key |
| `realityPublicKey` | String | Public key |
| `realityShortIds` | [String] | Short IDs |
| `realitySpiderX` | String | Spider X path — start URL for the REALITY spider on probe (empty by default; per-node value recommended) |
| `wsPath` | String | WebSocket path |
| `wsHost` | String | WebSocket host header |
| `grpcServiceName` | String | gRPC service name |
| `xhttpPath` | String | XHTTP path |
| `xhttpHost` | String | XHTTP host header |
| `xhttpMode` | String | auto, packet-up, stream-up |
| `xhttpXPaddingBytes` | String | XHTTP padding length, `"min-max"` or a single number (empty = core default 100-1000). Published to clients in the subscription; the inbound accepts the union with the default range so clients that ignore it keep working |
| `xhttpScMaxEachPostBytes` | String | packet-up upload split threshold in bytes (empty = 1000000). The inbound accepts at least the default, so a smaller value applies only to clients that read it |
| `xhttpNoGrpcHeader` | Boolean | Omit the gRPC content-type on stream-up/stream-one (client-side only) |
| `xhttpXmuxMaxConcurrency` | String | XMUX streams per connection, e.g. `"16-32"` (client-side only) |
| `xhttpXmuxHMaxRequestTimes` | String | XMUX requests per connection, e.g. `"600-900"` (client-side only) |
| `xhttpXmuxHMaxReusableSecs` | String | XMUX connection lifetime in seconds, e.g. `"1800-3000"` (client-side only) |
| `xhttpUplinkHTTPMethod` | String | `GET` or `POST` for the upload; `GET` requires `packet-up` and is what a CDN that blocks POST needs |
| `xhttpUplinkDataPlacement` | String | `body` or `header` — where the client puts uploaded data |
| `xhttpUplinkDataKey` | String | Header name when `uplinkDataPlacement: header`, e.g. `X-Data` |
| `xhttpUplinkChunkSize` | String | Upload chunk size, `"min-max"` or a single number |
| `xhttpScMinPostsIntervalMs` | String | Minimum interval between client posts, in ms |
| `xhttpServerMaxHeaderBytes` | Number | Header limit on the inbound; does not change the CDN edge limit |
| `xhttpXPaddingObfsMode` | Boolean | Disguise the padding as an ordinary parameter instead of `x_padding` |
| `xhttpXPaddingKey` | String | Parameter/header name carrying the padding, e.g. `utm_source` |
| `xhttpXPaddingPlacement` | String | `query` or `header` |
| `xhttpXPaddingMethod` | String | `tokenish` — the padding value format |
| `xhttpSessionPlacement` | String | `query`, `header` or `path` — where the session id travels |
| `xhttpSessionKey` | String | Session parameter/header name, e.g. `sid` |
| `xhttpSeqPlacement` | String | `query`, `header` or `path` — where the packet number travels |
| `xhttpSeqKey` | String | Packet-number parameter/header name |
| `apiPort` | Number | Xray gRPC API port (61000) |
| `inboundTag` | String | Inbound tag (vless-in) |
| `agentPort` | Number | CC Agent port (62080) |
| `agentToken` | String | Agent token |
| `agentTls` | Boolean | TLS for CC Agent |

### ServerGroup

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Group name |
| `description` | String | Description |
| `color` | String | UI color (#hex) |
| `maxDevices` | Number | Device limit for group |
| `subscriptionTitle` | String | Title in subscription profile |

---

## 🚫 Traffic Filtering (ACL)

Control traffic routing on each Hysteria node. Access: **Panel → Node → Traffic Filtering**.

### Built-in Actions

| Action | Description |
|--------|-------------|
| `reject(...)` | Block connection |
| `direct(...)` | Allow through server |

### Rule Examples

```
reject(suffix:doubleclick.net)     # Block ads
reject(suffix:googlesyndication.com)
reject(geoip:cn)                   # Block Chinese IPs
reject(geoip:private)              # Block private IPs
direct(all)                        # Allow everything else
```

### Custom Proxy Routing

1. Add proxy (e.g., `my-proxy`, SOCKS5, `1.2.3.4:1080`)
2. Use in rules: `my-proxy(geoip:ru)`

---

## ⚖️ Load Balancing

Configure in **Settings**:

- **Enable balancing** — Sort nodes by current load
- **Hide overloaded** — Exclude nodes at capacity

Algorithm:
1. Get user's nodes from groups
2. Sort by load % (online/max)
3. Filter overloaded if enabled
4. Fall back to `rankingCoefficient`

---

## 🔒 Device Limits

**Priority:**
1. User's personal limit (`maxDevices > 0`)
2. Minimum limit from user's groups
3. `-1` = unlimited

**Device Grace Period** — delay (in seconds) before counting a disconnected device, to avoid false triggers during reconnections.

---

## 📱 Subscription Page Customization

Customize the HTML subscription page in **Settings → Subscription**:

| Field | Description |
|-------|-------------|
| `Logo URL` | Logo URL for page header |
| `Page Title` | Page title |
| `Support URL` | Support link (button at bottom) |
| `Web Page URL` | Profile URL (`profile-web-page-url` header) |

The subscription page automatically shows:
- QR code for app import
- Traffic stats and expiration
- Location list with copy buttons

---

## 💾 Backups

### Auto Backups

Configure in **Settings → Backups**:
- Interval (in hours)
- Number of local copies to keep

### Manual Backup

Dashboard button — file auto-downloads.

### Restore

Upload `.tar.gz` archive via interface.

### S3-Compatible Storage

Backups can be automatically uploaded to S3-compatible storage (AWS S3, MinIO, Backblaze B2, Cloudflare R2, etc.).

**Configure:** Settings → Backups → S3

| Field | Description |
|-------|-------------|
| `Endpoint` | Storage URL (for MinIO, etc.). Leave empty for AWS S3 |
| `Region` | Region (e.g., `us-east-1`) |
| `Bucket` | Bucket name |
| `Prefix` | Prefix/folder for backups |
| `Access Key ID` | Access key |
| `Secret Access Key` | Secret key |
| `Keep Last` | How many backups to keep in S3 |

**Configuration examples:**

```env
# AWS S3
Endpoint: (empty)
Region: eu-central-1
Bucket: my-backups

# MinIO
Endpoint: https://minio.example.com
Region: us-east-1
Bucket: backups

# Cloudflare R2
Endpoint: https://<account-id>.r2.cloudflarestorage.com
Region: auto
Bucket: my-backups
```

---

## 🐳 Docker Compose

```yaml
version: '3.8'

services:
  mongo:
    image: mongo:7
    restart: always
    volumes:
      - mongo_data:/data/db
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER:-hysteria}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD}

  backend:
    image: clickdevtech/hysteria-panel:latest
    restart: always
    depends_on:
      - mongo
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./logs:/app/logs
      - ./greenlock.d:/app/greenlock.d
      - ./backups:/app/backups
    env_file:
      - .env

volumes:
  mongo_data:
```

---

## 📝 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PANEL_DOMAIN` | ✅ | Panel domain |
| `DOKPLOY_PANEL_HOST` | ❌ | Traefik host for Dokploy (`Host(...)` rule) |
| `DOKPLOY_TRAEFIK_SERVICE_PORT` | ❌ | Traefik/backend service port in Dokploy (default: `3000`) |
| `ACME_EMAIL` | ✅ | Let's Encrypt email |
| `ENCRYPTION_KEY` | ✅ | SSH encryption key (32 chars) |
| `SESSION_SECRET` | ✅ | Session secret |
| `MONGO_PASSWORD` | ✅ | MongoDB password (for Docker) |
| `MONGO_USER` | ❌ | MongoDB user (default: hysteria) |
| `MONGO_URI` | ❌ | MongoDB connection URI (for non-Docker) |
| `REDIS_URL` | ❌ | Redis URL for cache (default: in-memory) |
| `USE_CADDY` | ❌ | Serve plain HTTP on `PORT` behind a reverse proxy instead of Greenlock HTTPS. Used by `docker-compose.yml`/`docker-compose.dokploy.yml`. Unset = standalone HTTPS via Greenlock (needs a real domain + public ports 80/443) |
| `PORT` | ❌ | Backend HTTP port when `USE_CADDY=true` (default: `3000`) |
| `PANEL_IP_WHITELIST` | ❌ | IP whitelist for panel |
| `SYNC_INTERVAL` | ❌ | Sync interval in minutes (default: 2) |
| `API_DOCS_ENABLED` | ❌ | Enable interactive API docs at `/api/docs` |
| `LOG_LEVEL` | ❌ | Logging level (default: info) |

---

## 🤝 Contributing

Pull requests welcome!

---

## 📄 License

MIT
