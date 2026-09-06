const SERVERLESS_NODE_TYPES = new Set(['virtual', 'cdn']);

function isServerlessNode(nodeOrType) {
    const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType?.type;
    return SERVERLESS_NODE_TYPES.has(type);
}

/**
 * Refuse a conversion that would strip a node still wired into a cascade link
 * of its IP and SSH credentials — the tunnel would keep pointing at a host that
 * no longer exists in the DB and fail on the next deploy.
 *
 * @param {Object} node - node as stored before the update
 * @param {string} nextType - type the update would apply
 * @returns {Promise<string|null>} error message, or null when the change is safe
 */
async function checkCascadeMembership(node, nextType) {
    if (!node || !isServerlessNode(nextType) || isServerlessNode(node.type)) return null;
    const CascadeLink = require('../models/cascadeLinkModel');
    const link = await CascadeLink.findOne({
        $or: [{ portalNode: node._id }, { bridgeNode: node._id }],
    }).select('name').lean();
    if (link) {
        return `Node is part of cascade link "${link.name}" — remove the link before converting it to ${nextType}`;
    }
    return null;
}

module.exports = {
    SERVERLESS_NODE_TYPES,
    isServerlessNode,
    checkCascadeMembership,
};
