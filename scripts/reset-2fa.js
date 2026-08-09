/**
 * Disable TOTP (2FA) for a panel administrator.
 *
 * Recovery path for the case where the stored TOTP secret can no longer be
 * decrypted — typically after restoring a database dump onto an installation
 * whose ENCRYPTION_KEY differs from the one used at enrollment. In that state no
 * verification code can ever succeed and the panel cannot be unlocked from the
 * UI, so 2FA has to be cleared out-of-band.
 *
 * Usage (from the panel project directory):
 *   node scripts/reset-2fa.js <username>
 *   node scripts/reset-2fa.js --list
 *
 * Inside Docker:
 *   docker compose exec backend node scripts/reset-2fa.js <username>
 *
 * The admin password is not touched. After a reset, log in with the password and
 * set 2FA up again from Settings → Security.
 */

const mongoose = require('mongoose');
const config = require('../config');
const Admin = require('../src/models/adminModel');
const totpService = require('../src/services/totpService');

function usage() {
    console.log('Usage: node scripts/reset-2fa.js <username>');
    console.log('       node scripts/reset-2fa.js --list');
}

async function listAdmins() {
    const admins = await Admin.find({}).select('username twoFactor').lean();
    if (admins.length === 0) {
        console.log('No administrators found.');
        return;
    }

    console.log(`Administrators (${admins.length}):`);
    for (const admin of admins) {
        const enabled = !!admin.twoFactor?.enabled;
        let state = enabled ? '2FA enabled' : '2FA disabled';
        if (enabled) {
            // Distinguishes "working 2FA" from "locked out by a key mismatch",
            // which is the whole reason this script exists.
            const readable = !!totpService.decryptSecret(admin.twoFactor.secretEncrypted);
            state += readable ? ', secret readable' : ', SECRET UNREADABLE (ENCRYPTION_KEY mismatch)';
        }
        console.log(`  - ${admin.username} (${state})`);
    }
}

async function resetAdmin(username) {
    const admin = await Admin.findOne({ username: username.toLowerCase().trim() }).lean();
    if (!admin) {
        console.error(`Administrator not found: ${username}`);
        return 1;
    }

    if (!admin.twoFactor?.enabled) {
        console.log(`2FA is already disabled for ${admin.username}. Nothing to do.`);
        return 0;
    }

    await Admin.clearTwoFactor(admin.username);
    console.log(`2FA disabled for ${admin.username}.`);
    console.log('Log in with the existing password, then re-enable it in Settings → Security.');
    return 0;
}

async function main() {
    const arg = (process.argv[2] || '').trim();
    if (!arg || arg === '-h' || arg === '--help') {
        usage();
        return arg ? 0 : 1;
    }

    await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

    try {
        if (arg === '--list' || arg === '-l') {
            await listAdmins();
            return 0;
        }
        return await resetAdmin(arg);
    } finally {
        await mongoose.disconnect();
    }
}

main()
    .then((code) => process.exit(code || 0))
    .catch((error) => {
        console.error(`Failed: ${error.message}`);
        process.exit(1);
    });
