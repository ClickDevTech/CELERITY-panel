/**
 * Panel routes: system stats, logs, backup/restore.
 */

const router = require('express').Router();
const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { createReadStream } = require('fs');
const readline = require('readline');

const HyNode = require('../../models/hyNodeModel');
const Settings = require('../../models/settingsModel');
const cache = require('../../services/cacheService');
const backupService = require('../../services/backupService');
const hostMetrics = require('../../services/hostMetricsService');
const logger = require('../../utils/logger');
const { backupUpload } = require('./helpers');

// ─── Log Helpers ─────────────────────────────────────────────────────────────

async function getCombinedLogFiles(logsDir) {
    try {
        await fsp.access(logsDir);
    } catch {
        return [];
    }

    const dirEntries = await fsp.readdir(logsDir, { withFileTypes: true });
    const logEntries = dirEntries.filter(
        (entry) => entry.isFile() && entry.name.startsWith('combined') && entry.name.endsWith('.log')
    );

    const files = await Promise.all(
        logEntries.map(async (entry) => {
            const fullPath = path.join(logsDir, entry.name);
            const stat = await fsp.stat(fullPath);
            return {
                name: entry.name,
                path: fullPath,
                mtime: stat.mtime,
            };
        })
    );

    return files.sort((a, b) => b.mtime - a.mtime);
}

async function readLastLogLines(filePath, maxLines) {
    const tail = [];
    const rl = readline.createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line) continue;
        tail.push(line);
        if (tail.length > maxLines) {
            tail.shift();
        }
    }

    return tail.reverse();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /panel/system-stats
router.get('/system-stats', async (req, res) => {
    try {
        const cpus = os.cpus();
        const loadAvg = os.loadavg();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const processMemory = process.memoryUsage();

        const snap = hostMetrics.getSnapshot();

        const cacheStats = await cache.getStats();

        const activeNodes = await HyNode.find({ active: true }).select('onlineUsers').lean();
        const totalConnections = activeNodes.reduce((sum, n) => sum + (n.onlineUsers || 0), 0);

        res.json({
            success: true,
            cpu: {
                cores: cpus.length,
                model: cpus[0]?.model || 'Unknown',
                percent: snap.cpuPct,
                load1: loadAvg[0],
                load5: loadAvg[1],
                load15: loadAvg[2],
            },
            mem: {
                total: totalMem,
                used: snap.memUsed,
                free: freeMem,
                percent: snap.memPct,
            },
            disk: {
                total: snap.diskTotal,
                free: snap.diskFree,
                used: Math.max(snap.diskTotal - snap.diskFree, 0),
                percent: snap.diskPct,
            },
            process: {
                heapUsed: processMemory.heapUsed,
                heapTotal: processMemory.heapTotal,
                rss: snap.rss,
            },
            requests: {
                rps: snap.rps,
                rpm: snap.rpm,
            },
            connections: totalConnections,
            cache: cacheStats,
            uptime: Math.floor(process.uptime()),
            platform: os.platform(),
            nodeVersion: process.version,
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /panel/logs
router.get('/logs', async (req, res) => {
    try {
        const logsDir = path.join(__dirname, '../../../logs');
        let logs = [];

        const files = await getCombinedLogFiles(logsDir);

        if (files.length > 0) {
            logs = await readLastLogLines(files[0].path, 100);
        }

        res.json({ logs });
    } catch (error) {
        logger.error(`[Panel] Logs read error: ${error.message}`);
        res.json({ logs: [], error: error.message });
    }
});

// GET /panel/logs/search
router.get('/logs/search', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit) || 200, 500);

        if (!q) {
            return res.json({ matches: [], total: 0 });
        }

        const logsDir = path.join(__dirname, '../../../logs');
        const files = await getCombinedLogFiles(logsDir);

        const qLower = q.toLowerCase();
        const matches = [];
        let total = 0;

        for (const file of files) {
            const fileMatches = [];
            const rl = readline.createInterface({
                input: createReadStream(file.path, { encoding: 'utf8' }),
                crlfDelay: Infinity,
            });

            for await (const line of rl) {
                if (!line) continue;

                if (line.toLowerCase().includes(qLower)) {
                    total += 1;
                    fileMatches.push(line);

                    if (fileMatches.length > limit) {
                        fileMatches.shift();
                    }
                }
            }

            for (let i = fileMatches.length - 1; i >= 0 && matches.length < limit; i -= 1) {
                matches.push(fileMatches[i]);
            }
        }

        res.json({ matches, total });
    } catch (error) {
        logger.error(`[Panel] Logs search error: ${error.message}`);
        res.json({ matches: [], total: 0, error: error.message });
    }
});

// POST /panel/backup
router.post('/backup', async (req, res) => {
    try {
        const settings = await Settings.get();
        const result = await backupService.createBackup(settings);

        if (result.s3?.enabled && !result.s3.success) {
            res.setHeader('X-Celerity-S3-Status', 'failed');
            res.setHeader('X-Celerity-S3-Error', encodeURIComponent(result.s3.error || 'unknown'));
        }

        res.download(result.path, result.filename, (err) => {
            if (err) {
                logger.error(`[Backup] Send error: ${err.message}`);
            }
        });
    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// POST /panel/restore
router.post('/restore', backupUpload.single('backup'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл backup не загружен' });
    }

    try {
        const result = await backupService.restoreUploadedBackup(req.file.path, req.file.originalname);
        res.json({
            success: true,
            message: 'База данных успешно восстановлена',
            warning: result?.encryptionKey?.status === 'mismatch'
                ? (res.locals.t?.('settings.restoreKeyMismatch') || 'Backup was created with a different ENCRYPTION_KEY')
                : null,
        });
    } catch (error) {
        logger.error(`[Restore] Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    } finally {
        await fsp.unlink(req.file.path).catch(() => {});
    }
});

module.exports = router;
