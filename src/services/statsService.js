const StatsSnapshot = require('../models/statsSnapshotModel');
const HyNode = require('../models/hyNodeModel');
const HyUser = require('../models/hyUserModel');
const cache = require('./cacheService');
const logger = require('../utils/logger');

let previousTraffic = new Map();

const CACHE_KEYS = {
    SUMMARY: 'stats:summary',
    ONLINE: 'stats:online:',
    TRAFFIC: 'stats:traffic:',
    NODES: 'stats:nodes:',
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
                const prev = previousTraffic.get(nodeId) || { tx: 0, rx: 0 };
                const currTx = node.traffic?.tx || 0;
                const currRx = node.traffic?.rx || 0;
                
                trafficTx += currTx >= prev.tx ? currTx - prev.tx : currTx;
                trafficRx += currRx >= prev.rx ? currRx - prev.rx : currRx;
                
                previousTraffic.set(nodeId, { tx: currTx, rx: currRx });
                
                const displayName = nameCount[node.name] > 1 && node.domain
                    ? `${node.name} (${node.domain.split('.')[0]})`
                    : node.name;
                
                nodeStats.push({
                    i: node._id.toString(),
                    n: displayName,
                    o: node.onlineUsers || 0,
                    s: node.status,
                });
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
            };
        } catch (error) {
            logger.error(`[Stats] Collect error: ${error.message}`);
            return null;
        }
    }
    
    async saveHourlySnapshot() {
        try {
            const snapshot = await this.collectSnapshot();
            if (!snapshot) return;
            
            const timestamp = this.roundTo5Minutes(new Date());
            
            if (this.lastHourlySnapshot?.getTime() === timestamp.getTime()) {
                return;
            }
            
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
                        lastNodes: { $last: '$nodes' },
                        count: { $sum: 1 }
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
                    nodes: data.lastNodes,
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
                        lastNodes: { $last: '$nodes' },
                        count: { $sum: 1 }
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
                nodes: data.lastNodes,
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
            const keys = await cache.redis.keys('stats:*');
            if (keys.length > 0) {
                await cache.redis.del(...keys);
            }
        } catch (e) {
            // Ignore
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
                    nodesMap.set(nodeKey, { id: nodeKey, name: node.n, data: [] });
                }
                nodesMap.get(nodeKey).data.push({
                    timestamp: snapshot.ts,
                    online: node.o,
                    status: node.s,
                });
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
            .select({ online: 1, nodesOn: 1, nodesTotal: 1, users: 1, activeUsers: 1, ts: 1 })
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
