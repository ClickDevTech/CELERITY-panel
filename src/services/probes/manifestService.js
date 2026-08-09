/**
 * Probe manifest
 *
 * Tells a probe what to check and how to map subscription outbounds back to
 * panel entities. The probe consumes the regular sing-box subscription, whose
 * outbound tags are human-readable names, so the manifest carries the expected
 * tag for every node inbound. Both sides are produced by the same helpers in
 * the subscription module, which keeps the mapping exact.
 */

const HyNode = require('../../models/hyNodeModel');
const ServerGroup = require('../../models/serverGroupModel');
const subscription = require('../../routes/subscription');
const appConfig = require('../../../config');
const { getSettings } = require('../../utils/helpers');

// Inbound identifiers are stable per node and never collide:
// 'hysteria' for Hysteria nodes, 'main' for the primary Xray inbound,
// the extra inbound UUID for additional ones, 'group' for virtual nodes.
const INBOUND_MAIN = 'main';
const INBOUND_HYSTERIA = 'hysteria';
const INBOUND_GROUP = 'group';

/**
 * Resolve the panel base URL used for subscription and ingest links.
 */
function resolveBaseUrl(settings) {
    const explicit = (settings?.probes?.ingestUrl || '').trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const base = (appConfig.BASE_URL || '').replace(/\/+$/, '');
    if (base) return base;
    return appConfig.PANEL_DOMAIN ? `https://${appConfig.PANEL_DOMAIN}` : '';
}

/**
 * Describe every checkable inbound of a non-virtual node.
 */
function describeNodeInbounds(node) {
    if (node.type === 'hysteria') {
        const configs = subscription.getNodeConfigs(node) || [];
        return configs.map((cfg, idx) => ({
            inboundId: configs.length > 1 ? `${INBOUND_HYSTERIA}:${idx}` : INBOUND_HYSTERIA,
            inboundTag: '',
            label: cfg.name || '',
            protocol: 'hysteria2',
            host: cfg.host,
            port: cfg.port || 0,
            portRange: cfg.portRange || '',
            expectedTag: `${node.flag || ''} ${node.name} ${cfg.name}`.trim(),
        }));
    }

    if (node.type === 'xray') {
        const inbounds = subscription.getXrayPublishedInbounds(node) || [];
        return inbounds.map((inbound) => ({
            inboundId: inbound.extraId || INBOUND_MAIN,
            inboundTag: inbound.inboundTag || node.xray?.inboundTag || 'vless-in',
            label: inbound.nameSuffix || '',
            protocol: 'vless',
            host: node.domain || node.ip,
            port: inbound.port || node.port || 443,
            portRange: '',
            transport: inbound.transport || 'tcp',
            security: inbound.security || 'reality',
            expectedTag: subscription.xrayInboundName(node, inbound),
        }));
    }

    return [];
}

/**
 * Resolve the leaf nodes a virtual node balances over.
 */
async function resolveVirtualLeaves(node) {
    const virtual = node.virtual || {};
    if (virtual.selectMode === 'group' && virtual.sourceGroup) {
        const leaves = await HyNode.find({
            groups: virtual.sourceGroup,
            active: true,
            type: { $ne: 'virtual' },
        }).select('_id').lean();
        return leaves.map((n) => String(n._id));
    }
    return (virtual.sources || []).map((id) => String(id));
}

/**
 * Build the full manifest for a probe.
 */
async function buildManifest(probe, subscriptionToken) {
    const settings = await getSettings();
    const baseUrl = resolveBaseUrl(settings);

    const nodes = await HyNode.find({ active: true })
        .select('name flag type ip domain port portRange portConfigs sni obfs hopInterval xray virtual groups')
        .lean();

    const byId = new Map(nodes.map((n) => [String(n._id), n]));
    const entries = [];

    for (const node of nodes) {
        if (node.type === 'virtual') continue;
        const inbounds = describeNodeInbounds(node);
        if (inbounds.length === 0) continue;
        entries.push({
            nodeId: String(node._id),
            name: node.name,
            type: node.type,
            isGroup: false,
            inbounds,
        });
    }

    for (const node of nodes) {
        if (node.type !== 'virtual') continue;
        const leafIds = (await resolveVirtualLeaves(node)).filter((id) => byId.has(id));
        if (leafIds.length === 0) continue;
        entries.push({
            nodeId: String(node._id),
            name: node.name,
            type: 'virtual',
            isGroup: true,
            leafNodeIds: leafIds,
            inbounds: [{
                inboundId: INBOUND_GROUP,
                inboundTag: '',
                label: '',
                protocol: 'urltest',
                expectedTag: `${node.flag || ''} ${node.name}`.trim(),
            }],
        });
    }

    const probeSettings = settings?.probes || {};
    const targets = (probeSettings.targets || [])
        .filter((t) => t.enabled !== false && t.url)
        .map((t) => ({ id: t.id, url: t.url, label: t.label || '' }));

    return {
        probeId: String(probe._id),
        name: probe.name,
        subscriptionUrl: baseUrl ? `${baseUrl}/api/files/${subscriptionToken}?format=singbox` : '',
        ingestUrl: baseUrl ? `${baseUrl}/api/probe/ingest` : '',
        intervals: {
            transportSec: probeSettings.transportIntervalSec || 300,
            targetsSec: probeSettings.targetsIntervalSec || 3600,
            reportSec: probeSettings.reportIntervalSec || 900,
        },
        speedTest: {
            enabled: !!probeSettings.speedTest?.enabled,
            maxBytes: probeSettings.speedTest?.maxBytes || 0,
            maxSeconds: probeSettings.speedTest?.maxSeconds || 5,
            dailyBudgetBytes: probeSettings.speedTest?.dailyBudgetBytes || 0,
        },
        targets,
        nodes: entries,
    };
}

module.exports = {
    buildManifest,
    describeNodeInbounds,
    resolveVirtualLeaves,
    resolveBaseUrl,
    INBOUND_MAIN,
    INBOUND_HYSTERIA,
    INBOUND_GROUP,
};
