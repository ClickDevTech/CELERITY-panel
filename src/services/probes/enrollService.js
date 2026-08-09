/**
 * Probe enrollment
 *
 * Every probe owns a hidden HyUser carrying its own subscription. That user is
 * excluded from listings and statistics but still takes part in node sync, so
 * the probe authenticates against nodes exactly like a real client.
 *
 * Security model agreed for the first version: plain credentials plus a traffic
 * cap, and removal of a probe removes its user and subscription immediately.
 * No IP or ASN pinning, so revocation speed is what limits the blast radius.
 */

const crypto = require('crypto');
const Probe = require('../../models/probeModel');
const HyUser = require('../../models/hyUserModel');
const HyNode = require('../../models/hyNodeModel');
const ProbeResult = require('../../models/probeResultModel');
const ProbeTargetResult = require('../../models/probeTargetResultModel');
const cryptoService = require('../cryptoService');
const logger = require('../../utils/logger');
const { getSettings, invalidateUserCache } = require('../../utils/helpers');

/**
 * Deterministic hidden user id for a probe.
 */
function probeUserId(probeDoc) {
    return `probe-${String(probeDoc._id)}`;
}

/**
 * Ids of every node a probe should be able to dial. Virtual nodes are included
 * on purpose: they are urltest groups in the subscription, and checking the
 * group is what tells whether the balancer picks a working leaf.
 */
async function checkableNodeIds() {
    const nodes = await HyNode.find({ active: true }).select('_id').lean();
    return nodes.map((n) => String(n._id));
}

/**
 * Push the probe user onto the running Xray instances. Without this the user
 * exists only in the database until the next full sync, and every Xray inbound
 * answers auth_rejected in the meantime.
 */
function pushProbeUserToNodes(user) {
    try {
        const syncService = require('../syncService');
        const plain = typeof user.toObject === 'function' ? user.toObject() : user;
        syncService.addUserToAllXrayNodes(plain).catch((err) => {
            logger.warn(`[Probes] Could not push probe user to nodes: ${err.message}`);
        });
    } catch (err) {
        logger.warn(`[Probes] Node push unavailable: ${err.message}`);
    }
}

/**
 * Create (or repair) the hidden subscription user backing a probe and bind it
 * to every active node. Probe users are pinned explicitly rather than by group
 * so a probe always sees the full fleet.
 */
async function ensureProbeUser(probeDoc) {
    const settings = await getSettings();
    const trafficLimit = settings?.probes?.probeTrafficLimitBytes || 0;

    const userId = probeUserId(probeDoc);
    let user = await HyUser.findOne({ userId });

    if (user) {
        // A repeat call is the common case: it happens on every profile poll,
        // so it must not write or drop caches unless something really changed.
        if (String(probeDoc.probeUserId || '') !== String(user._id)) {
            await Probe.updateOne({ _id: probeDoc._id }, { $set: { probeUserId: user._id } });
        }
        return user;
    }

    const nodeIds = await checkableNodeIds();
    user = await HyUser.create({
        userId,
        username: `Probe: ${probeDoc.name}`,
        password: cryptoService.generatePassword(userId),
        groups: [],
        nodes: nodeIds,
        enabled: true,
        trafficLimit,
        maxDevices: 0,
        hwidMode: 'off',
        isProbe: true,
    });
    logger.info(`[Probes] Created hidden probe user ${userId}`);

    await Probe.updateOne({ _id: probeDoc._id }, { $set: { probeUserId: user._id } });
    await invalidateUserCache(userId, user.subscriptionToken);
    pushProbeUserToNodes(user);

    return user;
}

/**
 * Keep the probe user bound to the current set of active nodes. Called on every
 * profile poll so newly added nodes become checkable without extra plumbing.
 */
async function syncProbeUserNodes(user) {
    const nodeIds = await checkableNodeIds();

    const current = (user.nodes || []).map((id) => String(id._id || id));
    const changed = current.length !== nodeIds.length
        || nodeIds.some((id) => !current.includes(id));

    if (!changed) return false;

    await HyUser.updateOne({ _id: user._id }, { $set: { nodes: nodeIds } });
    await invalidateUserCache(user.userId, user.subscriptionToken);
    pushProbeUserToNodes(user);
    logger.info(`[Probes] Rebound probe user ${user.userId} to ${nodeIds.length} nodes`);
    return true;
}

/**
 * Create a probe and return the one-time enrollment token.
 */
async function createProbe({ name, createdBy }) {
    const { doc, enrollToken } = await Probe.createProbe({ name, createdBy });
    return { probe: doc, enrollToken };
}

/**
 * Exchange a one-time enrollment token for the permanent probe token.
 * The hidden user is created here, on first contact from the probe.
 */
async function enroll(enrollToken, meta = {}) {
    const probe = await Probe.findByEnrollToken(enrollToken);
    if (!probe) return null;

    const user = await ensureProbeUser(probe);
    const token = await Probe.issueToken(probe._id);

    await Probe.updateOne(
        { _id: probe._id },
        {
            $set: {
                version: meta.version || '',
                singboxVersion: meta.singboxVersion || '',
                os: meta.os || '',
                arch: meta.arch || '',
                egressIp: meta.egressIp || '',
                lastSeenAt: new Date(),
            },
        }
    );

    logger.info(`[Probes] Probe ${probe.name} enrolled`);
    return { probe, token, subscriptionToken: user.subscriptionToken };
}

/**
 * Regenerate the enrollment token so an existing probe can be re-installed.
 */
async function regenerateEnrollToken(probeId) {
    const enrollToken = `ce_${crypto.randomBytes(16).toString('hex')}`;
    await Probe.updateOne(
        { _id: probeId },
        {
            $set: {
                enrollTokenHash: Probe.hashToken(enrollToken),
                enrollExpiresAt: new Date(Date.now() + Probe.ENROLL_TTL_MS),
                tokenHash: '',
                tokenPrefix: '',
                tokenEncrypted: '',
            },
        }
    );
    return enrollToken;
}

/**
 * Apply a changed traffic cap to the probes that already exist. A cap that only
 * covers future probes would not bound the operator's traffic at all.
 */
async function applyProbeTrafficLimit(trafficLimit) {
    const result = await HyUser.updateMany(
        { isProbe: true },
        { $set: { trafficLimit } }
    );
    if (result.modifiedCount) {
        await require('../cacheService').invalidateAllSubscriptions();
        logger.info(`[Probes] Traffic limit applied to ${result.modifiedCount} probe users`);
    }
    return result.modifiedCount || 0;
}

/**
 * Delete a probe together with its hidden user, subscription and results.
 * Revocation must be immediate: the credentials are plain, so removal speed is
 * the only thing bounding their lifetime.
 */
async function deleteProbe(probeId) {
    const probe = await Probe.findById(probeId);
    if (!probe) return false;

    const userId = probeUserId(probe);
    const user = await HyUser.findOne({ userId });

    if (user) {
        await HyUser.deleteOne({ _id: user._id });
        await invalidateUserCache(userId, user.subscriptionToken);

        // Drop the user from the running Xray instances right away.
        try {
            const syncService = require('../syncService');
            await syncService.removeUserFromAllXrayNodes(user.toObject());
        } catch (err) {
            logger.warn(`[Probes] Could not push probe user removal: ${err.message}`);
        }
    }

    await Promise.all([
        ProbeResult.deleteMany({ probeId: probe._id }),
        ProbeTargetResult.deleteMany({ probeId: probe._id }),
    ]);
    await Probe.deleteOne({ _id: probe._id });

    logger.info(`[Probes] Deleted probe ${probe.name} and its hidden user`);
    return true;
}

module.exports = {
    createProbe,
    enroll,
    ensureProbeUser,
    syncProbeUserNodes,
    applyProbeTrafficLimit,
    regenerateEnrollToken,
    deleteProbe,
    probeUserId,
};
