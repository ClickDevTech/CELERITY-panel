/**
 * MCP Tools — bulk actions over many nodes
 * Tools: bulk_action
 */

const { z } = require('zod');
const bulkActionService = require('../../services/bulkActionService');
const nodeConfigFields = require('../../services/nodeConfigFields');

const CONFIG_PATHS = Object.keys(nodeConfigFields.FIELDS);

const bulkActionSchema = z.object({
    op: z.enum(['releases', 'fields', 'preview', 'start', 'status', 'cancel'])
        .describe('releases = known Xray versions; fields = what config_patch can change; preview = what would run and why nodes are skipped; start = launch; status = progress of the current batch; cancel = stop scheduling new nodes'),
    action: z.enum(['xray_version', 'sync', 'config_patch']).optional()
        .describe('Required for preview/start. xray_version changes the Xray core (with rollback); sync pushes config and restarts the service; config_patch changes one config field on many nodes and pushes it (with rollback)'),
    nodeIds: z.array(z.string()).max(bulkActionService.MAX_NODES).optional()
        .describe('MongoDB _id list of target nodes'),
    all: z.boolean().optional()
        .describe('Target every eligible node instead of nodeIds (Xray nodes for xray_version, active nodes for sync, active nodes of the field\'s type for config_patch)'),
    version: z.string().max(32).optional().describe('Target Xray version for action=xray_version, e.g. "26.3.27"'),
    path: z.enum(CONFIG_PATHS).optional()
        .describe('config_patch: field to change, e.g. "xray.alpn", "xray.fingerprint", "aclRules", "bandwidth.up". op=fields lists them'),
    patchOp: z.enum(['set', 'add', 'remove']).optional()
        .describe('config_patch: set replaces the value; add/remove work on list fields (alpn, fingerprintPool, realitySni, realityShortIds, aclRules). Default set'),
    value: z.union([z.string().max(40000), z.boolean(), z.number(), z.array(z.string().max(600)).max(100)]).optional()
        .describe('config_patch: new value. Lists accept an array or a comma-separated string; aclRules are one rule per array item or per line, e.g. "reject(geoip:cn)"'),
    scope: z.enum(['main', 'main_extras', 'extras']).optional()
        .describe('config_patch, inbound fields: which Xray inbounds to change. Default main_extras'),
    inboundFilter: z.object({
        transport: z.enum(['tcp', 'ws', 'grpc', 'xhttp']).optional(),
        security: z.enum(['reality', 'tls', 'none']).optional(),
    }).optional().describe('config_patch, inbound fields: only inbounds with this transport/security'),
    position: z.enum(['start', 'end']).optional()
        .describe('config_patch aclRules add: where new rules go. Default start, ahead of catch-all rules like direct(all)'),
    confirm: z.boolean().optional().describe('Must be true for op=start'),
});

const TOOL_DESCRIPTION = [
    'Run an action on many nodes at once: change the Xray core version, sync/restart nodes,',
    'or change one config field (ALPN, fingerprint, xhttp options, ACL rules, Hysteria bandwidth...) with config_patch.',
    'One batch runs at a time. The first ready node runs alone as a canary; the rest follow in small waves.',
    'After 2 failed nodes no new nodes are started. Each Xray version change verifies the release checksum,',
    'tests the current config with the new binary and rolls back on failure. A config_patch whose push fails',
    'puts the old value back and pushes the old config again.',
    'Always call op=preview first and show the skipped nodes and before/after values to the user; op=start requires confirm=true.',
    'Poll op=status for progress.',
].join(' ');

function actionParams(parsed) {
    if (parsed.action === 'config_patch') {
        return {
            path: parsed.path,
            op: parsed.patchOp,
            value: parsed.value,
            scope: parsed.scope,
            inboundFilter: parsed.inboundFilter,
            position: parsed.position,
        };
    }
    return { version: parsed.version };
}

function actorFor(apiKey) {
    return apiKey ? `mcp:${String(apiKey.name || apiKey._id || 'key').slice(0, 60)}` : 'mcp:session';
}

async function resolveNodeIds(parsed) {
    if (parsed.all) return bulkActionService.allNodeIds(parsed.action, actionParams(parsed));
    return parsed.nodeIds || [];
}

function requireAction(parsed) {
    if (!parsed.action) throw new Error('action is required for this op');
}

async function bulkAction(args, emit, apiKey) {
    const parsed = bulkActionSchema.parse(args || {});

    switch (parsed.op) {
        case 'releases': {
            const xrayVersionService = require('../../services/xrayVersionService');
            const info = await xrayVersionService.getVersionInfo();
            return {
                latestVersion: info.latestVersion,
                latestPrereleaseVersion: info.latestPrereleaseVersion,
                releases: info.releases.slice(0, 20).map(r => ({ version: r.version, prerelease: r.prerelease, publishedAt: r.publishedAt })),
                checkedAt: info.checkedAt,
                error: info.error,
            };
        }

        case 'fields':
            return { fields: nodeConfigFields.listFields() };

        case 'preview': {
            requireAction(parsed);
            return bulkActionService.preview({
                action: parsed.action,
                nodeIds: await resolveNodeIds(parsed),
                params: actionParams(parsed),
            });
        }

        case 'start': {
            requireAction(parsed);
            if (parsed.confirm !== true) {
                throw new Error('confirm=true is required to start a bulk action; run op=preview first');
            }
            emit('progress', { message: `Starting bulk ${parsed.action}...` });
            return bulkActionService.start({
                action: parsed.action,
                nodeIds: await resolveNodeIds(parsed),
                params: actionParams(parsed),
                actor: actorFor(apiKey),
            });
        }

        case 'status':
            return bulkActionService.status();

        case 'cancel':
            return bulkActionService.cancel(actorFor(apiKey));

        default:
            throw new Error(`Unknown op: ${parsed.op}`);
    }
}

module.exports = {
    TOOL_DESCRIPTION,
    schemas: { bulkAction: bulkActionSchema },
    bulkAction,
};
