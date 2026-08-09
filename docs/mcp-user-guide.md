# 🤖 MCP Integration User Guide

> Connect AI assistants directly to your C³ CELERITY panel for automated management.

---

## 📖 What is MCP?

**Model Context Protocol (MCP)** is a protocol that allows AI assistants (Claude, Cursor, etc.) to directly interact with the C³ CELERITY panel.

### ✨ Capabilities

Through MCP, AI can:

| Capability | Description |
|------------|-------------|
| 👥 **User Management** | Create, edit, disable VPN users |
| 🖥 **Server Configuration** | Configure servers and nodes |
| 💻 **SSH Commands** | Execute commands on servers remotely |
| 📊 **Monitoring** | Retrieve statistics and logs |
| 🔎 **Access Logs** | Run read-only SQL against ClickHouse `access_events` |
| 🔧 **Diagnostics** | Diagnose and troubleshoot issues |

---

## 📋 Requirements

| Requirement | Description |
|-------------|-------------|
| 🔑 **API Key** | With `mcp:enabled` scope |
| 🖥 **AI Client** | Claude Desktop, Cursor IDE, or any HTTP client with SSE support |

---

## 🔐 Creating an API Key

### Step-by-Step

1. 🖱 Open panel → **Settings** → **API Keys**
2. ➕ Click **Create MCP API Key**
3. ✏️ Enter a key name (e.g., `"Claude Assistant"`)
4. 🎛 Select permissions:
   
   | Type | Scopes | Use Case |
   |------|--------|----------|
   | 🟢 **Basic** | `mcp:enabled` + read scopes | Read-only access (default) |
   | 🟡 **Extended** | `users:write`, `nodes:write`, `sync:write` | Write operations |
   
5. 📋 Copy the key — **shown only once!**

> ⚠️ **Important**: Store your API key securely. You won't be able to see it again.

---

## 🔌 Connecting AI Clients

### 🖥 Claude Desktop

Add to your Claude Desktop configuration file:

| Platform | Config Path |
|----------|-------------|
| 🍎 **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| 🪟 **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "celerity": {
      "url": "https://your-panel.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### 📝 Cursor IDE

Create a `.cursor/mcp.json` file in your project root:

```json
{
  "mcpServers": {
    "celerity": {
      "url": "https://your-panel.com/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### 🔧 Custom Client

Any HTTP client with SSE support can connect:

| Parameter | Value |
|-----------|-------|
| 📍 **Endpoint** | `https://your-panel.com/api/mcp` |
| 🔐 **Auth** | `Authorization: Bearer YOUR_API_KEY` |
| 📦 **Content-Type** | `application/json` |
| 📡 **Accept** | `text/event-stream` (for streaming) |

<details>
<summary>📖 Example Request</summary>

```bash
curl -X POST https://your-panel.com/api/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}'
```

</details>

---

## 🛠 Available Tools

### 🔍 query — Read Data

> Universal tool for retrieving data from the panel.

| Resource | Description | Required Scope |
|----------|-------------|----------------|
| `users` | 👥 List of users | `users:read` |
| `nodes` | 🖥 List of servers | `nodes:read` |
| `groups` | 📁 Server groups | `stats:read` |
| `stats` | 📊 Traffic statistics | `stats:read` |
| `logs` | 📜 System logs (panel winston buffer, not ClickHouse) | `stats:read` |

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `resource` | ✅ Yes | Resource type |
| `id` | ❌ No | Specific item ID |
| `filter` | ❌ No | Filters (resource-dependent) |
| `limit`, `page` | ❌ No | Pagination |
| `sortBy`, `sortOrder` | ❌ No | Sorting |

<details>
<summary>📖 Example: Get all active users</summary>

```json
{
  "name": "query",
  "arguments": {
    "resource": "users",
    "filter": { "enabled": true },
    "limit": 50
  }
}
```

</details>

---

### 🔎 query_access_logs — ClickHouse Access Logs

> `stats:read` scope required. Requires Access Logs + ClickHouse configured in panel settings.

Runs a **read-only** SQL query against the ClickHouse `access_events` table (Xray connection events). This is **not** the same as `query` / `resource=logs` (system logs).

Allowed statement types: `SELECT`, `WITH`, `EXPLAIN`, `DESCRIBE`, `SHOW`. Mutations are rejected; results are capped (default 1000 rows, 30s timeout).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `sql` | ✅ Yes | Single read-only ClickHouse SQL statement |

<details>
<summary>📖 Example: Recent accepted connections for a user</summary>

```json
{
  "name": "query_access_logs",
  "arguments": {
    "sql": "SELECT event_time, node_id, source_ip, dest_host, dest_ip, dest_port, action FROM access_events WHERE email = 'user123' AND event_time >= now() - INTERVAL 1 DAY ORDER BY event_time DESC LIMIT 100"
  }
}
```

</details>

---

### 📡 query_probes — External Probe Results

> `probes:read` scope required. Requires probes enabled in panel settings.

Returns what external probes observed by dialling your nodes through a real sing-box core, which is the one thing control-plane data cannot answer: whether a client behind a given ISP can actually connect. See the [probes guide](probes.md).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `view` | ❌ No | `probes` (vantage points, default), `nodes` (latest verdict per inbound), `targets` (checklist resources) |
| `nodeId` | ❌ No | Restrict `nodes` / `targets` views to one node |
| `probeId` | ❌ No | Restrict results to one probe |
| `hours` | ❌ No | Look-back window, 1–720 (default 1). Over 24 h reads hourly rollups |
| `limit` | ❌ No | 1–500 (default 100) |

Verdicts: `net_unreachable`, `handshake_failed`, `auth_rejected`, `tunnel_no_data`, `degraded`, `core_down` (the probe's own core failed — this says nothing about the node).

<details>
<summary>📖 Example: Why users complain about one node</summary>

```json
{
  "name": "query_probes",
  "arguments": {
    "view": "nodes",
    "nodeId": "sample-node",
    "hours": 6
  }
}
```

</details>

---

### 👤 manage_user — User Management

> `users:write` scope required

**Available Actions:** `create` | `update` | `delete` | `enable` | `disable` | `reset_traffic`

<details>
<summary>📖 Example: Create a user</summary>

```json
{
  "name": "manage_user",
  "arguments": {
    "action": "create",
    "userId": "user123",
    "data": {
      "username": "John Doe",
      "trafficLimit": 107374182400,
      "maxDevices": 3,
      "groups": ["groupId1"]
    }
  }
}
```

</details>

---

### 🖥 manage_node — Server Management

> `nodes:write` scope required

**Available Actions:** `create` | `update` | `delete` | `sync` | `setup` | `reset_status` | `update_config`

<details>
<summary>📖 Example: Setup node via SSH</summary>

```json
{
  "name": "manage_node",
  "arguments": {
    "action": "setup",
    "id": "nodeId123",
    "setupOptions": {
      "installHysteria": true,
      "setupPortHopping": true,
      "restartService": true
    }
  }
}
```

</details>

---

### 📁 manage_group — Group Management

> `nodes:write` scope required

**Available Actions:** `create` | `update` | `delete`

---

### 🔗 manage_cascade — Cascade Tunnels

> `nodes:write` scope required

**Available Actions:** `create` | `update` | `delete` | `deploy` | `undeploy` | `reconnect`

---

### 💻 execute_ssh — Execute Commands

> `nodes:write` scope required

Executes a shell command on the server and returns the output.

<details>
<summary>📖 Example: Check service status</summary>

```json
{
  "name": "execute_ssh",
  "arguments": {
    "nodeId": "nodeId123",
    "command": "systemctl status hysteria-server"
  }
}
```

</details>

---

### 🖥 ssh_session — Interactive SSH Session

> `nodes:write` scope required

**Available Actions:** `start` | `input` | `close`

---

### ⚙️ system_action — System Operations

> `sync:write` scope required

**Available Actions:** `sync_all` | `clear_cache` | `backup` | `kick_user`

---

### 🗺 get_topology — Network Topology

> `nodes:read` scope required

Returns all active nodes and connections between them.

---

### ❤️ health_check — Health Check

> ✅ No scope required

Returns uptime, sync status, cache stats, memory usage.

---

## 📝 Built-in Prompts

> Prompts are pre-configured scenarios that appear as slash commands in Claude Desktop (e.g., `/panel_overview`).

| Prompt | Description |
|--------|-------------|
| 📊 `panel_overview` | System overview: nodes, users, health |
| 🔍 `audit_nodes` | Find problematic nodes and suggest fixes |
| 👤 `user_report` | Detailed report for a specific user |
| 🖥 `setup_new_node` | Step-by-step node addition guide |
| 🔧 `troubleshoot_node` | Node diagnostics via SSH |
| ⏰ `manage_expired_users` | Find and handle expired users |

---

## 💡 Usage Examples

### 📊 "Show me the status of all servers"

AI will execute:

| Step | Tool | Purpose |
|------|------|---------|
| 1 | `health_check` | Overall status |
| 2 | `query` with `resource=nodes` | List of nodes |
| 3 | — | Generate report with problematic nodes highlighted |

---

### 👤 "Create user testuser with 50 GB limit"

AI will execute:

```
manage_user → action=create, userId=testuser, trafficLimit=53687091200
```

---

### 🔧 "Why is node DE-01 not working?"

AI will execute:

| Step | Tool | Purpose |
|------|------|---------|
| 1 | `query` with `resource=nodes`, `id=<DE-01-id>` | Get lastError |
| 2 | `execute_ssh` with `systemctl status hysteria-server` | Check service |
| 3 | — | Analyze and suggest solution |

---

### 🖥 "Set up new server 192.168.1.100"

AI will use the `setup_new_node` prompt:

| Step | Action |
|------|--------|
| 1 | 📋 Collect data (IP, domain, SSH credentials) |
| 2 | 🆕 Create node via `manage_node` |
| 3 | ⚙️ Run auto-setup via `manage_node action=setup` |
| 4 | ✅ Verify status |

---

## 🔑 Access Permissions (Scopes)

| Scope | Description | Level |
|-------|-------------|-------|
| `mcp:enabled` | 🟢 Basic MCP access permission | Required |
| `users:read` | 👁 Read users | Read |
| `users:write` | ✏️ Create, modify, delete users | Write |
| `nodes:read` | 👁 Read servers and statistics | Read |
| `nodes:write` | ✏️ Manage servers, SSH commands | Write |
| `stats:read` | 👁 Read statistics, system logs, and ClickHouse access logs | Read |
| `probes:read` | 👁 Read external probe results | Read |
| `sync:write` | ✏️ Sync, backups, system operations | Write |

---

## 🛡 Security

| Best Practice | Description |
|---------------|-------------|
| 🔒 **Secure Storage** | Store API keys in a secure location |
| 🎯 **Least Privilege** | Use minimum required permissions |
| 🔄 **Key Rotation** | Rotate keys periodically |
| 📝 **Audit Trail** | All MCP operations are logged in panel system logs |

---

## 📚 Sources

| File | Description |
|------|-------------|
| `src/services/mcpService.js` | Tool registry |
| `src/routes/mcp.js` | MCP endpoints |
| `src/mcp/prompts.js` | Built-in prompts |
| `src/locales/en.json` | MCP interface localization |
