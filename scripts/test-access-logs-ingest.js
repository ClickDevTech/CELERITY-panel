/**
 * End-to-end-ish test for the panel-side ingest spool + processor (no HTTP, no
 * ClickHouse). Verifies:
 *   - persistBatch writes an atomic sealed file and lists it,
 *   - the processor parses NDJSON into { node_id, raw } rows,
 *   - client-IP masking rewrites the raw line in place,
 *   - with ClickHouse not configured, the batch stays spooled (never acked
 *     without a persisted write) — the at-least-once invariant.
 *
 * Batch dedup lives in Redis (cacheService), so it is not exercised here.
 *
 * Uses a throwaway ACCESS_LOGS_DIR so it never touches real data.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const zlib = require('zlib');
const assert = require('assert');

// Point the pipeline at a temp dir BEFORE requiring modules that read it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'al-ingest-'));
process.env.ACCESS_LOGS_DIR = TMP;

// No MongoDB in this test: disable mongoose op buffering so a settings read
// (used to check the maskClientIp flag) fails fast instead of hanging.
try { require('mongoose').set('bufferTimeoutMS', 1); } catch (_) { /* mongoose optional */ }

(async () => {
    const spoolService = require('../src/services/accessLogs/spoolService');
    const processService = require('../src/services/accessLogs/processService');
    const crypto = require('crypto');

    const nodeId = 'node123';

    function xrayLine(d, ip) {
        const y = d.getUTCFullYear();
        const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
        const da = String(d.getUTCDate()).padStart(2, '0');
        const h = String(d.getUTCHours()).padStart(2, '0');
        const mi = String(d.getUTCMinutes()).padStart(2, '0');
        const s = String(d.getUTCSeconds()).padStart(2, '0');
        return `${y}/${mo}/${da} ${h}:${mi}:${s} ${ip}:5555 accepted tcp:example.com:443 [vless-in -> direct] email: user@x`;
    }
    const line = xrayLine(new Date(), '1.2.3.4');

    const ndjson =
        JSON.stringify({ offset: 10, raw: line, read_at: new Date().toISOString() }) + '\n';
    const gz = zlib.gzipSync(Buffer.from(ndjson, 'utf8'));
    const batchId = crypto.createHash('sha256').update(gz).digest('hex');

    // Persist + verify it is listed.
    const { path: spoolPath } = await spoolService.persistBatch(nodeId, batchId, gz);
    assert.ok(fs.existsSync(spoolPath), 'spool file exists');
    let list = await spoolService.listSpool();
    assert.strictEqual(list.length, 1, 'one spooled batch');

    // parseSpoolFile yields raw rows tagged with the node id.
    const parsed = await processService.parseSpoolFile(spoolPath, false);
    assert.strictEqual(parsed.rows.length, 1, 'one parsed row');
    assert.strictEqual(parsed.rows[0].node_id, nodeId, 'row tagged with node id');
    assert.ok(parsed.rows[0].raw.includes('1.2.3.4'), 'raw line preserved');

    // IP masking primitives: IPv4 keeps /24, IPv6 keeps three hextets.
    assert.strictEqual(processService.maskIp('192.168.1.33'), '192.168.1.0', 'IPv4 masked to /24');
    assert.strictEqual(processService.maskIp('2001:db8:abcd:12:34::1'), '2001:db8:abcd::', 'IPv6 masked');
    assert.strictEqual(processService.maskIp(''), '', 'empty stays empty');

    // Masking rewrites the source IP in the raw line (/24).
    const masked = processService.maskRawLine(line);
    assert.ok(masked.includes('1.2.3.0'), 'masked to /24');
    assert.ok(!masked.includes('1.2.3.4:'), 'original source ip scrubbed');

    // Drain with ClickHouse NOT configured: batch must stay spooled (never ack
    // without a persisted write) — the at-least-once invariant.
    await processService.drainOnce();
    list = await spoolService.listSpool();
    assert.strictEqual(list.length, 1, 'batch stays spooled when ClickHouse not configured');

    // Simulate a restart between rename and unlink, then overlapping removals.
    // The original unprocessed batch must remain visible and intact.
    const discarded = path.join(path.dirname(spoolPath), '.discarded');
    await fsp.writeFile(discarded, gz);
    assert.deepStrictEqual(await spoolService.listSpool(), [spoolPath]);
    const finished = await Promise.all(Array.from({ length: 16 }, (_, i) =>
        spoolService.persistBatch('other-' + i, batchId, gz)));
    await Promise.all([...finished, finished[0]].map(batch => spoolService.removeSpoolFile(batch.path)));
    assert.deepStrictEqual(await spoolService.listSpool(), [spoolPath]);
    assert.deepStrictEqual(await fsp.readFile(spoolPath), gz);
    await assert.rejects(fsp.stat(discarded), { code: 'ENOENT' });

    await fsp.rm(TMP, { recursive: true, force: true });
    console.log('test-access-logs-ingest: OK');
})().catch(async (e) => {
    console.error('test-access-logs-ingest FAILED:', e);
    try { await fsp.rm(TMP, { recursive: true, force: true }); } catch (_) {}
    process.exit(1);
});
