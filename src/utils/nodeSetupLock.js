/**
 * Per-node guard for remote install operations.
 *
 * Node setup and an Xray version change both push an installer over SSH to the
 * same host. Running them at once leaves the node half-provisioned, so every
 * entry point takes this lock first.
 */

const active = new Map();

function holder(nodeId) {
    return active.get(String(nodeId)) || null;
}

/**
 * @returns {boolean} false when another operation already holds the lock
 */
function acquire(nodeId, label) {
    const key = String(nodeId);
    if (active.has(key)) return false;
    active.set(key, label);
    return true;
}

function release(nodeId) {
    active.delete(String(nodeId));
}

module.exports = { acquire, release, holder };
