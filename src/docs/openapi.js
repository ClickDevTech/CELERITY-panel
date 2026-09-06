function applyReferenceDocsEnhancements(target) {
    addCommonSchemas(target);
    addCommonExamples(target);
    enhanceOperations(target);
}

function addCommonSchemas(target) {
    const schemas = target.components.schemas;
    Object.assign(schemas, {
        ApiError: schemas.Error,
        GroupInput: {
            type: 'object',
            description: 'Server group create/update payload. For update, only the provided fields change.',
            properties: {
                name: { type: 'string', example: 'Premium' },
                description: { type: 'string' },
                color: { type: 'string', example: '#6366f1', description: 'CSS color' },
                active: { type: 'boolean', default: true },
                maxDevices: { type: 'integer', example: 0, description: 'Default max devices for users in this group, 0 = unlimited' },
                subscriptionTitle: { type: 'string', description: 'Title shown in subscription clients' },
            },
        },
        Traffic: {
            type: 'object',
            description: 'Traffic counters in bytes.',
            properties: {
                tx: { type: 'integer', example: 1048576, description: 'Uploaded bytes' },
                rx: { type: 'integer', example: 2097152, description: 'Downloaded bytes' },
                used: { type: 'integer', example: 3145728, description: 'Total used bytes' },
                limit: { type: 'integer', example: 10737418240, description: 'Traffic limit in bytes, 0 = unlimited' },
            },
        },
        RateLimitError: {
            type: 'object',
            description: 'Rate-limit error response.',
            properties: {
                error: { type: 'string', example: 'Too many attempts. Try again in 15 minutes.' },
            },
        },
        VirtualConfig: {
            type: 'object',
            description: `Configuration for a **virtual** node — a load-balancer entry that
groups one or more real (\`hysteria\`/\`xray\`) sibling nodes into a single
"Auto" connection in the user's subscription.

Behaviour by client:
- **HAPP / Streisand / Xray-core based clients** — receive the balancer as
  an \`xray-json\` profile array entry with \`routing.balancers\` +
  (\`burstObservatory\` for \`leastPing\`/\`leastLoad\`).
- **sing-box / Hiddify / NekoBox** — \`type: urltest\` outbound over the
  source tags (Sing-box has no native round-robin).
- **Clash Meta / Mihomo** — \`url-test\` proxy-group (\`load-balance\` with
  \`strategy: consistent-hashing\` for \`random\`).
- **v2ray-json / plain URI list** — virtual nodes are skipped; only their
  source nodes appear individually.

Virtual nodes carry no IP/SSH/agent and never run health checks themselves.`,
            properties: {
                selectMode: {
                    type: 'string',
                    enum: ['manual', 'group'],
                    default: 'manual',
                    description: '`manual`: pick from `sources`. `group`: dynamically include every active node in `sourceGroup`.',
                },
                sources: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'HyNode `_id`s — required when `selectMode=manual`. Must reference real (non-virtual) nodes.',
                    example: ['64a1b2c3d4e5f6a7b8c9d0e2', '64a1b2c3d4e5f6a7b8c9d0e3'],
                },
                sourceGroup: {
                    type: 'string',
                    description: 'ServerGroup `_id` — required when `selectMode=group`.',
                },
                strategy: {
                    type: 'string',
                    enum: ['random', 'roundRobin', 'leastPing', 'leastLoad'],
                    default: 'leastLoad',
                    description: 'Xray balancer strategy. `leastPing`/`leastLoad` automatically enable a `burstObservatory`.',
                },
                fallbackToFirst: {
                    type: 'boolean',
                    default: true,
                    description: 'When true, sets `fallbackTag` to the first source so traffic still flows when all observed peers are unhealthy.',
                },
                observatory: {
                    type: 'object',
                    description: '`burstObservatory.pingConfig` parameters (Xray). Used by HAPP/Xray-core clients only; ignored by sing-box/Clash.',
                    properties: {
                        destination: { type: 'string', example: 'http://www.gstatic.com/generate_204', description: 'Probe URL — must return HTTP 204.' },
                        connectivity: { type: 'string', example: '', description: 'Local connectivity check URL — only probed when `destination` fails. Empty = disabled.' },
                        interval: { type: 'string', example: '1m', description: 'Probe interval (Xray time format, min `10s`).' },
                        timeout: { type: 'string', example: '5s', description: 'Probe timeout.' },
                        sampling: { type: 'integer', example: 3, description: 'Number of recent probe results to keep.' },
                    },
                },
            },
        },
        CdnConfig: {
            type: 'object',
            required: ['originNode'],
            description: 'Publishes one Xray WebSocket, gRPC, or XHTTP inbound through a generic CDN. At least one of `domain` or `edges` is required.',
            properties: {
                originNode: { type: 'string', description: 'ObjectId of the origin Xray node.' },
                originInboundId: { type: 'string', description: 'Extra inbound stable id. Empty selects the main inbound.' },
                domain: { type: 'string', example: 'cdn.example.com', description: 'Optional public CDN domain.' },
                edges: {
                    type: 'array',
                    maxItems: 32,
                    items: {
                        type: 'object',
                        required: ['id', 'address'],
                        properties: {
                            id: { type: 'string' },
                            label: { type: 'string' },
                            address: { type: 'string', description: 'Pinned edge IP or hostname.' },
                            enabled: { type: 'boolean', default: true },
                        },
                    },
                },
                port: { type: 'integer', minimum: 1, maximum: 65535, default: 443 },
                security: { type: 'string', enum: ['tls'], default: 'tls' },
                sni: { type: 'string', description: 'Required TLS server name. Defaults to domain.' },
                host: { type: 'string' },
                path: {
                    type: 'string',
                    description: 'Client path. Required for an XHTTP origin and must extend its prefix by at least one segment; for a WebSocket origin it must equal the origin path exactly.',
                },
                alpn: { type: 'array', items: { type: 'string', enum: ['h3', 'h2', 'http/1.1', 'http/1.0'] } },
                fingerprint: { type: 'string', default: 'chrome' },
                fingerprintPool: {
                    type: 'array',
                    uniqueItems: true,
                    items: { type: 'string' },
                    description: 'Optional TLS fingerprint pool. One value is selected per subscription-cache rebuild and overrides fingerprint.',
                },
                xhttpMode: { type: 'string', enum: ['', 'auto', 'packet-up', 'stream-up', 'stream-one'] },
            },
        },
        XrayConfig: {
            type: 'object',
            additionalProperties: true,
            description: 'Xray-specific settings. Client-facing inbounds bind publicly unless listen is overridden.',
            properties: {
                listen: {
                    type: 'string',
                    format: 'ip',
                    default: '0.0.0.0',
                    example: '127.0.0.1',
                    description: 'IPv4/IPv6 bind address for the main inbound.',
                },
                extraInbounds: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            listen: {
                                type: 'string',
                                format: 'ip',
                                default: '0.0.0.0',
                                example: '127.0.0.1',
                            },
                        },
                    },
                },
            },
        },
        NodeCreate: {
            type: 'object',
            required: ['name'],
            description: `Payload for creating a Hysteria, Xray, Virtual (load-balancer), or CDN node.

\`ip\` is **required** for \`hysteria\`/\`xray\` and omitted for \`virtual\`/\`cdn\`.
Serverless node types require their corresponding \`virtual\` or \`cdn\` object.`,
            properties: {
                name: { type: 'string', example: 'Germany 1', description: 'Display name shown in panel and subscriptions.' },
                ip: { type: 'string', example: '203.0.113.10', description: 'Server IP address. Required for hysteria/xray, ignored for serverless node types.' },
                type: { type: 'string', enum: ['hysteria', 'xray', 'virtual', 'cdn'], default: 'hysteria', description: 'Node type. `virtual` and `cdn` have no remote server.' },
                domain: { type: 'string', example: 'de.example.com', description: 'Public domain for TLS/SNI.' },
                sni: { type: 'string', example: 'de.example.com', description: 'Optional SNI override.' },
                port: { type: 'integer', example: 443, description: 'Main service port.' },
                portRange: { type: 'string', example: '20000-50000', description: 'UDP port hopping range.' },
                statsPort: { type: 'integer', example: 9999, description: 'Hysteria stats API port.' },
                groups: { type: 'array', items: { type: 'string' }, example: ['64a1b2c3d4e5f6a7b8c9d0e1'], description: 'Server group ObjectIds.' },
                maxOnlineUsers: { type: 'integer', example: 0, description: '0 = unlimited.' },
                ssh: { type: 'object', description: 'SSH credentials. Password or privateKey can be provided. Ignored for virtual nodes.' },
                xray: { $ref: '#/components/schemas/XrayConfig' },
                virtual: { $ref: '#/components/schemas/VirtualConfig' },
                cdn: { $ref: '#/components/schemas/CdnConfig' },
                cascadeRole: { type: 'string', enum: ['standalone', 'portal', 'bridge'], default: 'standalone', description: 'Always forced to `standalone` for virtual nodes.' },
                country: { type: 'string', example: 'DE' },
                comment: { type: 'string', maxLength: 500, example: 'Hetzner FSN1 — backup node', description: 'Free-form operator note shown in panel UI.' },
                rankingCoefficient: { type: 'number', example: 1 },
            },
        },
        NodeUpdate: {
            type: 'object',
            description: `Partial node update payload. Any omitted field is left unchanged.

When changing \`type\` to \`virtual\` or \`cdn\`, pass the corresponding config
object; the API clears \`ip\` automatically. Other node types require an IP, so
converting a serverless node back into a physical one must send \`ip\` in the
same request. A node still referenced by a cascade link cannot be converted.

\`xray\` and \`cdn\` are merged field by field. Secrets omitted from \`xray\`
(\`realityPrivateKey\`, \`realityPublicKey\`, \`manualKey\`) and settings
omitted from \`cdn\` are preserved.`,
            properties: {
                name: { type: 'string' },
                ip: { type: 'string', format: 'ip', description: 'Required when converting a virtual/CDN node back to hysteria or xray.' },
                domain: { type: 'string' },
                sni: { type: 'string' },
                port: { type: 'integer' },
                portRange: { type: 'string' },
                statsPort: { type: 'integer' },
                groups: { type: 'array', items: { type: 'string' } },
                ssh: { type: 'object' },
                paths: { type: 'object' },
                settings: { type: 'object' },
                active: { type: 'boolean' },
                rankingCoefficient: { type: 'number' },
                type: { type: 'string', enum: ['hysteria', 'xray', 'virtual', 'cdn'] },
                xray: { $ref: '#/components/schemas/XrayConfig' },
                virtual: { $ref: '#/components/schemas/VirtualConfig' },
                cdn: { $ref: '#/components/schemas/CdnConfig' },
                cascadeRole: { type: 'string' },
                country: { type: 'string' },
                comment: { type: 'string', maxLength: 500 },
                initScript: { type: 'string' },
            },
        },
        CascadeLinkCreate: {
            type: 'object',
            required: ['name', 'portalNodeId', 'bridgeNodeId'],
            description: 'Payload for creating a cascade tunnel between two Xray nodes.',
            properties: {
                name: { type: 'string', example: 'DE portal to NL bridge' },
                portalNodeId: { type: 'string', example: '64a1b2c3d4e5f6a7b8c9d0e1' },
                bridgeNodeId: { type: 'string', example: '64a1b2c3d4e5f6a7b8c9d0e2' },
                mode: { type: 'string', enum: ['reverse', 'forward'], default: 'reverse' },
                tunnelPort: { type: 'integer', example: 10086 },
                tunnelProtocol: { type: 'string', enum: ['vless', 'vmess'], default: 'vless' },
                tunnelSecurity: { type: 'string', enum: ['none', 'tls', 'reality'], default: 'none' },
                tunnelTransport: { type: 'string', enum: ['tcp', 'ws', 'grpc', 'xhttp', 'splithttp'], default: 'tcp' },
                autoDeploy: { type: 'boolean', example: false, description: 'Deploy the chain after creating the link.' },
            },
        },
        CascadeLinkUpdate: {
            type: 'object',
            description: 'Partial cascade link update payload.',
            properties: {
                name: { type: 'string' },
                mode: { type: 'string', enum: ['reverse', 'forward'] },
                tunnelPort: { type: 'integer' },
                tunnelDomain: { type: 'string' },
                tunnelProtocol: { type: 'string', enum: ['vless', 'vmess'] },
                tunnelSecurity: { type: 'string', enum: ['none', 'tls', 'reality'] },
                tunnelTransport: { type: 'string', enum: ['tcp', 'ws', 'grpc', 'xhttp', 'splithttp'] },
                active: { type: 'boolean' },
                priority: { type: 'integer' },
                autoRedeploy: { type: 'boolean' },
            },
        },
        McpToolListResponse: {
            type: 'object',
            properties: {
                tools: { type: 'array', items: { type: 'object' } },
            },
        },
        McpPromptListResponse: {
            type: 'object',
            properties: {
                prompts: { type: 'array', items: { type: 'object' } },
            },
        },
        NodeUserSummary: {
            type: 'object',
            description: 'Subset of user fields returned by GET /nodes/{id}/users',
            properties: {
                userId: { type: 'string', example: '123456789' },
                username: { type: 'string', example: 'JohnDoe' },
                traffic: { $ref: '#/components/schemas/Traffic' },
            },
        },
    });

    schemas.User.properties.traffic = { $ref: '#/components/schemas/Traffic' };
    schemas.SubscriptionInfo.properties.traffic = { $ref: '#/components/schemas/Traffic' };
}

function addCommonExamples(target) {
    target.components.examples = {
        ErrorAuth: {
            summary: 'Authentication error',
            value: { error: 'Authentication required' },
        },
        ErrorScope: {
            summary: 'Scope error',
            value: { error: 'Insufficient permissions', required: 'users:write' },
        },
        ErrorRateLimit: {
            summary: 'Rate limit error',
            value: { error: 'Too many attempts. Try again in 15 minutes.' },
        },
        LoginRequest: {
            summary: 'Admin login request',
            value: { username: 'admin', password: 'change-me' },
        },
        TotpRequest: {
            summary: 'TOTP verification request',
            value: { token: '123456' },
        },
        LoginResponse: {
            summary: 'Admin login response (200)',
            value: { success: true, username: 'admin', message: 'Authentication successful. Use cookies for subsequent requests.' },
        },
        LoginPendingResponse: {
            summary: 'Admin login pending TOTP (202)',
            value: { success: false, requiresTwoFactor: true, message: 'Two-factor verification required' },
        },
        LogoutResponse: {
            summary: 'Logout response',
            value: { success: true },
        },
        NodeAuthOkResponse: {
            summary: 'Node auth accepted',
            value: { ok: true, id: '123456789' },
        },
        NodeAuthFailResponse: {
            summary: 'Node auth rejected',
            value: { ok: false },
        },
        UserUpdateRequest: {
            summary: 'Update user fields',
            value: {
                enabled: false,
                maxDevices: 3,
                hwidMode: 'strict',
                trafficLimit: 10737418240,
            },
        },
        UserListResponse: {
            summary: 'Paginated users',
            value: {
                users: [{ userId: '123456789', username: 'JohnDoe', enabled: true, traffic: { tx: 0, rx: 0 } }],
                pagination: { page: 1, limit: 50, total: 1, pages: 1 },
            },
        },
        NodeUsersOnNodeResponse: {
            summary: 'Users on a node',
            value: [{ userId: '123456789', username: 'JohnDoe', traffic: { tx: 1024, rx: 2048 } }],
        },
        SyncFromMainResponse: {
            summary: 'Bulk sync result',
            value: { created: 2, updated: 5, errors: 0 },
        },
        NodeSetupSuccessResponse: {
            summary: 'Node setup completed',
            value: { success: true, logs: ['Installing Hysteria...', 'Restarting hysteria-server'] },
        },
        NodeDeleteResponse: {
            summary: 'Node deleted',
            value: { success: true, message: 'Нода удалена' },
        },
        KickResponse: {
            summary: 'User kicked',
            value: { success: true },
        },
        SyncStartedResponse: {
            summary: 'Sync started',
            value: { message: 'Sync started' },
        },
        UserCreateRequest: {
            summary: 'Create an enabled user',
            value: {
                userId: '123456789',
                username: 'JohnDoe',
                enabled: true,
                groups: ['64a1b2c3d4e5f6a7b8c9d0e1'],
                trafficLimit: 10737418240,
                maxDevices: 1,
                expireAt: '2026-12-31T23:59:59.000Z',
            },
        },
        UserResponse: {
            summary: 'User response',
            value: {
                _id: '64a1b2c3d4e5f6a7b8c9d0e9',
                userId: '123456789',
                username: 'JohnDoe',
                password: 'aB3xK9mP2q',
                xrayUuid: '550e8400-e29b-41d4-a716-446655440000',
                enabled: true,
                groups: [{ _id: '64a1b2c3d4e5f6a7b8c9d0e1', name: 'Default', color: '#6366f1' }],
                nodes: [],
                trafficLimit: 10737418240,
                maxDevices: 3,
                hwidMode: 'inherit',
                subscriptionToken: 'abc123def456',
                traffic: { tx: 0, rx: 0 },
                expireAt: '2026-12-31T23:59:59.000Z',
                createdAt: '2026-05-18T17:00:00.000Z',
                updatedAt: '2026-05-18T17:00:00.000Z',
            },
        },
        NodeCreateRequest: {
            summary: 'Create a Hysteria node',
            value: {
                name: 'Germany 1',
                ip: '203.0.113.10',
                type: 'hysteria',
                domain: 'de.example.com',
                port: 443,
                portRange: '20000-50000',
                groups: ['64a1b2c3d4e5f6a7b8c9d0e1'],
            },
        },
        NodeCreateVirtualRequest: {
            summary: 'Create a virtual (load-balancer) node',
            description: 'No `ip`/`ssh` required. Lists three real sibling nodes, balances by least observed latency.',
            value: {
                name: 'Auto · EU',
                type: 'virtual',
                groups: ['64a1b2c3d4e5f6a7b8c9d0e1'],
                country: 'EU',
                virtual: {
                    selectMode: 'manual',
                    sources: ['64a1b2c3d4e5f6a7b8c9d0e2', '64a1b2c3d4e5f6a7b8c9d0e3', '64a1b2c3d4e5f6a7b8c9d0e4'],
                    strategy: 'leastPing',
                    fallbackToFirst: true,
                    observatory: {
                        destination: 'http://www.gstatic.com/generate_204',
                        interval: '1m',
                        timeout: '5s',
                        sampling: 3,
                    },
                },
            },
        },
        NodeCreateVirtualGroupRequest: {
            summary: 'Create a virtual node tied to a server group',
            description: 'In `group` mode the source list is recomputed dynamically: any active node currently in the referenced group is included.',
            value: {
                name: 'Auto · Premium pool',
                type: 'virtual',
                virtual: {
                    selectMode: 'group',
                    sourceGroup: '64a1b2c3d4e5f6a7b8c9d0e1',
                    strategy: 'leastLoad',
                },
            },
        },
        NodeUpdateRequest: {
            summary: 'Update node fields',
            value: {
                domain: 'de.example.com',
                port: 443,
                active: true,
                groups: ['64a1b2c3d4e5f6a7b8c9d0e1'],
            },
        },
        NodeResponse: {
            summary: 'Node response',
            value: {
                _id: '64a1b2c3d4e5f6a7b8c9d0e2',
                name: 'Germany 1',
                ip: '203.0.113.10',
                type: 'hysteria',
                domain: 'de.example.com',
                port: 443,
                portRange: '20000-50000',
                active: true,
                status: 'online',
                onlineUsers: 12,
                traffic: { tx: 1048576, rx: 2097152 },
            },
        },
        CascadeLinkRequest: {
            summary: 'Create a cascade link',
            value: {
                name: 'DE portal to NL bridge',
                portalNodeId: '64a1b2c3d4e5f6a7b8c9d0e2',
                bridgeNodeId: '64a1b2c3d4e5f6a7b8c9d0e3',
                mode: 'reverse',
                tunnelPort: 10086,
                tunnelProtocol: 'vless',
                tunnelTransport: 'tcp',
            },
        },
        CascadeLinkResponse: {
            summary: 'Cascade link response',
            value: {
                _id: '64a1b2c3d4e5f6a7b8c9d0e4',
                name: 'DE portal to NL bridge',
                mode: 'reverse',
                tunnelPort: 10086,
                tunnelProtocol: 'vless',
                tunnelTransport: 'tcp',
                active: true,
                status: 'pending',
            },
        },
        StatsResponse: {
            summary: 'Panel stats',
            value: {
                users: { total: 1234, enabled: 987 },
                nodes: { total: 9, online: 8 },
                onlineUsers: 639,
                nodesList: [{ name: 'Germany 1', online: 42 }],
                lastSync: '2026-05-18T17:00:00.000Z',
            },
        },
        SuccessResponse: {
            summary: 'Success only',
            value: { success: true },
        },
        SuccessWithMessageResponse: {
            summary: 'Success with message',
            value: { success: true, message: 'Пользователь удалён' },
        },
        GroupsListResponse: {
            summary: 'Groups list',
            value: [{ _id: '64a1b2c3d4e5f6a7b8c9d0e1', name: 'Default' }],
        },
        NodesListResponse: {
            summary: 'Nodes list',
            value: [{ _id: '64a1b2c3d4e5f6a7b8c9d0e2', name: 'Germany 1', type: 'hysteria', ip: '203.0.113.10', status: 'online', active: true }],
        },
        CascadeLinksListResponse: {
            summary: 'Cascade links list',
            value: [{ _id: '64a1b2c3d4e5f6a7b8c9d0e4', name: 'DE portal to NL bridge', status: 'pending', active: true }],
        },
        NodeSyncStartedResponse: {
            summary: 'Node sync started',
            value: { success: true, message: 'Синхронизация запущена' },
        },
        NodeResetStatusResponse: {
            summary: 'Node status reset',
            value: { success: true, message: 'Статус сброшен', node: { _id: '64a1b2c3d4e5f6a7b8c9d0e2', name: 'Germany 1', status: 'online' } },
        },
        ConfigUpdatedResponse: {
            summary: 'Config updated on node',
            value: { success: true, message: 'Конфиг обновлён' },
        },
        PortHoppingConfiguredResponse: {
            summary: 'Port hopping configured',
            value: { success: true, message: 'Port hopping настроен' },
        },
        UserDeviceListExample: {
            summary: 'HWID device list',
            value: {
                userId: '123456789',
                count: 1,
                limit: 3,
                devices: [{ hwid: 'abc123', platform: 'Android', lastSeenAt: '2026-05-18T17:00:00.000Z' }],
            },
        },
        CascadeDeployResponse: {
            summary: 'Cascade link deployed',
            value: { success: true, message: 'Cascade link deployed' },
        },
        CascadeUndeployResponse: {
            summary: 'Cascade link undeployed',
            value: { success: true, message: 'Cascade link undeployed' },
        },
        CascadeDeleteResponse: {
            summary: 'Cascade link deleted',
            value: { success: true, message: 'Cascade link deleted' },
        },
        CascadeChainDeployResponse: {
            summary: 'Cascade chain deployed',
            value: { success: true, message: 'Chain deployed: 3 nodes', deployed: 3 },
        },
        NodeStatusResponse: {
            summary: 'Stored node status',
            value: {
                name: 'Germany 1',
                status: 'online',
                onlineUsers: 12,
                lastError: '',
                lastSync: '2026-05-18T17:00:00.000Z',
                load: { txMbps: 12.4, rxMbps: 87.1, updatedAt: '2026-05-18T17:00:00.000Z' },
            },
        },
        McpToolsResponse: {
            summary: 'MCP tools list',
            value: { tools: [{ name: 'list_users', description: 'List panel users' }] },
        },
        McpPromptsResponse: {
            summary: 'MCP prompts list',
            value: { prompts: [{ name: 'panel_overview', description: 'Panel overview prompt' }] },
        },
        JsonRpcToolsListRequest: {
            summary: 'List MCP tools',
            value: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        },
        JsonRpcResponse: {
            summary: 'JSON-RPC response',
            value: { jsonrpc: '2.0', id: 1, result: {} },
        },
        GenericResponse: {
            summary: 'Generic JSON response',
            value: { success: true },
        },
    };
}

const OPERATION_METADATA = {
    'POST /login': {
        public: true,
        rateLimit: '10 attempts per 15 minutes',
        requestExample: 'LoginRequest',
        responseExamples: { 200: 'LoginResponse', 202: 'LoginPendingResponse' },
    },
    'POST /login/totp': {
        public: true,
        rateLimit: '8 attempts per 10 minutes',
        requestExample: 'TotpRequest',
        responseExample: 'LoginResponse',
    },
    'POST /logout': { public: true, responseExample: 'LogoutResponse' },
    'POST /auth': { public: true, skipGenericExamples: true },
    'GET /files/{token}': { public: true, rateLimit: 'Configured by subscription rate limit settings' },
    'GET /info/{token}': { public: true, rateLimit: 'Configured by subscription rate limit settings' },
    'GET /stats': { scopes: ['stats:read'], responseExample: 'StatsResponse' },
    'GET /groups': { scopes: ['stats:read'], responseExample: 'GroupsListResponse' },
    'GET /users': { scopes: ['users:read'], responseExample: 'UserListResponse' },
    'POST /users': { scopes: ['users:write'], requestExample: 'UserCreateRequest', responseExample: 'UserResponse' },
    'POST /users/bulk-delete': { scopes: ['users:write'], responseExample: 'GenericResponse' },
    'GET /users/{userId}': { scopes: ['users:read'], responseExample: 'UserResponse' },
    'PUT /users/{userId}': { scopes: ['users:write'], requestExample: 'UserUpdateRequest', responseExample: 'UserResponse' },
    'DELETE /users/{userId}': { scopes: ['users:write'], responseExample: 'SuccessWithMessageResponse' },
    'GET /users/{userId}/devices': { scopes: ['users:read'], responseExample: 'UserDeviceListExample' },
    'DELETE /users/{userId}/devices': { scopes: ['users:write'], responseExample: 'SuccessResponse' },
    'DELETE /users/{userId}/devices/{hwid}': { scopes: ['users:write'], responseExample: 'SuccessResponse' },
    'POST /users/{userId}/enable': { scopes: ['users:write'], responseExample: 'UserResponse' },
    'POST /users/{userId}/disable': { scopes: ['users:write'], responseExample: 'UserResponse' },
    'POST /users/{userId}/groups': { scopes: ['users:write'], responseExample: 'UserResponse' },
    'DELETE /users/{userId}/groups/{groupId}': { scopes: ['users:write'], responseExample: 'UserResponse' },
    'POST /users/sync-from-main': { scopes: ['users:write'], responseExample: 'SyncFromMainResponse' },
    'GET /nodes': { scopes: ['nodes:read'], responseExample: 'NodesListResponse' },
    'POST /nodes': { scopes: ['nodes:write'], requestExample: 'NodeCreateRequest', responseExample: 'NodeResponse' },
    'GET /nodes/check-ip': { scopes: ['nodes:read'] },
    'GET /nodes/{id}': { scopes: ['nodes:read'], responseExample: 'NodeResponse' },
    'PUT /nodes/{id}': { scopes: ['nodes:write'], requestExample: 'NodeUpdateRequest', responseExample: 'NodeResponse' },
    'DELETE /nodes/{id}': { scopes: ['nodes:write'], responseExample: 'NodeDeleteResponse' },
    'GET /nodes/{id}/status': { scopes: ['nodes:read'], responseExample: 'NodeStatusResponse', skipGenericExamples: true },
    'POST /nodes/{id}/reset-status': { scopes: ['nodes:write'], responseExample: 'NodeResetStatusResponse', skipGenericExamples: true },
    'GET /nodes/{id}/agent-info': { scopes: ['nodes:read'] },
    'POST /nodes/{id}/sync': { scopes: ['nodes:write'], responseExample: 'NodeSyncStartedResponse' },
    'POST /nodes/{id}/setup': { scopes: ['nodes:write'], responseExample: 'NodeSetupSuccessResponse', skipGenericExamples: true },
    'GET /nodes/{id}/config': { scopes: ['nodes:read'] },
    'GET /nodes/{id}/users': { scopes: ['nodes:read'], responseExample: 'NodeUsersOnNodeResponse' },
    'POST /nodes/{id}/groups': { scopes: ['nodes:write'], responseExample: 'NodeResponse' },
    'DELETE /nodes/{id}/groups/{groupId}': { scopes: ['nodes:write'], responseExample: 'NodeResponse' },
    'POST /nodes/{id}/setup-port-hopping': { scopes: ['nodes:write'], responseExample: 'PortHoppingConfiguredResponse' },
    'POST /nodes/{id}/update-config': { scopes: ['nodes:write'], responseExample: 'ConfigUpdatedResponse' },
    'GET /cascade/links': { scopes: ['nodes:read'], responseExample: 'CascadeLinksListResponse' },
    'POST /cascade/links': { scopes: ['nodes:write'], requestExample: 'CascadeLinkRequest', responseExample: 'CascadeLinkResponse' },
    'GET /cascade/links/{id}': { scopes: ['nodes:read'], responseExample: 'CascadeLinkResponse' },
    'PUT /cascade/links/{id}': { scopes: ['nodes:write'], requestExample: 'CascadeLinkRequest', responseExample: 'CascadeLinkResponse' },
    'PATCH /cascade/links/{id}/reconnect': { scopes: ['nodes:write'], responseExample: 'CascadeLinkResponse' },
    'DELETE /cascade/links/{id}': { scopes: ['nodes:write'], responseExample: 'CascadeDeleteResponse' },
    'POST /cascade/links/{id}/deploy': { scopes: ['nodes:write'], rateLimit: '10 deploy requests per minute', responseExample: 'CascadeDeployResponse', skipGenericExamples: true },
    'POST /cascade/links/{id}/undeploy': { scopes: ['nodes:write'], rateLimit: '10 deploy requests per minute', responseExample: 'CascadeUndeployResponse', skipGenericExamples: true },
    'POST /cascade/chain/deploy': { scopes: ['nodes:write'], rateLimit: '10 deploy requests per minute', responseExample: 'CascadeChainDeployResponse', skipGenericExamples: true },
    'GET /cascade/links/{id}/health': { scopes: ['nodes:read'] },
    'GET /cascade/topology': { scopes: ['nodes:read'] },
    'POST /cascade/topology/positions': { scopes: ['nodes:write'], responseExample: 'SuccessResponse' },
    'POST /mcp': { scopes: ['mcp:enabled'], requestExample: 'JsonRpcToolsListRequest', responseExample: 'JsonRpcResponse' },
    'GET /mcp/sse': { scopes: ['mcp:enabled'] },
    'POST /mcp/messages': { scopes: ['mcp:enabled'], requestExample: 'JsonRpcToolsListRequest' },
    'GET /mcp/tools': { scopes: ['mcp:enabled'], responseExample: 'McpToolsResponse', skipGenericExamples: true },
    'GET /mcp/prompts': { scopes: ['mcp:enabled'], responseExample: 'McpPromptsResponse', skipGenericExamples: true },
    'POST /sync': { scopes: ['sync:write'], responseExample: 'SyncStartedResponse' },
    'POST /kick/{userId}': { scopes: ['sync:write'], responseExample: 'KickResponse' },
};

function enhanceOperations(target) {
    for (const [path, pathItem] of Object.entries(target.paths)) {
        for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
            const op = pathItem[method];
            if (!op) continue;

            const key = `${method.toUpperCase()} ${path}`;
            const meta = OPERATION_METADATA[key] || {};
            applySecurity(op, meta);
            applyDescriptions(op, key, meta);
            applyRequestExample(op, meta);
            applyResponseExamples(op, meta);
            applyCodeSamples(op, method, path, meta);
        }
    }
}

function applySecurity(op, meta) {
    if (meta.public || Array.isArray(op.security) && op.security.length === 0) {
        op.security = [];
        return;
    }
    op.security = [{ ApiKeyHeader: [] }, { BearerToken: [] }, { CookieSession: [] }];
    if (meta.scopes) {
        op['x-requiredScopes'] = meta.scopes;
    }
}

function applyDescriptions(op, key, meta) {
    if (!op.description) {
        const scopeText = meta.scopes ? ` Requires scope: \`${meta.scopes.join('` or `')}\`.` : '';
        op.description = `${op.summary}.${scopeText}`.trim();
    } else if (meta.scopes && !op.description.includes('Requires scope:')) {
        op.description = `${op.description}\n\nRequires scope: \`${meta.scopes.join('` or `')}\`.`;
    }
    if (meta.rateLimit) {
        op['x-rateLimit'] = meta.rateLimit;
        if (!op.description.includes('Rate limit:')) {
            op.description = `${op.description}\n\nRate limit: ${meta.rateLimit}.`;
        }
    }
    op.operationId = op.operationId || operationIdFromKey(key);
}

function applyRequestExample(op, meta) {
    const media = op.requestBody?.content?.['application/json'];
    if (!media) return;
    const exampleName = meta.requestExample;
    if (exampleName && spec.components.examples[exampleName]) {
        media.examples = { [exampleName]: { $ref: `#/components/examples/${exampleName}` } };
    } else if (!media.example && !media.examples) {
        media.example = {};
    }
}

function applyResponseExamples(op, meta) {
    for (const [status, response] of Object.entries(op.responses || {})) {
        const json = response.content?.['application/json'];
        if (!json || !String(status).startsWith('2')) continue;

        if (json.examples && Object.keys(json.examples).length > 0) {
            continue;
        }

        const perStatus = meta.responseExamples?.[status] || meta.responseExamples?.[String(status)];
        const exampleName = perStatus || (status === '200' || status === '201' ? meta.responseExample : null);

        if (exampleName && spec.components.examples[exampleName]) {
            json.examples = { [exampleName]: { $ref: `#/components/examples/${exampleName}` } };
            continue;
        }

        if (meta.skipGenericExamples || hasSpecificResponseSchema(json)) {
            continue;
        }

        if (!json.examples && json.example === undefined) {
            json.examples = { GenericResponse: { $ref: '#/components/examples/GenericResponse' } };
        }
    }
}

function hasSpecificResponseSchema(json) {
    const schema = json.schema;
    if (!schema) return false;
    if (schema.type === 'array') return true;
    if (schema.$ref && !schema.$ref.endsWith('/Success')) return true;
    const props = schema.properties;
    if (!props) return false;
    const keys = Object.keys(props);
    if (keys.includes('ok') || keys.includes('users') || keys.includes('logs') || keys.includes('created')) return true;
    if (keys.includes('jsonrpc') || keys.includes('tools') || keys.includes('prompts')) return true;
    if (keys.includes('privateKey') || keys.includes('publicKey') || keys.includes('node')) return true;
    return false;
}

function applyCodeSamples(op, method, path, meta) {
    const publicEndpoint = meta.public || Array.isArray(op.security) && op.security.length === 0;
    const fullPath = `/api${path}`.replace(/\{([^}]+)\}/g, (_, name) => examplePathValue(name));
    const authHeader = publicEndpoint ? '' : " \\\n  -H 'X-API-Key: ck_your_key_here'";
    const body = op.requestBody ? " \\\n  -H 'Content-Type: application/json' \\\n  -d '{}'" : '';
    op['x-codeSamples'] = [
        {
            lang: 'cURL',
            label: 'cURL',
            source: `curl -X ${method.toUpperCase()} 'https://your-domain${fullPath}'${authHeader}${body}`,
        },
        {
            lang: 'JavaScript',
            label: 'Node.js',
            source: buildNodeSample(method, fullPath, publicEndpoint, !!op.requestBody),
        },
    ];
}

function buildNodeSample(method, path, publicEndpoint, hasBody) {
    const lines = [
        `const res = await fetch('https://your-domain${path}', {`,
        `  method: '${method.toUpperCase()}',`,
        '  headers: {',
    ];
    if (!publicEndpoint) lines.push("    'X-API-Key': 'ck_your_key_here',");
    if (hasBody) lines.push("    'Content-Type': 'application/json',");
    lines.push('  },');
    if (hasBody) lines.push('  body: JSON.stringify({}),');
    lines.push('});', 'const data = await res.json();');
    return lines.join('\n');
}

function examplePathValue(name) {
    if (name === 'token') return 'abc123def456';
    if (name === 'userId') return '123456789';
    if (name === 'hwid') return 'device-hwid';
    if (name === 'groupId') return '64a1b2c3d4e5f6a7b8c9d0e1';
    return '64a1b2c3d4e5f6a7b8c9d0e2';
}

function operationIdFromKey(key) {
    return key
        .toLowerCase()
        .replace(/[^a-z0-9{}]+/g, ' ')
        .replace(/\{([^}]+)\}/g, '$1')
        .trim()
        .split(/\s+/)
        .map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1))
        .join('');
}

/**
 * OpenAPI 3.0 specification for C³ CELERITY API
 *
 * buildSpec(lang) applies optional i18n translations on top of the base English spec.
 * Supported langs: 'en' (default), 'ru'
 */

const { version } = require('../../package.json');
const i18n = require('./i18n');

const spec = {
    openapi: '3.0.3',
    info: {
        title: 'C³ CELERITY API',
        version,
        description: `
Management API for [C³ CELERITY](https://github.com/ClickDevTech/hysteria-panel) — Hysteria 2 panel by Click Connect.

## Common Use Cases

1. Create a user with \`POST /users\`, then return \`subscriptionToken\` as \`https://your-domain/api/files/{token}\`.
2. Add a node with \`POST /nodes\`, then provision it with \`POST /nodes/{id}/setup\`.
3. Read panel totals with \`GET /stats\` and node health with \`GET /nodes/{id}/status\`.
4. Disable an expired user with \`POST /users/{userId}/disable\` and clear devices with \`DELETE /users/{userId}/devices\`.
5. Build multi-hop routing with \`POST /cascade/links\`, then deploy with \`POST /cascade/chain/deploy\`.
6. Group several real nodes into a single auto-balancer entry with \`POST /nodes\` (\`type=virtual\`); HAPP/Xray-core clients receive an Xray balancer + observatory profile, sing-box/Clash get a \`urltest\`/\`url-test\` group.
7. Automate panel actions through MCP using \`POST /mcp\` and \`tools/list\`.

## Authentication

Protected \`/api/*\` endpoints require authentication via an **API key** or an admin session cookie.
\`/api/auth\`, \`/api/files\`, \`/api/info\`, \`/api/login\`, \`/api/login/totp\`, and \`/api/logout\` do not require an API key.

Create keys in: **Panel → Settings → Security → API Keys**

\`\`\`
X-API-Key: ck_your_key_here
\`\`\`
or
\`\`\`
Authorization: Bearer ck_your_key_here
\`\`\`

## Scopes

| Scope | Access |
|-------|--------|
| \`users:read\` | Read users |
| \`users:write\` | Create / update / delete users |
| \`nodes:read\` | Read nodes |
| \`nodes:write\` | Create / update / delete / sync nodes |
| \`stats:read\` | Stats and groups |
| \`sync:write\` | Trigger sync, kick users |
| \`mcp:enabled\` | MCP JSON-RPC endpoint |

Admin sessions (cookie) bypass scope checks entirely.

## Rate Limits

- API keys have their own per-minute limit configured when the key is created (default: 60/min).
- \`POST /login\`: 10 attempts per 15 minutes.
- \`POST /login/totp\`: 8 attempts per 10 minutes.
- \`/files/{token}\` and \`/info/{token}\`: controlled by subscription rate limit settings.
- Cascade deploy operations: 10 deploy requests per minute.

## Errors

Errors use JSON whenever the endpoint is JSON-based:

\`\`\`json
{ "error": "Authentication required" }
\`\`\`

Common status codes: \`400\` invalid input, \`401\` unauthenticated, \`403\` missing scope or blocked IP, \`404\` not found, \`409\` conflict, \`429\` rate-limited, \`500\` internal failure.

Many validation and not-found messages are returned in Russian (e.g. \`userId обязателен\`, \`Пользователь не найден\`). The \`error\` field shape is always the same.

**Production note:** when \`NODE_ENV !== 'development'\` the panel sanitizes all \`5xx\` responses to \`{ "error": "Internal Server Error" }\` regardless of the original message. The \`5xx\` examples in this reference reflect development output; production callers should treat all \`5xx\` bodies as opaque.

## Non-API endpoints

These endpoints are not under \`/api\` and are not part of this specification:

- \`GET /health\` — public health check (returns \`{ status, uptime, lastSync, isSyncing, cache }\`) used by monitoring; no auth.
- \`GET /\`, \`HEAD /\` — public landing/decoy page (configurable per installation).
- \`/panel/*\` — admin web UI (cookie session, HTML).
- \`/ws/terminal/{nodeId}\`, \`/ws/logs\`, \`/ws/broadcast\` — admin-only WebSocket transports (cookie session).
        `.trim(),
        contact: {
            name: 'Click Connect',
            url: 'https://github.com/ClickDevTech/hysteria-panel',
        },
        license: {
            name: 'MIT',
            url: 'https://github.com/ClickDevTech/hysteria-panel/blob/main/LICENSE',
        },
    },

    servers: [
        { url: '/api', description: 'Current server' },
    ],

    components: {
        securitySchemes: {
            ApiKeyHeader: {
                type: 'apiKey',
                in: 'header',
                name: 'X-API-Key',
                description: 'API key in `X-API-Key` header',
            },
            BearerToken: {
                type: 'http',
                scheme: 'bearer',
                description: 'API key as Bearer token',
            },
            CookieSession: {
                type: 'apiKey',
                in: 'cookie',
                name: 'connect.sid',
                description: 'Admin session cookie returned by `/api/login`',
            },
        },

        schemas: {
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string', example: 'Authentication required' },
                },
            },
            ScopeError: {
                type: 'object',
                properties: {
                    error: { type: 'string', example: 'Insufficient permissions' },
                    required: { type: 'string', example: 'users:write' },
                },
            },
            Pagination: {
                type: 'object',
                properties: {
                    page:  { type: 'integer', example: 1 },
                    limit: { type: 'integer', example: 50 },
                    total: { type: 'integer', example: 1234 },
                    pages: { type: 'integer', example: 25 },
                },
            },
            User: {
                type: 'object',
                properties: {
                    _id:               { type: 'string', example: '64a1b2c3d4e5f6a7b8c9d0e1' },
                    userId:            { type: 'string', example: '123456789' },
                    username:          { type: 'string', example: 'JohnDoe' },
                    comment:           { type: 'string', maxLength: 500, example: 'VIP, paid till June', description: 'Free-form operator note shown in panel UI. Not used in auth.' },
                    password:          { type: 'string', description: 'VPN password (auto-generated on create; returned on read/write responses)' },
                    xrayUuid:          { type: 'string', format: 'uuid', description: 'VLESS UUID for Xray nodes' },
                    enabled:           { type: 'boolean', example: true },
                    groups:            { type: 'array', items: { $ref: '#/components/schemas/GroupRef' } },
                    nodes:             { type: 'array', items: { $ref: '#/components/schemas/NodeRef' } },
                    trafficLimit:      { type: 'integer', example: 10737418240, description: 'Bytes, 0 = unlimited' },
                    maxDevices:        { type: 'integer', example: 3, description: '0 = from group, -1 = unlimited' },
                    hwidMode:          { type: 'string', enum: ['inherit', 'off', 'strict'], description: 'Override panel HWID mode' },
                    hwidEnforceFrom:   { type: 'string', format: 'date-time', nullable: true, description: 'Start enforcing HWID limit at this time (optional)' },
                    expireAt:          { type: 'string', format: 'date-time', nullable: true },
                    subscriptionToken: { type: 'string', example: 'abc123def456' },
                    traffic: {
                        type: 'object',
                        properties: {
                            tx: { type: 'integer', description: 'Bytes uploaded' },
                            rx: { type: 'integer', description: 'Bytes downloaded' },
                        },
                    },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' },
                },
            },
            UserCreate: {
                type: 'object',
                required: ['userId'],
                properties: {
                    userId:       { type: 'string', example: '123456789', description: 'Unique user ID (e.g. Telegram ID)' },
                    username:     { type: 'string', example: 'JohnDoe' },
                    comment:      { type: 'string', maxLength: 500, description: 'Free-form operator note (panel only).' },
                    enabled:      { type: 'boolean', default: false },
                    groups:       { type: 'array', items: { type: 'string' }, example: [] },
                    trafficLimit: { type: 'integer', example: 0, description: 'Bytes, 0 = unlimited' },
                    maxDevices:   { type: 'integer', example: 0, description: '0 = from min of groups, -1 = unlimited' },
                    expireAt:     { type: 'string', format: 'date-time', nullable: true },
                },
            },
            UserUpdate: {
                type: 'object',
                properties: {
                    username:     { type: 'string' },
                    comment:      { type: 'string', maxLength: 500 },
                    enabled:      { type: 'boolean' },
                    groups:       { type: 'array', items: { type: 'string' } },
                    trafficLimit: { type: 'integer' },
                    maxDevices:   { type: 'integer', description: '0 = from min of groups, -1 = unlimited' },
                    expireAt:     { type: 'string', format: 'date-time', nullable: true },
                    hwidMode:     { type: 'string', enum: ['inherit', 'off', 'strict'] },
                    hwidEnforceFrom: { type: 'string', format: 'date-time', nullable: true },
                },
            },
            UserDevice: {
                type: 'object',
                properties: {
                    _id:         { type: 'string' },
                    userId:      { type: 'string' },
                    hwid:        { type: 'string' },
                    platform:    { type: 'string' },
                    osVersion:   { type: 'string' },
                    deviceModel: { type: 'string' },
                    userAgent:   { type: 'string' },
                    firstSeenAt: { type: 'string', format: 'date-time' },
                    lastSeenAt:  { type: 'string', format: 'date-time' },
                },
            },
            UserDeviceListResponse: {
                type: 'object',
                properties: {
                    userId:  { type: 'string' },
                    count:   { type: 'integer' },
                    limit:   { type: 'integer', description: 'Effective maxDevices for HWID (same rules as auth)' },
                    devices: { type: 'array', items: { $ref: '#/components/schemas/UserDevice' } },
                },
            },
            Node: {
                type: 'object',
                properties: {
                    _id:           { type: 'string', example: '64a1b2c3d4e5f6a7b8c9d0e1' },
                    name:          { type: 'string', example: 'Germany' },
                    comment:       { type: 'string', example: 'Hetzner FSN1 — backup node', description: 'Free-form operator note shown in panel UI.' },
                    ip:            { type: 'string', example: '1.2.3.4' },
                    domain:        { type: 'string', example: 'de.example.com' },
                    port:          { type: 'integer', example: 443 },
                    portRange:     { type: 'string', example: '20000-50000' },
                    status:        { type: 'string', enum: ['online', 'offline', 'error', 'syncing'], example: 'online' },
                    active:        { type: 'boolean', example: true },
                    onlineUsers:   { type: 'integer', example: 42 },
                    maxOnlineUsers: { type: 'integer', example: 200, description: '0 = unlimited' },
                    groups:        { type: 'array', items: { $ref: '#/components/schemas/GroupRef' } },
                    lastSync:      { type: 'string', format: 'date-time', nullable: true },
                    lastError:     { type: 'string', example: '' },
                    traffic: {
                        type: 'object',
                        properties: {
                            tx: { type: 'integer', description: 'Total uploaded bytes (all-time)' },
                            rx: { type: 'integer', description: 'Total downloaded bytes (all-time)' },
                            txMbps: { type: 'number', example: 12.4, description: 'Average upload load in Mbit/s since the previous stats poll (~5 min window, not instantaneous)' },
                            rxMbps: { type: 'number', example: 87.1, description: 'Average download load in Mbit/s since the previous stats poll (~5 min window, not instantaneous)' },
                            speedUpdatedAt: { type: 'string', format: 'date-time', nullable: true, description: 'When txMbps/rxMbps were last computed' },
                        },
                    },
                    // Hysteria 2 advanced configuration
                    hopInterval:            { type: 'string', example: '30s', description: 'Port-hopping interval' },
                    ignoreClientBandwidth:  { type: 'boolean', example: false },
                    speedTest:              { type: 'boolean', example: false },
                    disableUDP:             { type: 'boolean', example: false },
                    udpIdleTimeout:         { type: 'string', example: '60s' },
                    acme: {
                        type: 'object',
                        properties: {
                            email:       { type: 'string' },
                            ca:          { type: 'string', example: 'letsencrypt' },
                            listenHost:  { type: 'string', example: '0.0.0.0' },
                            type:        { type: 'string', enum: ['', 'http', 'tls', 'dns'] },
                            httpAltPort: { type: 'integer', example: 0 },
                            tlsAltPort:  { type: 'integer', example: 0 },
                            dnsName:     { type: 'string' },
                            dnsConfig:   { type: 'object' },
                        },
                    },
                    masquerade: {
                        type: 'object',
                        properties: {
                            type: { type: 'string', enum: ['proxy', 'string'], example: 'proxy' },
                            proxy: {
                                type: 'object',
                                properties: {
                                    url:         { type: 'string', example: 'https://www.google.com' },
                                    rewriteHost: { type: 'boolean' },
                                    insecure:    { type: 'boolean' },
                                },
                            },
                            string: {
                                type: 'object',
                                properties: {
                                    content:    { type: 'string' },
                                    headers:    { type: 'object' },
                                    statusCode: { type: 'integer', example: 503 },
                                },
                            },
                            listenHTTP:  { type: 'string', description: 'HTTP listen address for masquerade' },
                            listenHTTPS: { type: 'string', description: 'HTTPS listen address for masquerade' },
                            forceHTTPS:  { type: 'boolean' },
                        },
                    },
                    bandwidth: {
                        type: 'object',
                        properties: {
                            up:   { type: 'string', example: '1 gbps' },
                            down: { type: 'string', example: '1 gbps' },
                        },
                    },
                    sniff: {
                        type: 'object',
                        properties: {
                            enabled:       { type: 'boolean' },
                            enable:        { type: 'boolean', description: 'Enable sniffing within the protocol' },
                            timeout:       { type: 'string', example: '2s' },
                            rewriteDomain: { type: 'boolean' },
                            tcpPorts:      { type: 'string', example: '80,443,8000-9000' },
                            udpPorts:      { type: 'string', example: '443,80,53' },
                        },
                    },
                    quic: {
                        type: 'object',
                        properties: {
                            enabled:                 { type: 'boolean' },
                            initStreamReceiveWindow: { type: 'integer' },
                            maxStreamReceiveWindow:  { type: 'integer' },
                            initConnReceiveWindow:   { type: 'integer' },
                            maxConnReceiveWindow:    { type: 'integer' },
                            maxIdleTimeout:          { type: 'string', example: '60s' },
                            maxIncomingStreams:       { type: 'integer' },
                            disablePathMTUDiscovery: { type: 'boolean' },
                        },
                    },
                    resolver: {
                        type: 'object',
                        properties: {
                            enabled:       { type: 'boolean' },
                            type:          { type: 'string', enum: ['udp', 'tcp', 'tls', 'https'] },
                            udpAddr:       { type: 'string', example: '8.8.4.4:53' },
                            udpTimeout:    { type: 'string', example: '4s' },
                            tcpAddr:       { type: 'string', example: '8.8.8.8:53' },
                            tcpTimeout:    { type: 'string', example: '4s' },
                            tlsAddr:       { type: 'string', example: '1.1.1.1:853' },
                            tlsTimeout:    { type: 'string', example: '10s' },
                            tlsSni:        { type: 'string', example: 'cloudflare-dns.com' },
                            tlsInsecure:   { type: 'boolean' },
                            httpsAddr:     { type: 'string', example: '1.1.1.1:443' },
                            httpsTimeout:  { type: 'string', example: '10s' },
                            httpsSni:      { type: 'string', example: 'cloudflare-dns.com' },
                            httpsInsecure: { type: 'boolean' },
                        },
                    },
                    acl: {
                        type: 'object',
                        properties: {
                            enabled:           { type: 'boolean' },
                            type:              { type: 'string', enum: ['inline', 'file'] },
                            file:              { type: 'string' },
                            geoip:             { type: 'string' },
                            geosite:           { type: 'string' },
                            geoUpdateInterval: { type: 'string' },
                        },
                    },
                    aclRules: { type: 'array', items: { type: 'string' }, description: 'Inline ACL rules' },
                    useTlsFiles: { type: 'boolean', description: 'Whether to use TLS cert/key files instead of ACME' },
                },
            },
            GroupRef: {
                type: 'object',
                properties: {
                    _id:        { type: 'string' },
                    name:       { type: 'string', example: 'Europe' },
                    color:      { type: 'string', example: '#6366f1' },
                    maxDevices: { type: 'integer', description: 'Present on `GET /users` and `GET /users/{userId}`; omitted on enable/disable/groups responses' },
                },
            },
            NodeRef: {
                type: 'object',
                properties: {
                    _id:  { type: 'string' },
                    name: { type: 'string', example: 'Germany' },
                    ip:   { type: 'string', example: '1.2.3.4' },
                },
            },
            Stats: {
                type: 'object',
                properties: {
                    users: {
                        type: 'object',
                        properties: {
                            total:   { type: 'integer', example: 1234 },
                            enabled: { type: 'integer', example: 987 },
                        },
                    },
                    nodes: {
                        type: 'object',
                        properties: {
                            total:  { type: 'integer', example: 9 },
                            online: { type: 'integer', example: 9 },
                        },
                    },
                    onlineUsers: { type: 'integer', example: 639 },
                    nodesList: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                name:   { type: 'string' },
                                online: { type: 'integer' },
                            },
                        },
                    },
                    lastSync: { type: 'string', format: 'date-time', nullable: true },
                },
            },
            Success: {
                type: 'object',
                properties: {
                    success: { type: 'boolean', example: true },
                    message: { type: 'string' },
                },
            },
            UserBulkDeleteRequest: {
                type: 'object',
                required: ['userIds'],
                properties: {
                    userIds: {
                        type: 'array',
                        items: { type: 'string' },
                        example: ['123456789', '987654321'],
                    },
                },
            },
            UserBulkDeleteResponse: {
                type: 'object',
                properties: {
                    success: { type: 'boolean', example: true },
                    deleted: { type: 'integer', example: 2 },
                    deletedUserIds: {
                        type: 'array',
                        items: { type: 'string' },
                        example: ['123456789', '987654321'],
                    },
                    notFound: {
                        type: 'array',
                        items: { type: 'string' },
                        example: ['missing-user'],
                    },
                    errors: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                userId: { type: 'string', example: 'problem-user' },
                                error: { type: 'string', example: 'Database error' },
                            },
                        },
                    },
                },
            },
            LoginResult: {
                type: 'object',
                properties: {
                    success: { type: 'boolean', example: true },
                    username: { type: 'string', example: 'admin' },
                    requiresTwoFactor: { type: 'boolean', example: false },
                    message: { type: 'string' },
                },
            },
            SubscriptionInfo: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean' },
                    groups: { type: 'array', items: { type: 'object' } },
                    traffic: {
                        type: 'object',
                        properties: {
                            used: { type: 'integer', description: 'Bytes used' },
                            limit: { type: 'integer', description: 'Bytes, 0 = unlimited' },
                        },
                    },
                    expire: { type: 'string', format: 'date-time', nullable: true },
                    servers: { type: 'integer' },
                },
            },
            CascadeLink: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    name: { type: 'string', example: 'Portal to Bridge' },
                    mode: { type: 'string', enum: ['reverse', 'forward'], example: 'reverse' },
                    portalNode: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/NodeRef' }] },
                    bridgeNode: { oneOf: [{ type: 'string' }, { $ref: '#/components/schemas/NodeRef' }] },
                    tunnelUuid: { type: 'string', format: 'uuid' },
                    tunnelPort: { type: 'integer', example: 10086 },
                    tunnelDomain: { type: 'string', example: 'reverse.tunnel.internal' },
                    tunnelProtocol: { type: 'string', enum: ['vless', 'vmess'] },
                    tunnelSecurity: { type: 'string', enum: ['none', 'tls', 'reality'] },
                    tunnelTransport: { type: 'string', enum: ['tcp', 'ws', 'grpc', 'xhttp', 'splithttp'] },
                    active: { type: 'boolean' },
                    status: { type: 'string', enum: ['pending', 'deployed', 'online', 'offline', 'error'] },
                    lastError: { type: 'string' },
                    lastHealthCheck: { type: 'string', format: 'date-time', nullable: true },
                    latencyMs: { type: 'integer', nullable: true },
                    geoRouting: { type: 'object' },
                },
            },
            JsonRpcRequest: {
                type: 'object',
                required: ['jsonrpc', 'method'],
                properties: {
                    jsonrpc: { type: 'string', example: '2.0' },
                    id: { nullable: true, oneOf: [{ type: 'string' }, { type: 'integer' }] },
                    method: { type: 'string', example: 'tools/list' },
                    params: { type: 'object' },
                },
            },
            JsonRpcResponse: {
                type: 'object',
                properties: {
                    jsonrpc: { type: 'string', example: '2.0' },
                    id: { nullable: true, oneOf: [{ type: 'string' }, { type: 'integer' }] },
                    result: { type: 'object' },
                    error: { type: 'object' },
                },
            },
        },

        responses: {
            BadRequest: {
                description: 'Invalid request body or parameters',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/Error' },
                        examples: {
                            missingField: { value: { error: 'Username and password required' } },
                            invalidArray: { value: { error: 'users должен быть массивом' } },
                        },
                    },
                },
            },
            Unauthorized: {
                description: 'Missing credentials, invalid/expired API key, or failed login',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/Error' },
                        examples: {
                            noAuth: { value: { error: 'Authentication required' } },
                            badApiKey: { value: { error: 'Invalid or expired API key' } },
                            badLogin: { value: { error: 'Invalid username or password' } },
                        },
                    },
                },
            },
            Forbidden: {
                description: 'Missing required scope or API key IP not in allowlist',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/ScopeError' },
                        examples: {
                            scope: { value: { error: 'Insufficient permissions', required: 'users:write' } },
                            ip: { value: { error: 'IP address not allowed for this API key' } },
                        },
                    },
                },
            },
            NotFound: {
                description: 'Resource not found',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/Error' },
                        examples: {
                            user: { value: { error: 'Пользователь не найден' } },
                            node: { value: { error: 'Node not found' } },
                            token: { value: { error: 'Not found' } },
                        },
                    },
                },
            },
            RateLimited: {
                description: 'API key or login rate limit exceeded (JSON body)',
                headers: {
                    'X-RateLimit-Limit':     { schema: { type: 'integer' } },
                    'X-RateLimit-Remaining': { schema: { type: 'integer' } },
                },
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/RateLimitError' },
                        examples: {
                            apiKey: { value: { error: 'Rate limit exceeded for this API key' } },
                            login: { value: { error: 'Too many attempts. Try again in 15 minutes.' } },
                        },
                    },
                },
            },
            SubscriptionRateLimited: {
                description: 'Subscription endpoint rate limit exceeded (plain text body)',
                content: {
                    'text/plain': {
                        schema: { type: 'string', example: '# Too many requests' },
                    },
                },
            },
        },

        parameters: {
            userId: {
                name: 'userId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                example: '123456789',
            },
            nodeId: {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                description: 'Node ObjectId',
            },
        },
    },

    security: [
        { ApiKeyHeader: [] },
        { BearerToken: [] },
    ],

    tags: [
        { name: 'Auth',   description: 'Admin session login/logout and node HTTP auth' },
        { name: 'Stats',  description: 'Panel statistics and server groups' },
        { name: 'Users',  description: 'User management — scope: `users:read` / `users:write`' },
        { name: 'Nodes',  description: 'Node management — scope: `nodes:read` / `nodes:write`' },
        { name: 'Cascade', description: 'Cascade tunnel management — scope: `nodes:read` / `nodes:write`' },
        { name: 'MCP',    description: 'Model Context Protocol endpoint — scope: `mcp:enabled`' },
        { name: 'Probes', description: 'External diagnostic probes — authenticated with a probe token, not an API key' },
        { name: 'Sync',   description: 'Synchronization and user kicking — scope: `sync:write`' },
        { name: 'Public', description: 'Public endpoints — no authentication required' },
    ],

    paths: {

        // ── Public ─────────────────────────────────────────────────────────────

        '/login': {
            post: {
                tags: ['Auth'],
                summary: 'Create admin session',
                description: 'Authenticates an admin by username/password. If TOTP is enabled, returns 202 and requires `/login/totp` with the same cookie session.',
                security: [],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['username', 'password'],
                                properties: {
                                    username: { type: 'string', example: 'admin' },
                                    password: { type: 'string', format: 'password' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResult' } } } },
                    202: { description: 'Two-factor verification required', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResult' } } } },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    429: { $ref: '#/components/responses/RateLimited' },
                    500: { description: 'Internal error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                },
            },
        },

        '/login/totp': {
            post: {
                tags: ['Auth'],
                summary: 'Complete admin login with TOTP',
                description: 'Completes a pending `/login` flow for admins with two-factor authentication enabled.',
                security: [],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['token'],
                                properties: {
                                    token: { type: 'string', example: '123456' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Authenticated', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginResult' } } } },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    429: { $ref: '#/components/responses/RateLimited' },
                    500: { description: 'Internal error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                },
            },
        },

        '/logout': {
            post: {
                tags: ['Auth'],
                summary: 'Destroy admin session',
                security: [],
                responses: {
                    200: { description: 'Logged out', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                },
            },
        },

        '/auth': {
            post: {
                tags: ['Auth'],
                summary: 'Validate user on node connection',
                description: 'Called by Hysteria nodes to authenticate clients. No API key required.',
                security: [],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['auth'],
                                properties: {
                                    addr: { type: 'string', example: '1.2.3.4:12345', description: 'Client IP:port' },
                                    auth: { type: 'string', example: 'userId:password' },
                                    tx: { type: 'integer', description: 'Optional client bandwidth hint from Hysteria (bytes/s)' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Auth result (always HTTP 200; check `ok`)',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['ok'],
                                    properties: {
                                        ok: { type: 'boolean', example: true },
                                        id: { type: 'string', example: '123456789', description: 'userId (only when ok=true)' },
                                    },
                                },
                                examples: {
                                    accepted: { $ref: '#/components/examples/NodeAuthOkResponse' },
                                    rejected: { $ref: '#/components/examples/NodeAuthFailResponse' },
                                },
                            },
                        },
                    },
                },
            },
        },

        '/files/{token}': {
            get: {
                tags: ['Public'],
                summary: 'Get subscription config',
                description: 'Serves a browser HTML page when opened in a browser without `format`; otherwise auto-detects app format from User-Agent and returns subscription content. HAPP-specific routing/HWID headers may be included.',
                security: [],
                parameters: [
                    {
                        name: 'token',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                        description: 'User subscription token',
                    },
                    {
                        name: 'format',
                        in: 'query',
                        schema: { type: 'string', enum: ['clash', 'yaml', 'singbox', 'json', 'v2ray-json', 'shadowrocket', 'uri', 'raw'] },
                        description: 'Force output format (overrides User-Agent detection)',
                    },
                ],
                responses: {
                    200: { description: 'Subscription config or browser HTML page' },
                    403: { description: 'Subscription disabled, expired, traffic limit reached, or HWID soft-block response' },
                    404: { description: 'Token not found' },
                    429: { $ref: '#/components/responses/SubscriptionRateLimited' },
                    503: { description: 'No servers available' },
                },
            },
        },

        '/info/{token}': {
            get: {
                tags: ['Public'],
                summary: 'Get subscription info',
                description: 'Returns traffic usage and expiry for the subscription.',
                security: [],
                parameters: [
                    {
                        name: 'token',
                        in: 'path',
                        required: true,
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Subscription info',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/SubscriptionInfo' },
                            },
                        },
                    },
                    404: { description: 'Token not found' },
                },
            },
        },

        // ── Stats ──────────────────────────────────────────────────────────────

        '/stats': {
            get: {
                tags: ['Stats'],
                summary: 'Get panel statistics',
                description: 'Returns totals for users, nodes, and online connections.',
                responses: {
                    200: {
                        description: 'Statistics',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Stats' },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/groups': {
            get: {
                tags: ['Stats'],
                summary: 'List server groups',
                responses: {
                    200: {
                        description: 'Array of groups',
                        content: {
                            'application/json': {
                                schema: { type: 'array', items: { type: 'object', properties: { _id: { type: 'string' }, name: { type: 'string' } } } },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },

            post: {
                tags: ['Stats'],
                summary: 'Create server group',
                description: 'Requires the `nodes:write` scope. Returns the created group.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/GroupInput' },
                        },
                    },
                },
                responses: {
                    201: { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, group: { type: 'object' } } } } } },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/groups/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Group ObjectId' }],
            put: {
                tags: ['Stats'],
                summary: 'Update server group',
                description: 'Requires the `nodes:write` scope. Only provided fields are updated.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/GroupInput' },
                        },
                    },
                },
                responses: {
                    200: { description: 'Updated', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, group: { type: 'object' } } } } } },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
            delete: {
                tags: ['Stats'],
                summary: 'Delete server group',
                description: 'Requires the `nodes:write` scope. The group is also detached from all nodes and users.',
                responses: {
                    200: { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        // ── Users ──────────────────────────────────────────────────────────────

        '/users': {
            get: {
                tags: ['Users'],
                summary: 'List users',
                description: 'Supports pagination, filtering, and sorting.',
                parameters: [
                    { name: 'page',      in: 'query', schema: { type: 'integer', default: 1 } },
                    { name: 'limit',     in: 'query', schema: { type: 'integer', default: 50 }, description: 'Page size (no hard server maximum; use reasonable values)' },
                    { name: 'sortBy',    in: 'query', schema: { type: 'string', enum: ['createdAt', 'userId', 'username', 'enabled', 'traffic'], default: 'createdAt' } },
                    { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
                    { name: 'enabled',   in: 'query', schema: { type: 'boolean' }, description: 'Filter by enabled status' },
                    { name: 'group',     in: 'query', schema: { type: 'string' }, description: 'Filter by group ObjectId' },
                ],
                responses: {
                    200: {
                        description: 'Paginated user list',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        users:      { type: 'array', items: { $ref: '#/components/schemas/User' } },
                                        pagination: { $ref: '#/components/schemas/Pagination' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    429: { $ref: '#/components/responses/RateLimited' },
                },
            },

            post: {
                tags: ['Users'],
                summary: 'Create user',
                description: 'Auto-generates `password` and `xrayUuid` on first save. Returns the new user; `groups` and `nodes` are returned as ObjectId strings (no populate).',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UserCreate' },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created user',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } },
                    },
                    400: {
                        description: 'Missing userId',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, examples: { missing: { value: { error: 'userId обязателен' } } } } },
                    },
                    409: {
                        description: 'User already exists',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        error: { type: 'string', example: 'Пользователь уже существует' },
                                        user: { $ref: '#/components/schemas/User' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/users/bulk-delete': {
            post: {
                tags: ['Users'],
                summary: 'Bulk delete users',
                description: 'Deletes selected users by `userId` with the same side effects as single-user deletion. Runs best-effort and reports missing users or per-user errors without rolling back successful deletions.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/UserBulkDeleteRequest' },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Bulk delete result',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/UserBulkDeleteResponse' },
                            },
                        },
                    },
                    400: {
                        description: 'Malformed body',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Error' },
                                examples: {
                                    invalidUserIds: { value: { error: 'userIds должен быть массивом непустых строк' } },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/users/{userId}': {
            parameters: [{ $ref: '#/components/parameters/userId' }],

            get: {
                tags: ['Users'],
                summary: 'Get user by ID',
                responses: {
                    200: { description: 'User', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            put: {
                tags: ['Users'],
                summary: 'Update user',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/UserUpdate' } } },
                },
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            delete: {
                tags: ['Users'],
                summary: 'Delete user',
                responses: {
                    200: { description: 'Deleted', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/devices': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            get: {
                tags: ['Users'],
                summary: 'List HWID devices registered for user',
                responses: {
                    200: {
                        description: 'HWID devices',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/UserDeviceListResponse' } } },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
            delete: {
                tags: ['Users'],
                summary: 'Delete all HWID devices for user',
                responses: {
                    200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/devices/{hwid}': {
            parameters: [
                { $ref: '#/components/parameters/userId' },
                { name: 'hwid', in: 'path', required: true, schema: { type: 'string' }, description: 'HWID (URL-encoded if needed)' },
            ],
            delete: {
                tags: ['Users'],
                summary: 'Delete one HWID device',
                responses: {
                    200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/enable': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Enable user',
                description: 'Returns the updated user. `groups` and `nodes` are returned as ObjectId strings (no populate); call `GET /users/{userId}` for populated objects.',
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/disable': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Disable user',
                description: 'Returns the updated user. `groups` and `nodes` are returned as ObjectId strings (no populate); call `GET /users/{userId}` for populated objects.',
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/reset-traffic': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Reset user traffic',
                description: 'Zeroes the upload/download counters. If the user was disabled only because of traffic/expiry and zeroing makes them healthy again, they are re-enabled automatically (renewal-by-reset).',
                responses: {
                    200: { description: 'Traffic reset', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/groups': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Users'],
                summary: 'Add user to groups',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['groups'],
                                properties: {
                                    groups: { type: 'array', items: { type: 'string' }, example: ['64a1b2c3d4e5f6a7b8c9d0e1'] },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/{userId}/groups/{groupId}': {
            parameters: [
                { $ref: '#/components/parameters/userId' },
                { name: 'groupId', in: 'path', required: true, schema: { type: 'string' }, description: 'Group ObjectId' },
            ],
            delete: {
                tags: ['Users'],
                summary: 'Remove user from group',
                responses: {
                    200: { description: 'Updated user', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/users/sync-from-main': {
            post: {
                tags: ['Users'],
                summary: 'Bulk sync users from external source',
                description: 'Creates or updates users from an external/main database payload.',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['users'],
                                properties: {
                                    users: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                userId: { type: 'string' },
                                                username: { type: 'string' },
                                                enabled: { type: 'boolean' },
                                                groups: { type: 'array', items: { type: 'string' } },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Sync result', content: { 'application/json': { schema: { type: 'object', properties: { created: { type: 'integer' }, updated: { type: 'integer' }, errors: { type: 'integer' } } } } } },
                    400: { description: '`users` must be an array' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        // ── Nodes ──────────────────────────────────────────────────────────────

        '/nodes': {
            get: {
                tags: ['Nodes'],
                summary: 'List nodes',
                parameters: [
                    { name: 'active', in: 'query', schema: { type: 'boolean' }, description: 'Filter by active status' },
                    { name: 'status', in: 'query', schema: { type: 'string', enum: ['online', 'offline', 'error', 'syncing'] } },
                    { name: 'group',  in: 'query', schema: { type: 'string' }, description: 'Filter by group ObjectId' },
                ],
                responses: {
                    200: { description: 'Node list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
            post: {
                tags: ['Nodes'],
                summary: 'Create node',
                description: `Creates a Hysteria, Xray, Virtual (load-balancer), or CDN front node.

- **\`type=hysteria\`** (default) / **\`type=xray\`** — \`ip\` required. \`statsSecret\` is
  generated server-side. Returns 409 if the same IP already has a node of the same \`type\`.
- **\`type=virtual\`** — pure logical balancer over real sibling nodes. **Do not** pass
  \`ip\` or \`ssh\`; pass a \`virtual\` object instead. Virtual nodes never run setup,
  health checks, traffic collection, or restart — they only appear in subscriptions.
- **\`type=cdn\`** — serverless front for a compatible Xray XHTTP, WebSocket, or gRPC
  inbound. Pass a \`cdn\` object with \`originNode\` and a public domain and/or edge
  addresses; do not pass \`ip\` or \`ssh\`.

See the request body examples panel for representative variants.`,
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/NodeCreate' },
                            examples: {
                                hysteria: { $ref: '#/components/examples/NodeCreateRequest' },
                                virtualManual: { $ref: '#/components/examples/NodeCreateVirtualRequest' },
                                virtualGroup: { $ref: '#/components/examples/NodeCreateVirtualGroupRequest' },
                            },
                        },
                    },
                },
                responses: {
                    201: { description: 'Created node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    400: {
                        description: 'Validation error',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Error' },
                                examples: {
                                    required: { value: { error: 'name is required' } },
                                    missingIp: { value: { error: 'ip is required for hysteria and xray nodes' } },
                                    badType: { value: { error: 'type must be hysteria, xray, virtual, or cdn' } },
                                    virtualNoSources: { value: { error: 'Virtual node (manual): at least one source required' } },
                                    virtualNoGroup: { value: { error: 'Virtual node (group): sourceGroup required' } },
                                },
                            },
                        },
                    },
                    409: {
                        description: 'Duplicate IP for this protocol type',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Error' },
                                examples: { duplicate: { value: { error: 'A hysteria node with this IP already exists' } } },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    500: { description: 'Internal error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                },
            },
        },

        '/nodes/check-ip': {
            get: {
                tags: ['Nodes'],
                summary: 'Check sibling nodes by IP',
                description: 'Returns protocol sibling nodes for a given IP address. Used by the UI when adding Hysteria/Xray nodes on the same host.',
                parameters: [
                    { name: 'ip', in: 'query', required: true, schema: { type: 'string' }, description: 'Node IP address' },
                ],
                responses: {
                    200: {
                        description: 'Matching nodes',
                        content: { 'application/json': { schema: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', properties: { _id: { type: 'string' }, type: { type: 'string', enum: ['hysteria', 'xray', 'virtual', 'cdn'] }, name: { type: 'string' } } } } } } } },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/nodes/{id}': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],

            get: {
                tags: ['Nodes'],
                summary: 'Get node by ID',
                responses: {
                    200: { description: 'Node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },

            put: {
                tags: ['Nodes'],
                summary: 'Update node',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUpdate' } } },
                },
                responses: {
                    200: { description: 'Updated node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    409: {
                        description: 'Duplicate name+flag, or the node is a CDN origin and the change would break the fronts pointing at it',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Error' },
                                examples: {
                                    cdnDependent: { value: { error: 'CDN node "Timeweb front" depends on this node: CDN origin inbound must use XHTTP, WebSocket, or gRPC' } },
                                },
                            },
                        },
                    },
                },
            },

            delete: {
                tags: ['Nodes'],
                summary: 'Delete node',
                responses: {
                    200: {
                        description: 'Deleted',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Нода удалена' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    409: {
                        description: 'The node is the origin of at least one CDN node; delete those first',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Error' },
                                examples: {
                                    cdnDependent: { value: { error: 'Node is used as the origin by CDN node "Timeweb front"' } },
                                },
                            },
                        },
                    },
                    500: { description: 'Internal error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                },
            },
        },

        '/nodes/{id}/status': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'Get stored node status',
                description: `Returns the status currently stored in the panel database, including \`load\` —
average Mbit/s since the previous stats-collection poll (cron runs every 5 minutes).
This is a byproduct of the traffic accounting the panel already does for quotas/billing,
not a live SSH probe, so it's cheap to poll frequently and safe to call from external
integrations. Resolution is bound to the collection interval (~5 min), not per-second.`,
                responses: {
                    200: {
                        description: 'Node status',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        name:        { type: 'string', example: 'Germany 1' },
                                        status:      { type: 'string', enum: ['online', 'offline', 'error', 'syncing'] },
                                        onlineUsers: { type: 'integer' },
                                        lastError:   { type: 'string' },
                                        lastSync:    { type: 'string', format: 'date-time', nullable: true },
                                        load: {
                                            type: 'object',
                                            description: 'Average load since the previous ~5 min stats poll (not instantaneous).',
                                            properties: {
                                                txMbps:    { type: 'number', example: 12.4 },
                                                rxMbps:    { type: 'number', example: 87.1 },
                                                updatedAt: { type: 'string', format: 'date-time', nullable: true },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/reset-status': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Reset node status',
                description: 'Marks a node as online and clears the last error/health failure counter.',
                responses: {
                    200: {
                        description: 'Status reset',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Статус сброшен' },
                                        node: { $ref: '#/components/schemas/Node' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/agent-info': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'Get Xray agent info',
                description: 'Fetches live info from the CC Agent for an Xray node.',
                responses: {
                    200: { description: 'Agent info', content: { 'application/json': { schema: { type: 'object' } } } },
                    400: { description: 'Node is not Xray', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, examples: { notXray: { value: { error: 'Not an Xray node' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    502: { description: 'Agent request failed' },
                },
            },
        },

        '/nodes/{id}/sync': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Sync specific node',
                description: 'Marks the node as `syncing` and starts `updateNodeConfig` in the background (SSH or agent depending on node type). Response is returned immediately. Virtual nodes return **400** — they have no remote service to sync.',
                responses: {
                    200: {
                        description: 'Sync started',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Синхронизация запущена' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/setup': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Auto-setup node via SSH',
                description: `One-click provisioning via SSH — same as **⚙️ Auto Setup** in the panel.

**Hysteria nodes** (\`type=hysteria\`, default): optional body flags \`installHysteria\`, \`setupPortHopping\`, \`restartService\` (all default \`true\`). Installs/updates Hysteria, uploads config, configures port hopping, restarts \`hysteria-server\`.

**Xray nodes** (\`type=xray\`): runs Xray agent setup; only \`restartService\` from the body is used.

**Virtual nodes** (\`type=virtual\`): not supported — returns **400** because virtual nodes have no remote service to provision.

**⚠️ Long-running:** typically **30 seconds to 2 minutes**. Set client timeout to at least **3 minutes**.

**Requires SSH credentials** on the node (password or private key). Returns \`{ success, logs }\` on success or \`500\` with \`{ success: false, error, logs }\` on failure.`,
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    installHysteria:  { type: 'boolean', default: true, description: 'Install/update Hysteria binary' },
                                    setupPortHopping: { type: 'boolean', default: true, description: 'Configure iptables NAT rules for port hopping range' },
                                    restartService:   { type: 'boolean', default: true, description: 'Enable and restart hysteria-server systemd unit' },
                                },
                            },
                            example: {
                                installHysteria: true,
                                setupPortHopping: true,
                                restartService: true,
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Setup completed successfully',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        logs:    { type: 'array', items: { type: 'string' }, description: 'Setup log lines' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'SSH credentials not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    500: {
                        description: 'Setup failed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: false },
                                        error:   { type: 'string' },
                                        logs:    { type: 'array', items: { type: 'string' } },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/config': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'Get generated node config',
                description: 'Returns generated **Hysteria 2** server YAML for the node (`text/yaml`). Intended for Hysteria nodes; Xray nodes use a different config pipeline.',
                responses: {
                    200: { description: 'Hysteria 2 server config (YAML)', content: { 'text/yaml': { schema: { type: 'string' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/users': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            get: {
                tags: ['Nodes'],
                summary: 'List users assigned to node',
                description: 'Returns enabled users on this node with `userId`, `username`, and `traffic` only.',
                responses: {
                    200: { description: 'User list', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/NodeUserSummary' } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/groups': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Add node to groups',
                requestBody: {
                    required: true,
                    content: { 'application/json': { schema: { type: 'object', required: ['groups'], properties: { groups: { type: 'array', items: { type: 'string' } } } } } },
                },
                responses: {
                    200: { description: 'Updated node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    400: { description: '`groups` must be an array' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/groups/{groupId}': {
            parameters: [
                { $ref: '#/components/parameters/nodeId' },
                { name: 'groupId', in: 'path', required: true, schema: { type: 'string' }, description: 'Group ObjectId' },
            ],
            delete: {
                tags: ['Nodes'],
                summary: 'Remove node from group',
                responses: {
                    200: { description: 'Updated node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/nodes/{id}/setup-port-hopping': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Configure port hopping',
                description: 'Applies iptables/NAT port-hopping rules on the node via SSH.',
                responses: {
                    200: { description: 'Configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    500: { description: 'Failed to configure port hopping' },
                },
            },
        },

        '/nodes/{id}/update-config': {
            parameters: [{ $ref: '#/components/parameters/nodeId' }],
            post: {
                tags: ['Nodes'],
                summary: 'Push generated config to node',
                description: 'Regenerates and uploads the node config via SSH/agent.',
                responses: {
                    200: { description: 'Config updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    500: { description: 'Failed to update config' },
                },
            },
        },

        // ── Cascade ────────────────────────────────────────────────────────────

        '/cascade/links': {
            get: {
                tags: ['Cascade'],
                summary: 'List cascade links',
                parameters: [
                    { name: 'active', in: 'query', schema: { type: 'boolean' } },
                    { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'deployed', 'online', 'offline', 'error'] } },
                    { name: 'nodeId', in: 'query', schema: { type: 'string' }, description: 'Filter links that touch this node' },
                ],
                responses: {
                    200: { description: 'Cascade links', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/CascadeLink' } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
            post: {
                tags: ['Cascade'],
                summary: 'Create cascade link',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['name', 'portalNodeId', 'bridgeNodeId'],
                                properties: {
                                    name: { type: 'string' },
                                    portalNodeId: { type: 'string' },
                                    bridgeNodeId: { type: 'string' },
                                    mode: { type: 'string', enum: ['reverse', 'forward'], default: 'reverse' },
                                    tunnelPort: { type: 'integer', default: 10086 },
                                    tunnelProtocol: { type: 'string', enum: ['vless', 'vmess'], default: 'vless' },
                                    tunnelSecurity: { type: 'string', enum: ['none', 'tls', 'reality'], default: 'none' },
                                    tunnelTransport: { type: 'string', enum: ['tcp', 'ws', 'grpc', 'xhttp', 'splithttp'], default: 'tcp' },
                                    autoDeploy: { type: 'boolean', description: 'Deploy chain after creation' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: { description: 'Created link', content: { 'application/json': { schema: { $ref: '#/components/schemas/CascadeLink' } } } },
                    400: { description: 'Invalid topology or tunnel settings' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/cascade/links/{id}': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Cascade link ObjectId' }],
            get: {
                tags: ['Cascade'],
                summary: 'Get cascade link',
                responses: {
                    200: { description: 'Cascade link', content: { 'application/json': { schema: { $ref: '#/components/schemas/CascadeLink' } } } },
                    400: { description: 'Invalid link ID' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
            put: {
                tags: ['Cascade'],
                summary: 'Update cascade link',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
                responses: {
                    200: { description: 'Updated link', content: { 'application/json': { schema: { $ref: '#/components/schemas/CascadeLink' } } } },
                    400: { description: 'Invalid link settings' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
            delete: {
                tags: ['Cascade'],
                summary: 'Delete cascade link',
                description: 'Undeploys the link first when it is currently deployed/online/offline.',
                responses: {
                    200: { description: 'Deleted', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                    400: { description: 'Invalid link ID' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/cascade/links/{id}/reconnect': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            patch: {
                tags: ['Cascade'],
                summary: 'Reconnect cascade link',
                description: 'Changes portal and/or bridge node, undeploying first when necessary.',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { portalNodeId: { type: 'string' }, bridgeNodeId: { type: 'string' } } } } } },
                responses: {
                    200: { description: 'Updated link', content: { 'application/json': { schema: { $ref: '#/components/schemas/CascadeLink' } } } },
                    400: { description: 'Invalid reconnect request' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/cascade/links/{id}/deploy': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            post: {
                tags: ['Cascade'],
                summary: 'Deploy cascade link',
                responses: {
                    200: {
                        description: 'Deployed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Cascade link deployed' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'Invalid link ID' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    429: { $ref: '#/components/responses/RateLimited' },
                    500: {
                        description: 'Deploy failed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: false },
                                        error: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        '/cascade/links/{id}/undeploy': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            post: {
                tags: ['Cascade'],
                summary: 'Undeploy cascade link',
                responses: {
                    200: {
                        description: 'Undeployed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: true },
                                        message: { type: 'string', example: 'Cascade link undeployed' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'Invalid link ID' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                    429: { $ref: '#/components/responses/RateLimited' },
                },
            },
        },

        '/cascade/chain/deploy': {
            post: {
                tags: ['Cascade'],
                summary: 'Deploy cascade chain',
                description: 'Deploys the whole chain starting from `nodeId` or from the portal side of `linkId`.',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { nodeId: { type: 'string' }, linkId: { type: 'string' } } } } } },
                responses: {
                    200: { description: 'Chain deployed', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, deployed: { type: 'integer' } } } } } },
                    400: { description: '`nodeId` or `linkId` is required' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    429: { $ref: '#/components/responses/RateLimited' },
                    500: {
                        description: 'Chain deploy failed',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean', example: false },
                                        deployed: { type: 'integer' },
                                        errors: { type: 'array', items: { type: 'string' } },
                                        error: { type: 'string', description: 'Present on unhandled exceptions' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },

        '/cascade/links/{id}/health': {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
            get: {
                tags: ['Cascade'],
                summary: 'Health-check cascade link',
                responses: {
                    200: { description: 'Health result', content: { 'application/json': { schema: { type: 'object', properties: { healthy: { type: 'boolean' }, status: { type: 'string' }, lastHealthCheck: { type: 'string', format: 'date-time', nullable: true }, latencyMs: { type: 'integer', nullable: true } } } } } },
                    400: { description: 'Invalid link ID' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                    404: { $ref: '#/components/responses/NotFound' },
                },
            },
        },

        '/cascade/topology': {
            get: {
                tags: ['Cascade'],
                summary: 'Get cascade topology',
                description: 'Returns the network graph used by the visual map.',
                responses: {
                    200: { description: 'Topology graph', content: { 'application/json': { schema: { type: 'object' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/cascade/topology/positions': {
            post: {
                tags: ['Cascade'],
                summary: 'Save cascade topology positions',
                requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['positions'], properties: { positions: { type: 'array', items: { type: 'object' } } } } } } },
                responses: {
                    200: { description: 'Saved', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } },
                    400: { description: 'positions must be an array', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, examples: { invalid: { value: { error: 'positions must be an array' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        // ── Probes ─────────────────────────────────────────────────────────────

        '/probe/enroll': {
            post: {
                tags: ['Probes'],
                summary: 'Exchange an enrollment token for a probe token',
                description: 'Called once by a freshly installed probe. The enrollment token is single-use and short-lived; the permanent token it returns authenticates every later request. Rejected with 403 while the probes feature is disabled.',
                security: [],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    enrollToken: { type: 'string', description: 'May also be sent as a Bearer token' },
                                    version: { type: 'string' },
                                    singboxVersion: { type: 'string' },
                                    os: { type: 'string' },
                                    arch: { type: 'string' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Enrolled',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        token: { type: 'string' },
                                        probeId: { type: 'string' },
                                        name: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    401: { description: 'Missing, invalid or expired enrollment token' },
                    403: { description: 'Probes are disabled' },
                    429: { $ref: '#/components/responses/RateLimited' },
                },
            },
        },

        '/probe/profile': {
            get: {
                tags: ['Probes'],
                summary: 'Get the checking plan for this probe',
                description: 'Returns the nodes and inbounds to check with the sing-box outbound tag each one will carry in the subscription, plus the resource checklist, cadence, speed-test budget and the subscription URL. Requires the probe Bearer token.',
                security: [{ BearerToken: [] }],
                responses: {
                    200: {
                        description: 'Manifest',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        probeId: { type: 'string' },
                                        name: { type: 'string' },
                                        subscriptionUrl: { type: 'string' },
                                        ingestUrl: { type: 'string' },
                                        intervals: {
                                            type: 'object',
                                            properties: {
                                                transportSec: { type: 'integer' },
                                                targetsSec: { type: 'integer' },
                                                reportSec: { type: 'integer' },
                                            },
                                        },
                                        speedTest: { type: 'object' },
                                        targets: { type: 'array', items: { type: 'object' } },
                                        nodes: { type: 'array', items: { type: 'object' } },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { description: 'Probes are disabled' },
                },
            },
        },

        '/probe/ingest': {
            post: {
                tags: ['Probes'],
                summary: 'Submit probe measurements',
                description: 'Accepts gzipped NDJSON rollup windows (kinds: transport, target, event, meta). `X-Batch-Id` must be the SHA-256 of the body; identical redelivered batches are acknowledged without reprocessing, which makes at-least-once shipping safe.',
                security: [{ BearerToken: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/x-ndjson': {
                            schema: { type: 'string', format: 'binary' },
                        },
                    },
                },
                responses: {
                    202: { description: 'Accepted' },
                    200: { description: 'Duplicate batch, already processed' },
                    400: { description: 'Empty body or batch id mismatch' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { description: 'Probes are disabled' },
                    413: { description: 'Payload too large' },
                    429: { $ref: '#/components/responses/RateLimited' },
                },
            },
        },

        // ── MCP ────────────────────────────────────────────────────────────────

        '/mcp': {
            post: {
                tags: ['MCP'],
                summary: 'MCP Streamable HTTP endpoint',
                description: 'JSON-RPC 2.0 endpoint for MCP methods such as `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`, and `prompts/get`. `tools/call` and requests accepting `text/event-stream` respond as SSE.',
                requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } } } },
                responses: {
                    200: { description: 'JSON-RPC response or SSE stream', content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcResponse' } }, 'text/event-stream': { schema: { type: 'string' } } } },
                    400: { description: 'Invalid JSON-RPC request' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/mcp/sse': {
            get: {
                tags: ['MCP'],
                summary: 'Open legacy MCP SSE stream',
                description: 'Legacy MCP transport. Emits an `endpoint` event containing `/api/mcp/messages?sessionId=...`.',
                responses: {
                    200: { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/mcp/messages': {
            post: {
                tags: ['MCP'],
                summary: 'Send legacy MCP SSE message',
                parameters: [{ name: 'sessionId', in: 'query', required: true, schema: { type: 'string' } }],
                requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/JsonRpcRequest' } } } },
                responses: {
                    202: { description: 'Accepted; response is sent on the SSE stream' },
                    400: { description: 'Session not found or invalid JSON-RPC request' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/mcp/tools': {
            get: {
                tags: ['MCP'],
                summary: 'List MCP tools',
                responses: {
                    200: { description: 'Tool list', content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { type: 'object' } } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/mcp/prompts': {
            get: {
                tags: ['MCP'],
                summary: 'List MCP prompts',
                responses: {
                    200: { description: 'Prompt list', content: { 'application/json': { schema: { type: 'object', properties: { prompts: { type: 'array', items: { type: 'object' } } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        // ── Sync ───────────────────────────────────────────────────────────────

        '/sync': {
            post: {
                tags: ['Sync'],
                summary: 'Sync all nodes',
                description: 'Pushes config to all active nodes in parallel. Returns immediately; sync runs in background.',
                responses: {
                    200: { description: 'Sync started', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', example: 'Sync started' } } } } } },
                    409: { description: 'Sync already in progress' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },

        '/kick/{userId}': {
            parameters: [{ $ref: '#/components/parameters/userId' }],
            post: {
                tags: ['Sync'],
                summary: 'Kick user from all nodes',
                description: 'Forcibly disconnects the user from all Hysteria nodes they are connected to.',
                responses: {
                    200: { description: 'Kicked', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { $ref: '#/components/responses/Forbidden' },
                },
            },
        },
    },
};

applyReferenceDocsEnhancements(spec);

/**
 * Apply i18n translations to the spec.
 * Overrides: info.description, tags descriptions, and per-operation summary/description.
 */
function buildSpec(lang = 'en') {
    const t = i18n[lang];
    if (!t) return spec;

    // Deep clone to avoid mutating the base spec
    const out = JSON.parse(JSON.stringify(spec));

    if (t.info?.description) {
        out.info.description = t.info.description;
    }

    if (t.tags) {
        out.tags = t.tags;
    }

    if (t.operations) {
        for (const [pathMethod, override] of Object.entries(t.operations)) {
            // Key format: "METHOD /path" e.g. "GET /users/{userId}"
            const spaceIdx = pathMethod.indexOf(' ');
            const method = pathMethod.slice(0, spaceIdx).toLowerCase();
            const path = pathMethod.slice(spaceIdx + 1);

            if (out.paths[path]?.[method]) {
                if (override.summary !== undefined) out.paths[path][method].summary = override.summary;
                if (override.description !== undefined) out.paths[path][method].description = override.description;
            }
        }
    }

    if (t.replacements) {
        applyTextReplacements(out, t.replacements);
    }

    return out;
}

function applyTextReplacements(value, replacements) {
    if (!value || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
        if ((key === 'summary' || key === 'description' || key === 'title') && typeof child === 'string') {
            if (Object.prototype.hasOwnProperty.call(replacements, child)) {
                value[key] = replacements[child];
            }
            continue;
        }

        if (child && typeof child === 'object') {
            applyTextReplacements(child, replacements);
        }
    }
}

module.exports = { buildSpec };
