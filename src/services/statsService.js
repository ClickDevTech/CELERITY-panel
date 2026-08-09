const StatsSnapshot = require('../models/statsSnapshotModel');
const HyNode = require('../models/hyNodeModel');
const HyUser = require('../models/hyUserModel');
const cache = require('./cacheService');
const hostMetrics = require('./hostMetricsService');
const logger = require('../utils/logger');

let previousTraffic = new Map();

const CACHE_KEYS = {
    SUMMARY: 'stats:summary',
    ONLINE: 'stats:online:',
    TRAFFIC: 'stats:traffic:',
    NODES: 'stats:nodes:',
    HOST: 'stats:host:',
};

const CACHE_TTL = {
    SUMMARY: 60,
    CHARTS: 120,
};

class StatsService {
    constructor() {
        this.lastHourlySnapshot = null;
        this.lastDailySnapshot = null;
    }
    
    roundTo5Minutes(date) {
        const ms = date.getTime();
        return new Date(Math.floor(ms / (5 * 60 * 1000)) * (5 * 60 * 1000));
    }
    
    roundToHour(date) {
        const d = new Date(date);
        d.setMinutes(0, 0, 0);
        return d;
    }
    
    roundToDay(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        return d;
    }

    async collectSnapshot() {
        try {
            const nodes = await HyNode.find({ active: true })
                .select('name domain onlineUsers status traffic')
                .lean();
            
            const nameCount = {};
            for (const node of nodes) {
                nameCount[node.name] = (nameCount[node.name] || 0) + 1;
            }
            
            const userStats = await HyUser.aggregate([
                { $match: { isProbe: { $ne: true } } },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        active: { $sum: { $cond: ['$enabled', 1, 0] } }
                    }
                }
            ]);
            
            const users = userStats[0] || { total: 0, active: 0 };
            
            let totalOnline = 0;
            let nodesOnline = 0;
            let trafficTx = 0;
            let trafficRx = 0;
            const nodeStats = [];
            
            for (const node of nodes) {
                totalOnline += node.onlineUsers || 0;
                if (node.status === 'online') nodesOnline++;
                
                const nodeId = node._id.toString();
                const currTx = node.traffic?.tx || 0;
                const currRx = node.traffic?.rx || 0;
                
                // Declare deltas at node scope so they are available for the snapshot push below
                let deltaTx = 0, deltaRx = 0;

                // Only count delta if we have previous values (skip first run after restart)
                if (previousTraffic.has(nodeId)) {
                    const prev = previousTraffic.get(nodeId);
                    // If current >= prev use the difference; if counter reset use current as delta
                    deltaTx = currTx >= prev.tx ? currTx - prev.tx : currTx;
                    deltaRx = currRx >= prev.rx ? currRx - prev.rx : currRx;
                    trafficTx += deltaTx;
                    trafficRx += deltaRx;
                }
                // Always update previous values for next iteration
                previousTraffic.set(nodeId, { tx: currTx, rx: currRx });
                
                const displayName = nameCount[node.name] > 1 && node.domain
                    ? `${node.name} (${node.domain.split('.')[0]})`
                    : node.name;
                
                nodeStats.push({
                    i: node._id.toString(),
                    n: displayName,
                    o: node.onlineUsers || 0,
                    s: node.status,
                    t: deltaTx,
                    r: deltaRx,
                });
            }
            
            let host = {};
            try {
                host = hostMetrics.consumeSnapshot();
            } catch (e) {
                logger.warn(`[Stats] hostMetrics.consumeSnapshot failed: ${e.message}`);
            }

            return {
                online: totalOnline,
                users: users.total,
                activeUsers: users.active,
                tx: trafficTx,
                rx: trafficRx,
                nodesOn: nodesOnline,
                nodesTotal: nodes.length,
                nodes: nodeStats,
                host,
            };
        } catch (error) {
            logger.error(`[Stats] Collect error: ${error.message}`);
            return null;
        }
    }
    
    async saveHourlySnapshot() {
        try {
            const timestamp = this.roundTo5Minutes(new Date());

            // Dedupe BEFORE collectSnapshot — otherwise the host metrics
            // accumulator inside hostMetricsService.consumeSnapshot would be
            // burnt for nothing on the duplicate call.
            if (this.lastHourlySnapshot?.getTime() === timestamp.getTime()) {
                return;
            }

            const snapshot = await this.collectSnapshot();
            if (!snapshot) return;

            await StatsSnapshot.upsertSnapshot('hourly', timestamp, snapshot);
            
            this.lastHourlySnapshot = timestamp;
            
            await this.invalidateCache();
            
            logger.debug(`[Stats] Hourly snapshot: online=${snapshot.online}, traffic=${((snapshot.tx + snapshot.rx) / 1024 / 1024).toFixed(1)}MB`);
            
        } catch (error) {
            if (error.code !== 11000) {
                logger.error(`[Stats] Save hourly error: ${error.message}`);
            }
        }
    }

    // Merge multiple snapshot node arrays: sum t/r deltas, keep last o/s per node
    _mergeNodeArrays(allArrays) {
        const map = new Map();
        for (const arr of allArrays) {
            if (!arr) continue;
            for (const n of arr) {
                const key = n.i || n.n;
                if (!map.has(key)) {
                    map.set(key, { i: n.i, n: n.n, o: n.o, s: n.s, t: 0, r: 0 });
                }
                const entry = map.get(key);
                entry.t += n.t || 0;
                entry.r += n.r || 0;
                // Last snapshot wins for point-in-time fields
                entry.o = n.o;
                entry.s = n.s;
            }
        }
        return Array.from(map.values());
    }

    _hostGroupStage() {
        return {
            avgCpuPct:   { $avg: '$host.cpuPct' },
            avgLoad1:    { $avg: '$host.load1' },
            avgMemPct:   { $avg: '$host.memPct' },
            avgMemUsed:  { $avg: '$host.memUsed' },
            avgRss:      { $avg: '$host.rss' },
            avgHeapUsed: { $avg: '$host.heapUsed' },
            avgRps:      { $avg: '$host.rps' },
            avgRpm:      { $avg: '$host.rpm' },
            avgDiskPct:   { $avg: '$host.diskPct' },
            avgDiskFree:  { $avg: '$host.diskFree' },
            lastDiskTotal: { $last: '$host.diskTotal' },
        };
    }

    _hostFromAgg(data) {
        return {
            cpuPct:   Math.round(data.avgCpuPct   || 0),
            load1:    Number((data.avgLoad1 || 0).toFixed(2)),
            memPct:   Math.round(data.avgMemPct   || 0),
            memUsed:  Math.round(data.avgMemUsed  || 0),
            rss:      Math.round(data.avgRss      || 0),
            heapUsed: Math.round(data.avgHeapUsed || 0),
            rps:      Math.round(data.avgRps      || 0),
            rpm:      Math.round(data.avgRpm      || 0),
            diskPct:   Math.round(data.avgDiskPct  || 0),
            diskFree:  Math.round(data.avgDiskFree || 0),
            diskTotal: Math.round(data.lastDiskTotal || 0),
        };
    }

    async saveDailySnapshot() {
        try {
            const currentHour = this.roundToHour(new Date());
            
            if (this.lastDailySnapshot?.getTime() === currentHour.getTime()) {
                return;
            }
            
            const hourAgo = new Date(currentHour.getTime() - 60 * 60 * 1000);
            
            const agg = await StatsSnapshot.aggregate([
                {
                    $match: {
                        type: 'hourly',
                        ts: { $gte: hourAgo, $lt: currentHour }
                    }
                },
                {
                    $group: {
                        _id: null,
                        avgOnline: { $avg: '$online' },
                        avgNodesOn: { $avg: '$nodesOn' },
                        totalTx: { $sum: '$tx' },
                        totalRx: { $sum: '$rx' },
                        lastUsers: { $last: '$users' },
                        lastActiveUsers: { $last: '$activeUsers' },
                        lastNodesTotal: { $last: '$nodesTotal' },
                        allNodesArrays: { $push: '$nodes' },
                        count: { $sum: 1 },
                        ...this._hostGroupStage(),
                    }
                }
            ]);
            
            if (!agg.length || agg[0].count === 0) {
                const snapshot = await this.collectSnapshot();
                if (snapshot) {
                    await StatsSnapshot.upsertSnapshot('daily', currentHour, snapshot);
                }
            } else {
                const data = agg[0];
                await StatsSnapshot.upsertSnapshot('daily', currentHour, {
                    online: Math.round(data.avgOnline),
                    users: data.lastUsers,
                    activeUsers: data.lastActiveUsers,
                    tx: data.totalTx,
                    rx: data.totalRx,
                    nodesOn: Math.round(data.avgNodesOn),
                    nodesTotal: data.lastNodesTotal,
                    nodes: this._mergeNodeArrays(data.allNodesArrays),
                    host: this._hostFromAgg(data),
                });
            }
            
            this.lastDailySnapshot = currentHour;
            logger.info(`[Stats] Daily snapshot saved: ${currentHour.toISOString()}`);
            
        } catch (error) {
            if (error.code !== 11000) {
                logger.error(`[Stats] Save daily error: ${error.message}`);
            }
        }
    }
    
    async saveMonthlySnapshot() {
        try {
            const currentDay = this.roundToDay(new Date());
            const dayAgo = new Date(currentDay.getTime() - 24 * 60 * 60 * 1000);
            
            const agg = await StatsSnapshot.aggregate([
                {
                    $match: {
                        type: 'daily',
                        ts: { $gte: dayAgo, $lt: currentDay }
                    }
                },
                {
                    $group: {
                        _id: null,
                        avgOnline: { $avg: '$online' },
                        avgNodesOn: { $avg: '$nodesOn' },
                        totalTx: { $sum: '$tx' },
                        totalRx: { $sum: '$rx' },
                        lastUsers: { $last: '$users' },
                        lastActiveUsers: { $last: '$activeUsers' },
                        lastNodesTotal: { $last: '$nodesTotal' },
                        allNodesArrays: { $push: '$nodes' },
                        count: { $sum: 1 },
                        ...this._hostGroupStage(),
                    }
                }
            ]);
            
            if (!agg.length || agg[0].count === 0) return;
            
            const data = agg[0];
            await StatsSnapshot.upsertSnapshot('monthly', currentDay, {
                online: Math.round(data.avgOnline),
                users: data.lastUsers,
                activeUsers: data.lastActiveUsers,
                tx: data.totalTx,
                rx: data.totalRx,
                nodesOn: Math.round(data.avgNodesOn),
                nodesTotal: data.lastNodesTotal,
                nodes: this._mergeNodeArrays(data.allNodesArrays),
                host: this._hostFromAgg(data),
            });
            
            logger.info(`[Stats] Monthly snapshot saved: ${currentDay.toISOString()}`);
            
        } catch (error) {
            if (error.code !== 11000) {
                logger.error(`[Stats] Save monthly error: ${error.message}`);
            }
        }
    }
    
    async invalidateCache() {
        if (!cache.isConnected()) return;
        
        try {
            // Use SCAN instead of KEYS for non-blocking key search
            const keys = await cache._scanKeys('stats:*');
            if (keys.length > 0) {
                // Delete in batches of 100 keys using UNLINK (non-blocking deletion)
                const BATCH_SIZE = 100;
                for (let i = 0; i < keys.length; i += BATCH_SIZE) {
                    const batch = keys.slice(i, i + BATCH_SIZE);
                    await cache.redis.unlink(...batch);
                }
            }
        } catch (e) {
            // Ignore cache errors
        }
    }
    
    getPeriodParams(period) {
        const endDate = new Date();
        let type, startDate;
        
        switch (period) {
            case '1h':
                type = 'hourly';
                startDate = new Date(endDate.getTime() - 60 * 60 * 1000);
                break;
            case '6h':
                type = 'hourly';
                startDate = new Date(endDate.getTime() - 6 * 60 * 60 * 1000);
                break;
            case '24h':
                type = 'hourly';
                startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
                break;
            case '7d':
                type = 'daily';
                startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
                break;
            case '30d':
                type = 'daily';
                startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
                break;
            case '90d':
                type = 'monthly';
                startDate = new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000);
                break;
            default:
                type = 'hourly';
                startDate = new Date(endDate.getTime() - 24 * 60 * 60 * 1000);
        }
        
        return { type, startDate, endDate };
    }

    async getOnlineChart(period = '24h') {
        const cacheKey = CACHE_KEYS.ONLINE + period;
        
        if (cache.isConnected()) {
            try {
                const cached = await cache.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {}
        }
        
        const { type, startDate, endDate } = this.getPeriodParams(period);
        const data = await StatsSnapshot.getRange(type, startDate, endDate, false);
        
        const result = {
            period,
            type,
            labels: data.map(d => d.ts),
            datasets: {
                online: data.map(d => d.online),
                nodesOnline: data.map(d => d.nodesOn),
            }
        };
        
        if (cache.isConnected()) {
            try {
                await cache.redis.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
            } catch (e) {}
        }
        
        return result;
    }

    async getTrafficChart(period = '24h') {
        const cacheKey = CACHE_KEYS.TRAFFIC + period;
        
        if (cache.isConnected()) {
            try {
                const cached = await cache.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {}
        }
        
        const { type, startDate, endDate } = this.getPeriodParams(period);
        const data = await StatsSnapshot.getRange(type, startDate, endDate, false);
        
        let totalTx = 0, totalRx = 0;
        const txData = [], rxData = [], labels = [];
        
        for (const d of data) {
            labels.push(d.ts);
            txData.push(d.tx || 0);
            rxData.push(d.rx || 0);
            totalTx += d.tx || 0;
            totalRx += d.rx || 0;
        }
        
        const result = {
            period,
            type,
            labels,
            datasets: { tx: txData, rx: rxData },
            totals: { tx: totalTx, rx: totalRx, total: totalTx + totalRx }
        };
        
        if (cache.isConnected()) {
            try {
                await cache.redis.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
            } catch (e) {}
        }
        
        return result;
    }

    async getNodesChart(period = '24h') {
        const cacheKey = CACHE_KEYS.NODES + period;
        
        if (cache.isConnected()) {
            try {
                const cached = await cache.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {}
        }
        
        const { type, startDate, endDate } = this.getPeriodParams(period);
        
        const data = await StatsSnapshot.getRangeWithNodes(type, startDate, endDate);
        
        const nodesMap = new Map();
        const labels = [];
        
        for (const snapshot of data) {
            labels.push(snapshot.ts);
            
            if (!snapshot.nodes) continue;
            
            for (const node of snapshot.nodes) {
                const nodeKey = node.i || node.n;
                if (!nodesMap.has(nodeKey)) {
                    // totalTx/totalRx accumulate bytes across the selected period for the summary table
                    nodesMap.set(nodeKey, { id: nodeKey, name: node.n, data: [], totalTx: 0, totalRx: 0 });
                }
                const entry = nodesMap.get(nodeKey);
                entry.data.push({
                    timestamp: snapshot.ts,
                    online: node.o,
                    status: node.s,
                    tx: node.t || 0,
                    rx: node.r || 0,
                });
                entry.totalTx += node.t || 0;
                entry.totalRx += node.r || 0;
            }
        }
        
        const result = {
            period,
            labels,
            nodes: Array.from(nodesMap.values()),
        };
        
        if (cache.isConnected()) {
            try {
                await cache.redis.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
            } catch (e) {}
        }
        
        return result;
    }

    async getHostChart(period = '24h') {
        const cacheKey = CACHE_KEYS.HOST + period;

        if (cache.isConnected()) {
            try {
                const cached = await cache.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {}
        }

        const { type, startDate, endDate } = this.getPeriodParams(period);

        // Skip nodes[] — chart only needs ts + host.
        const data = await StatsSnapshot.find({
            type,
            ts: { $gte: startDate, $lte: endDate },
        })
        .select({ ts: 1, host: 1, _id: 0 })
        .sort({ ts: 1 })
        .lean();

        const result = {
            period,
            type,
            labels: data.map(d => d.ts),
            datasets: {
                cpuPct:   data.map(d => d.host?.cpuPct   || 0),
                load1:    data.map(d => d.host?.load1    || 0),
                memPct:   data.map(d => d.host?.memPct   || 0),
                memUsed:  data.map(d => d.host?.memUsed  || 0),
                rss:      data.map(d => d.host?.rss      || 0),
                heapUsed: data.map(d => d.host?.heapUsed || 0),
                rps:      data.map(d => d.host?.rps      || 0),
                rpm:      data.map(d => d.host?.rpm      || 0),
                diskPct:  data.map(d => d.host?.diskPct  || 0),
                diskFree: data.map(d => d.host?.diskFree || 0),
            },
        };

        if (cache.isConnected()) {
            try {
                await cache.redis.setex(cacheKey, CACHE_TTL.CHARTS, JSON.stringify(result));
            } catch (e) {}
        }

        return result;
    }

    async getSummary() {
        const cacheKey = CACHE_KEYS.SUMMARY;
        
        if (cache.isConnected()) {
            try {
                const cached = await cache.redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (e) {}
        }
        
        const stats24h = await StatsSnapshot.get24hStats();
        
        const latest = await StatsSnapshot.findOne({ type: 'hourly' })
            .sort({ ts: -1 })
            .select({ online: 1, nodesOn: 1, nodesTotal: 1, users: 1, activeUsers: 1, ts: 1, host: 1 })
            .lean();

        const hourAgo = await StatsSnapshot.findOne({
            type: 'hourly',
            ts: { $lte: new Date(Date.now() - 60 * 60 * 1000) }
        })
        .sort({ ts: -1 })
        .select({ online: 1 })
        .lean();
        
        const currentOnline = latest?.online || 0;
        const hourAgoOnline = hourAgo?.online || 0;
        const trend = hourAgoOnline > 0 
            ? ((currentOnline - hourAgoOnline) / hourAgoOnline * 100).toFixed(1)
            : 0;
        
        const result = {
            current: {
                online: currentOnline,
                nodesOnline: latest?.nodesOn || 0,
                nodesTotal: latest?.nodesTotal || 0,
                users: latest?.users || 0,
                activeUsers: latest?.activeUsers || 0,
                cpuPct: latest?.host?.cpuPct || 0,
                memPct: latest?.host?.memPct || 0,
                rss: latest?.host?.rss || 0,
                load1: latest?.host?.load1 || 0,
                rpm: latest?.host?.rpm || 0,
                diskPct: latest?.host?.diskPct || 0,
                diskFree: latest?.host?.diskFree || 0,
            },
            trends: {
                hourly: parseFloat(trend),
            },
            traffic24h: {
                tx: stats24h?.totalTx || 0,
                rx: stats24h?.totalRx || 0,
                total: (stats24h?.totalTx || 0) + (stats24h?.totalRx || 0),
            },
            peak24h: stats24h?.peakOnline || 0,
            lastUpdate: latest?.ts || null,
        };
        
        if (cache.isConnected()) {
            try {
                await cache.redis.setex(cacheKey, CACHE_TTL.SUMMARY, JSON.stringify(result));
            } catch (e) {}
        }
        
        return result;
    }
    
    async cleanup() {
        try {
            const result = await StatsSnapshot.cleanup();
            logger.info(`[Stats] Cleanup: hourly=${result.hourly}, daily=${result.daily}, monthly=${result.monthly}`);
            return result;
        } catch (error) {
            logger.error(`[Stats] Cleanup error: ${error.message}`);
        }
    }
}

module.exports = new StatsService();
