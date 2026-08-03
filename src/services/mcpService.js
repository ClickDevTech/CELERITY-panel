/**
 * MCP Service — Tools registry and request dispatcher.
 *
 * Implements the Model Context Protocol (MCP) over SSE:
 *   methods: tools/list, tools/call, prompts/list, prompts/get
 *
 * All tool results are streamed back as SSE events:
 *   event: progress  — intermediate step info
 *   event: log       — stdout/stderr lines (SSH, setup)
 *   event: result    — final result (JSON)
 *   event: error     — tool or protocol error
 */

const { z } = require('zod');
const logger = require('../utils/logger');

const { listPrompts, getPrompt } = require('../mcp/prompts');
const usersTools = require('../mcp/tools/users');
const nodesTools = require('../mcp/tools/nodes');
const groupsTools = require('../mcp/tools/groups');
const cascadeTools = require('../mcp/tools/cascade');
const systemTools = require('../mcp/tools/system');
const statsTools = require('../mcp/tools/stats');
const logsTools = require('../mcp/tools/logs');
const accessLogsTools = require('../mcp/tools/accessLogs');

// ─── Schema generation ─────────────────────────────────────────────────────
// Advertised tool `inputSchema`s are derived from the zod schemas that the
// handlers already validate against — a single source of truth, so the schema
// shown to MCP clients can never drift from what the handler actually accepts.
// Runs once at module load. Falls back to a permissive object schema if a given
// zod schema isn't representable as JSON Schema, so one bad schema can't break
// tools/list.
function zodToInputSchema(schema) {
    try {
        const js = z.toJSONSchema(schema, { target: 'draft-7' });
        delete js.$schema;
        return js;
    } catch (err) {
        logger.warn(`[MCP] inputSchema generation failed: ${err.message}`);
        return { type: 'object' };
    }
}

// ─── Tool Definitions ────────────────────────────────────────────────────────
// Each entry: { description, requiredScope, inputSchema (JSON Schema), handler }

const TOOLS = {
    query: {
        description: 'Query data from the panel. Supports: users, nodes, groups, stats, topology, logs. Use resource to specify what to fetch.',
        requiredScope: null, // scope checked per resource in handler
        inputSchema: {
            type: 'object',
            properties: {
                resource: {
                    type: 'string',
                    enum: ['users', 'nodes', 'groups', 'stats', 'logs'],
                    description: 'What to query',
                },
                id: { type: 'string', description: 'Specific item ID (userId for users, MongoDB _id for nodes/groups/cascade)' },
                filter: {
                    type: 'object',
                    description: 'Resource-specific filters. Users: {enabled, group}. Nodes: {active, group, status}. Stats: {type, period, limit}. Logs: {level, filter, limit}.',
                },
                limit: { type: 'number', description: 'Max items to return (default 50)', default: 50 },
                page: { type: 'number', description: 'Page number for pagination (default 1)', default: 1 },
                sortBy: { type: 'string', description: 'Sort field (users: createdAt|userId|username|traffic|enabled)' },
                sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
                includeUsers: { type: 'boolean', description: 'Include users list (for single node query)', default: false },
                includeConfig: { type: 'boolean', description: 'Include generated node config (for single node query)', default: false },
            },
            required: ['resource'],
        },
    },

    manage_user: {
        description: 'Manage VPN users: create, update, delete, enable, disable, or reset traffic.',
        requiredScope: 'users:write',
        inputSchema: zodToInputSchema(usersTools.schemas.manageUser),
    },

    manage_hwid_devices: {
        description: 'List or remove HWID devices registered for a user (subscription clients).',
        requiredScope: 'users:write',
        inputSchema: zodToInputSchema(usersTools.schemas.manageHwidDevices),
    },

    manage_node: {
        description: 'Manage Hysteria/Xray/virtual nodes: create, update, delete, sync, auto-setup via SSH, reset status, update config, setup port hopping, generate Xray Reality keys. "virtual" nodes are load-balancer entries over real sibling nodes. For type="xray" pass the full "xray" object (transport, security/reality, fingerprint + fingerprintPool, alpn, ws/grpc/xhttp, extraInbounds); on update the xray object is merged per-field, so omit realityPrivateKey/realityPublicKey/manualKey to keep generated values.',
        requiredScope: 'nodes:write',
        inputSchema: zodToInputSchema(nodesTools.schemas.manageNode),
    },

    manage_group: {
        description: 'Manage server groups: create, update, or delete.',
        requiredScope: 'nodes:write',
        inputSchema: zodToInputSchema(groupsTools.schemas.manageGroup),
    },

    manage_cascade: {
        description: 'Manage cascade links between portal and bridge nodes: create, update, delete, deploy, undeploy, reconnect.',
        requiredScope: 'nodes:write',
        inputSchema: zodToInputSchema(cascadeTools.schemas.manageCascade),
    },

    execute_ssh: {
        description: 'Execute a shell command on a node via SSH. Returns stdout/stderr output. For interactive sessions use ssh_session.',
        requiredScope: 'nodes:write',
        inputSchema: zodToInputSchema(nodesTools.schemas.executeSsh),
    },

    ssh_session: {
        description: 'Manage an interactive SSH session on a node. Start a session, send input commands, or close it.',
        requiredScope: 'nodes:write',
        inputSchema: zodToInputSchema(nodesTools.schemas.sshSession),
    },

    scan_sni: {
        description: 'Scan a host IP for working TLS SNI domains (for Reality/masquerade). Streams progress and results. Does not require a node — give a raw IP.',
        requiredScope: 'nodes:read',
        inputSchema: zodToInputSchema(nodesTools.schemas.scanSni),
    },

    system_action: {
        description: 'System operations: sync all nodes, clear cache, create backup, or kick a user from all active sessions.',
        requiredScope: 'sync:write',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['sync_all', 'clear_cache', 'backup', 'kick_user'],
                },
                userId: { type: 'string', description: 'Required for kick_user action' },
            },
            required: ['action'],
        },
    },

    get_topology: {
        description: 'Get the full network topology: all active nodes and cascade links between them.',
        requiredScope: 'nodes:read',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },

    health_check: {
        description: 'Check panel health: uptime, sync status, cache stats, memory usage.',
        requiredScope: null,
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },

    query_access_logs: {
        description: accessLogsTools.TOOL_DESCRIPTION,
        requiredScope: 'stats:read',
        inputSchema: zodToInputSchema(accessLogsTools.schemas.queryAccessLogs),
    },
};

// ─── Scope helpers ───────────────────────────────────────────────────────────

function hasScope(apiKey, scope) {
    if (!scope) return true;
    if (!apiKey) return false;
    return apiKey.scopes && apiKey.scopes.includes(scope);
}

// Determine required scope for query tool based on resource
function queryScopeFor(resource) {
    const map = {
        users: 'users:read',
        nodes: 'nodes:read',
        groups: 'stats:read',
        stats: 'stats:read',
        logs: 'stats:read',
    };
    return map[resource] || 'stats:read';
}

// ─── List Tools ──────────────────────────────────────────────────────────────

/**
 * Filter tools list based on what the API key has access to.
 * Tools with requiredScope=null are always included.
 */
function listTools(apiKey) {
    return Object.entries(TOOLS)
        .filter(([, def]) => {
            if (!def.requiredScope) return true;
            return hasScope(apiKey, def.requiredScope);
        })
        .map(([name, def]) => ({
            name,
            description: def.description,
            inputSchema: def.inputSchema,
        }));
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Dispatch a tool call. Emitter fn receives (event, data).
 * Returns final result object.
 */
async function callTool(name, args, apiKey, emit) {
    const def = TOOLS[name];
    if (!def) {
        throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 404 });
    }

    // Session auth: session has no apiKey but full access
    const isSession = !apiKey;

    if (!isSession && def.requiredScope && !hasScope(apiKey, def.requiredScope)) {
        throw Object.assign(
            new Error(`Missing scope: ${def.requiredScope}`),
            { code: 403 }
        );
    }

    logger.info(`[MCP] tool=${name} args=${JSON.stringify(args).slice(0, 200)}`);

    switch (name) {
        // ── query ──────────────────────────────────────────────────────────
        case 'query': {
            const resource = args?.resource;
            if (!resource) throw new Error('resource is required');

            // Scope check per resource (unless session)
            if (!isSession) {
                const neededScope = queryScopeFor(resource);
                if (!hasScope(apiKey, neededScope)) {
                    throw Object.assign(new Error(`Missing scope: ${neededScope}`), { code: 403 });
                }
            }

            switch (resource) {
                case 'users':
                    return await usersTools.queryUsers(args);
                case 'nodes':
                    return await nodesTools.queryNodes(args);
                case 'groups':
                    return await groupsTools.queryGroups(args);
                case 'stats':
                    return await statsTools.queryStats(args.filter || args);
                case 'logs':
                    return await logsTools.queryLogs(args.filter || args);
                default:
                    throw new Error(`Unknown resource: ${resource}`);
            }
        }

        case 'manage_user':
            return await usersTools.manageUser(args, emit);

        case 'manage_hwid_devices':
            return await usersTools.manageHwidDevices(args, emit);

        case 'manage_node':
            return await nodesTools.manageNode(args, emit);

        case 'manage_group':
            return await groupsTools.manageGroup(args);

        case 'manage_cascade':
            return await cascadeTools.manageCascade(args, emit);

        case 'execute_ssh':
            return await nodesTools.executeSsh(args, emit);

        case 'ssh_session':
            return await nodesTools.sshSession(args, emit);

        case 'scan_sni':
            return await nodesTools.scanSni(args, emit);

        case 'system_action':
            return await systemTools.systemAction(args, emit);

        case 'get_topology':
            return await cascadeTools.getTopology();

        case 'health_check':
            return await systemTools.healthCheck();

        case 'query_access_logs':
            return await accessLogsTools.queryAccessLogs(args);

        default:
            throw Object.assign(new Error(`Tool not implemented: ${name}`), { code: 501 });
    }
}

module.exports = { listTools, callTool, TOOLS, listPrompts, getPrompt };
