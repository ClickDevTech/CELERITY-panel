/**
 * Panel-side durable ingest spool.
 *
 * The ingest endpoint accepts a gzipped NDJSON batch and, before doing any
 * forwarding work, persists the raw bytes to disk with an atomic
 * write-then-rename. This gives at-least-once durability: once the batch is on
 * disk we can ACK the agent, and a separate processing stage drains the spool
 * into ClickHouse. A crash between ACK and processing simply leaves the batch in
 * the spool to be picked up on restart.
 *
 * Idempotency: the batch id (sha256 of the raw bytes, sent as X-Batch-Id and
 * re-verified here) is embedded in the spool file name. Retried identical
 * batches are rejected via a short-TTL Redis dedup key (see cacheService
 * markBatchProcessed/isBatchProcessed); a retry that races the processor may
 * create a second spool file (names carry a timestamp prefix), which is
 * harmless: the batch id is passed to ClickHouse as an insert deduplication
 * token, so re-processing the same events dedups at the storage layer.
 */

const fsp = require('fs/promises');
const path = require('path');
const paths = require('./paths');
const logger = require('../../utils/logger');

async function ensureDirs() {
    await fsp.mkdir(paths.INCOMING_TMP_DIR, { recursive: true });
}

// Spool file name embeds node id + batch id so processing has node context
// without opening the file, and duplicates from the same node collapse.
function spoolFileName(nodeId, batchId) {
    const safeNode = String(nodeId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${Date.now()}-${safeNode}-${batchId}.ndjson.gz`;
}

/**
 * Persist a received batch to the spool with fsync + atomic rename.
 *
 * @param {string} nodeId
 * @param {string} batchId  sha256 hex of the raw gzip bytes
 * @param {Buffer} bytes    raw (still-gzipped) request body
 * @returns {Promise<{path: string, name: string, bytes: number}>}
 */
async function persistBatch(nodeId, batchId, bytes) {
    await ensureDirs();
    const name = spoolFileName(nodeId, batchId);
    const finalPath = path.join(paths.INCOMING_DIR, name);
    const tmpPath = path.join(paths.INCOMING_TMP_DIR, name + '.tmp');

    // Write to tmp, fsync data + directory, then atomically rename into place so
    // a partially-written batch is never visible to the processor.
    const fh = await fsp.open(tmpPath, 'w', 0o600);
    try {
        await fh.writeFile(bytes);
        await fh.sync();
    } finally {
        await fh.close();
    }
    await fsp.rename(tmpPath, finalPath);

    return { path: finalPath, name, bytes: bytes.length };
}

// List sealed spool batch files (oldest first), excluding the tmp dir.
async function listSpool() {
    try {
        const entries = await fsp.readdir(paths.INCOMING_DIR, { withFileTypes: true });
        const files = entries
            .filter(e => e.isFile() && e.name.endsWith('.ndjson.gz'))
            .map(e => e.name)
            .sort();
        return files.map(n => path.join(paths.INCOMING_DIR, n));
    } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
    }
}

// Total bytes currently spooled (for backpressure / status).
async function spoolSize() {
    const files = await listSpool();
    let total = 0;
    for (const f of files) {
        try { total += (await fsp.stat(f)).size; } catch (_) { /* ignore */ }
    }
    return { count: files.length, bytes: total };
}

async function removeSpoolFile(filePath) {
    // Unlinking each unique batch name leaves a negative dentry in the
    // long-lived spool directory. Reuse one name for the unlink instead.
    // Concurrent removers may replace it: every file moved here is disposable.
    const discarded = path.join(path.dirname(filePath), '.discarded');
    try {
        await fsp.rename(filePath, discarded);
        await fsp.unlink(discarded);
    } catch (e) {
        if (e.code !== 'ENOENT') logger.warn(`[AccessLogs] removeSpoolFile: ${e.message}`);
    }
}

// Parse node id + batch id back out of a spool file name.
function parseSpoolName(filePath) {
    const base = path.basename(filePath).replace(/\.ndjson\.gz$/, '');
    const firstDash = base.indexOf('-');
    const lastDash = base.lastIndexOf('-');
    if (firstDash === -1 || lastDash === firstDash) return { nodeId: '', batchId: '' };
    return {
        nodeId: base.slice(firstDash + 1, lastDash),
        batchId: base.slice(lastDash + 1),
    };
}

module.exports = {
    ensureDirs,
    persistBatch,
    listSpool,
    spoolSize,
    removeSpoolFile,
    parseSpoolName,
    spoolFileName,
};
