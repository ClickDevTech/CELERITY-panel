/**
 * MCP Tools — bulk actions over many nodes
 * Tools: bulk_action
 */

const { z } = require('zod');
const bulkActionService = require('../../services/bulkActionService');

const bulkActionSchema = z.object({
    op: z.enum(['releases', 'preview', 'start', 'status', 'cancel'])
        .describe('releases = known Xray versions; preview = what would run and why nodes are skipped; start = launch; status = progress of the current batch; cancel = stop scheduling new nodes'),
    action: z.enum(['xray_version', 'sync']).optional()
        .describe('Required for preview/start. xray_version changes the Xray core (with rollback); sync pushes config and restarts the service'),
    nodeIds: z.array(z.string()).max(bulkActionService.MAX_NODES).optional()
        .describe('MongoDB _id list of target nodes'),
    all: z.boolean().optional()
        .describe('Target every eligible node instead of nodeIds (Xray nodes for xray_version, active nodes for sync)'),
    version: z.string().max(32).optional().describe('Target Xray version for action=xray_version, e.g. "26.3.27"'),
    confirm: z.boolean().optional().describe('Must be true for op=start'),
});

const TOOL_DESCRIPTION = [
    'Run an action on many nodes at once: change the Xray core version or sync/restart nodes.',
    'One batch runs at a time. The first ready node runs alone as a canary; the rest follow in small waves.',
    'After 2 failed nodes no new nodes are started. Each Xray version change verifies the release checksum,',
    'tests the current config with the new binary and rolls back on failure.',
    'Always call op=preview first and show the skipped nodes to the user; op=start requires confirm=true.',
    'Poll op=status for progress.',
].join(' ');

function actorFor(apiKey) {
    return apiKey ? `mcp:${String(apiKey.name || apiKey._id || 'key').slice(0, 60)}` : 'mcp:session';
}

async function resolveNodeIds(parsed) {
    if (parsed.all) return bulkActionService.allNodeIds(parsed.action);
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

        case 'preview': {
            requireAction(parsed);
            return bulkActionService.preview({
                action: parsed.action,
                nodeIds: await resolveNodeIds(parsed),
                params: { version: parsed.version },
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
                params: { version: parsed.version },
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
