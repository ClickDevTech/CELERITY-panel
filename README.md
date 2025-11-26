# Hysteria Panel

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)](package.json)
[![Hysteria](https://img.shields.io/badge/Hysteria-2.x-9B59B6)](https://v2.hysteria.network/)

Web panel for managing [Hysteria 2](https://v2.hysteria.network/) proxy servers with centralized HTTP authentication, one-click node setup, and flexible user-to-server group mapping.

## ⚡ Quick Start

```bash
# Clone
git clone https://github.com/ClickDevTech/hysteria-panel.git
cd hysteria-panel

# Configure
cp docker.env.example .env
nano .env  # Set your domain, email, and secrets

# Run
docker-compose up -d

# Open https://your-domain/panel
```

**Required `.env` variables:**
```env
PANEL_DOMAIN=panel.example.com
ACME_EMAIL=admin@example.com
ENCRYPTION_KEY=your32characterkey  # openssl rand -hex 16
SESSION_SECRET=yoursessionsecret   # openssl rand -hex 32
MONGO_PASSWORD=yourmongopassword   # openssl rand -hex 16
```

---

## ✨ Features

- 🖥 **Web Panel** — Full UI for managing nodes and users
- 🔐 **HTTP Auth** — Centralized client verification via API
- 🚀 **Auto Node Setup** — Install Hysteria, certs, port hopping in one click
- 👥 **Server Groups** — Flexible user-to-node mapping
- ⚖️ **Load Balancing** — Distribute users by server load
- 📊 **Statistics** — Online users, traffic, server status
- 📱 **Subscriptions** — Auto-format for Clash, Sing-box, Shadowrocket
- 🔄 **Backup/Restore** — Automatic database backups
- 💻 **SSH Terminal** — Direct node access from browser

---

## 🏗 Architecture

```
                              ┌─────────────────┐
                              │     CLIENTS     │
                              │ Clash, Sing-box │
                              │   Shadowrocket  │
                              └────────┬────────┘
                                       │
                          hysteria2://user:pass@host
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
     │   Node          │      │      Node CH    │      │      Node DE    │
     │   Hysteria 2    │      │   Hysteria 2    │      │   Hysteria 2    │
     │   :443 + hop    │      │   :443 + hop    │      │   :443 + hop    │
     └────────┬────────┘      └────────┬────────┘      └────────┬────────┘
              │                        │                        │
              │    POST /api/auth      │                        │
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

1. Client connects to Hysteria node with `userId:password`
2. Node sends `POST /api/auth` to the panel
3. Panel checks: user exists, enabled, device/traffic limits
4. Returns `{ "ok": true, "id": "userId" }` or `{ "ok": false }`

### Server Groups

Instead of rigid "plans", use flexible groups:
- Create group (e.g., "Europe", "Premium")
- Assign nodes to group
- Assign users to group
- User gets only nodes from their groups in subscription

---

## 📖 API Reference

### Authentication (for nodes)

#### POST `/api/auth`

Validates user on node connection.

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
| `hiddify`, `sing-box` | Sing-box JSON |
| Browser | HTML page |
| Other | Plain URI list |

**Query params:** `?format=clash`, `?format=singbox`, `?format=uri`

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/users` | List users |
| GET | `/api/users/:userId` | Get user |
| POST | `/api/users` | Create user |
| PUT | `/api/users/:userId` | Update user |
| DELETE | `/api/users/:userId` | Delete user |
| POST | `/api/users/:userId/enable` | Enable user |
| POST | `/api/users/:userId/disable` | Disable user |

### Nodes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | List nodes |
| GET | `/api/nodes/:id` | Get node |
| POST | `/api/nodes` | Create node |
| PUT | `/api/nodes/:id` | Update node |
| DELETE | `/api/nodes/:id` | Delete node |
| GET | `/api/nodes/:id/config` | Get node config (YAML) |
| POST | `/api/nodes/:id/update-config` | Push config via SSH |

### Sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sync` | Sync all nodes |

---

## 🔧 Node Setup

### Automatic (Recommended)

1. Add node in panel (IP, SSH credentials)
2. Click "⚙️ Auto Setup"
3. Panel will automatically:
   - Install Hysteria 2
   - Configure ACME certificates
   - Set up port hopping
   - Open firewall ports
   - Start service

### Manual

```bash
# Install Hysteria
bash <(curl -fsSL https://get.hy2.sh/)

# Create config /etc/hysteria/config.yaml
listen: :443

acme:
  domains: [your-domain.com]
  email: acme@your-domain.com

auth:
  type: http
  http:
    url: https://panel.example.com/api/auth
    insecure: false

trafficStats:
  listen: :9999
  secret: your_secret

masquerade:
  type: proxy
  proxy:
    url: https://www.google.com
    rewriteHost: true
```

```bash
# Start
systemctl enable --now hysteria-server

# Port hopping
iptables -t nat -A PREROUTING -p udp --dport 20000:50000 -j REDIRECT --to-port 443
```

---

## 📊 Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| `userId` | String | Unique ID (e.g., Telegram ID) |
| `subscriptionToken` | String | URL token for subscription |
| `enabled` | Boolean | User active status |
| `groups` | [ObjectId] | Server groups |
| `trafficLimit` | Number | Traffic limit in bytes (0 = unlimited) |
| `maxDevices` | Number | Device limit (0 = group limit, -1 = unlimited) |
| `expireAt` | Date | Expiration date |

### Node

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Display name |
| `ip` | String | IP address |
| `domain` | String | Domain for SNI/ACME |
| `port` | Number | Main port (443) |
| `portRange` | String | Port hopping range |
| `groups` | [ObjectId] | Server groups |
| `maxOnlineUsers` | Number | Max online for load balancing |
| `status` | String | online/offline/error |

### ServerGroup

| Field | Type | Description |
|-------|------|-------------|
| `name` | String | Group name |
| `color` | String | UI color (#hex) |
| `maxDevices` | Number | Device limit for group |

---

## ⚖️ Load Balancing

Configure in Settings:

- **Enable balancing** — Sort nodes by current load
- **Hide overloaded** — Exclude nodes at capacity

Algorithm:
1. Get user's nodes from groups
2. Sort by load % (online/max)
3. Filter overloaded if enabled
4. Fall back to `rankingCoefficient`

---

## 🔒 Device Limits

Limit simultaneous connections per user.

**Priority:**
1. User's personal limit (`maxDevices > 0`)
2. Minimum limit from user's groups
3. `-1` = unlimited

On each `POST /api/auth`:
1. Query `/online` from all nodes
2. Count sessions for userId
3. Reject if `>= maxDevices`

---

## 💾 Backups

- **Auto backups** — Configure in Settings
- **Manual backup** — Dashboard button, auto-downloads
- **Restore** — Upload `.tar.gz` archive

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
    build: .
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
| `ACME_EMAIL` | ✅ | Let's Encrypt email |
| `ENCRYPTION_KEY` | ✅ | SSH encryption key (32 chars) |
| `SESSION_SECRET` | ✅ | Session secret |
| `MONGO_PASSWORD` | ✅ | MongoDB password |
| `MONGO_USER` | ❌ | MongoDB user (default: hysteria) |
| `PANEL_IP_WHITELIST` | ❌ | IP whitelist for panel |
| `SYNC_INTERVAL` | ❌ | Sync interval in minutes (default: 2) |

---

## 🤝 Contributing

Pull requests welcome!

---

## 📄 License

MIT
