const mongoose = require('mongoose');

const nodeStatSchema = new mongoose.Schema({
    i: { type: String, required: true },      // nodeId 
    n: { type: String, required: true },      // name 
    o: { type: Number, default: 0 },          // onlineUsers
    s: { type: String, default: 'offline' },  // status
}, { _id: false });

const statsSnapshotSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ['hourly', 'daily', 'monthly'],
        required: true,
    },

    ts: {
        type: Date,
        required: true,
    },
    
    online: { type: Number, default: 0 },
    users: { type: Number, default: 0 },
    activeUsers: { type: Number, default: 0 },
    
    tx: { type: Number, default: 0 },
    rx: { type: Number, default: 0 },
    
    nodesOn: { type: Number, default: 0 },
    nodesTotal: { type: Number, default: 0 },
    
    nodes: [nodeStatSchema],
    
}, { 
    timestamps: false,  
    versionKey: false,  
});

statsSnapshotSchema.index({ type: 1, ts: 1 }, { unique: true });

statsSnapshotSchema.index({ type: 1, ts: -1 });

/**
 * @param {string} type
 * @param {Date} startDate 
 * @param {Date} endDate 
 * @param {boolean} includeNodes
 */
statsSnapshotSchema.statics.getRange = async function(type, startDate, endDate, includeNodes = false) {
    const projection = includeNodes 
        ? {} 
        : { nodes: 0 };
    
    return this.find({
        type,
        ts: { $gte: startDate, $lte: endDate }
    })
    .select(projection)
    .sort({ ts: 1 })
    .lean();
};

statsSnapshotSchema.statics.getRangeWithNodes = async function(type, startDate, endDate) {
    return this.find({
        type,
        ts: { $gte: startDate, $lte: endDate }
    })
    .select({ ts: 1, nodes: 1 })
    .sort({ ts: 1 })
    .lean();
};

statsSnapshotSchema.statics.upsertSnapshot = async function(type, timestamp, data) {
    return this.findOneAndUpdate(
        { type, ts: timestamp },
        { $set: { ...data, type, ts: timestamp } },
        { upsert: true, new: true }
    );
};

statsSnapshotSchema.statics.cleanup = async function() {
    const now = new Date();
    
    const hourlyExpiry = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    
    const dailyExpiry = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    const monthlyExpiry = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    
    const [hourlyDeleted, dailyDeleted, monthlyDeleted] = await Promise.all([
        this.deleteMany({ type: 'hourly', ts: { $lt: hourlyExpiry } }),
        this.deleteMany({ type: 'daily', ts: { $lt: dailyExpiry } }),
        this.deleteMany({ type: 'monthly', ts: { $lt: monthlyExpiry } }),
    ]);
    
    return {
        hourly: hourlyDeleted.deletedCount,
        daily: dailyDeleted.deletedCount,
        monthly: monthlyDeleted.deletedCount,
    };
};

statsSnapshotSchema.statics.get24hStats = async function() {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const result = await this.aggregate([
        {
            $match: {
                type: 'hourly',
                ts: { $gte: dayAgo }
            }
        },
        {
            $group: {
                _id: null,
                totalTx: { $sum: '$tx' },
                totalRx: { $sum: '$rx' },
                peakOnline: { $max: '$online' },
                avgOnline: { $avg: '$online' },
                count: { $sum: 1 },
                latest: { $last: '$$ROOT' }
            }
        }
    ]);
    
    return result[0] || null;
};

module.exports = mongoose.model('StatsSnapshot', statsSnapshotSchema);
