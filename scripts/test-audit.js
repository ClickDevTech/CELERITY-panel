'use strict';

// Admin audit trail: routing decisions, entry shape, handler safety.

process.env.PANEL_DOMAIN = process.env.PANEL_DOMAIN || 'panel.example.com';
process.env.ACME_EMAIL = process.env.ACME_EMAIL || 'admin@example.com';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-encryption-key-32-characters-long';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-32-characters-long';

const assert = require('assert');
const audit = require('../src/middleware/audit');
const auditService = require('../src/services/auditService');

(async () => {
    // --- shouldAudit: mutations only, hot paths excluded ---
    const auditCases = [
        ['POST', '/api/users', true],
        ['PUT', '/api/nodes/abc', true],
        ['DELETE', '/panel/users/abc', true],
        ['PATCH', '/panel/nodes/reorder', true],
        ['POST', '/panel/login', true],
        ['GET', '/api/users', false],
        ['GET', '/panel/nodes', false],
        ['HEAD', '/api/x', false],
        ['POST', '/api/auth', false],
        ['POST', '/api/access-logs/ingest', false],
        ['POST', '/api/probe/enroll', false],
        ['GET', '/api/files/token', false],
        ['POST', '/api/files/token', false],
        ['GET', '/api/info/token', false],
    ];
    for (const [method, path, expected] of auditCases) {
        assert.strictEqual(audit.shouldAudit({ method, path }), expected, `${method} ${path}`);
    }

    // --- middleware passes through non-audited requests untouched ---
    {
        let nexted = false;
        let finished = false;
        audit({ method: 'GET', path: '/panel' }, { on() { finished = true; } }, () => { nexted = true; });
        assert.strictEqual(nexted, true);
        assert.strictEqual(finished, false);
    }

    // --- audited request writes an entry on finish (DB stubbed) ---
    {
        const written = [];
        const AuditLog = require('../src/models/auditLogModel');
        const origCreate = AuditLog.create;
        AuditLog.create = async (doc) => { written.push(doc); return doc; };
        try {
            let finishCb = null;
            const req = {
                method: 'DELETE',
                path: '/api/users/u1',
                params: { userId: 'u1' },
                ip: '10.0.0.5',
                session: { authenticated: true, adminUsername: 'boss' },
            };
            const res = { statusCode: 200, on(ev, cb) { if (ev === 'finish') finishCb = cb; } };
            let nexted = false;
            audit(req, res, () => { nexted = true; });
            assert.strictEqual(nexted, true);
            assert.ok(typeof finishCb === 'function');
            await finishCb();
            assert.strictEqual(written.length, 1);
            assert.deepStrictEqual(
                { actor: written[0].actor, authType: written[0].authType, action: written[0].action, statusCode: written[0].statusCode, target: written[0].target, ip: written[0].ip },
                { actor: 'panel:boss', authType: 'panel', action: 'DELETE /api/users/u1', statusCode: 200, target: 'u1', ip: '10.0.0.5' }
            );
        } finally {
            AuditLog.create = origCreate;
        }
    }

    // --- actor resolution: apikey, anonymous ---
    assert.deepStrictEqual(
        auditService.actorFromReq({ apiKey: { keyPrefix: 'ck_abc' } }),
        { actor: 'apikey:ck_abc', authType: 'apikey' }
    );
    assert.deepStrictEqual(auditService.actorFromReq({}), { actor: 'anonymous', authType: 'anonymous' });

    // --- write() never throws, even with a dead DB ---
    {
        const AuditLog = require('../src/models/auditLogModel');
        const origCreate = AuditLog.create;
        AuditLog.create = async () => { throw new Error('db down'); };
        try {
            await auditService.write({ actor: 'x', action: 'Y' });
        } finally {
            AuditLog.create = origCreate;
        }
    }

    console.log('audit tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
