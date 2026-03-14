/**
 * SSH Key generation and installation service
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Generate ed25519 keypair.
 * Returns private key in OpenSSH PEM format (required by ssh2 for ed25519),
 * and public key in OpenSSH wire format for authorized_keys.
 */
function generateEd25519KeyPair() {
    const { publicKey: pubDer, privateKey: pkcs8Der } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    // Raw 32-byte public key is always the last 32 bytes of SPKI DER
    const rawPub = pubDer.slice(-32);

    // Raw 32-byte seed is always the last 32 bytes of PKCS8 DER
    const seed = pkcs8Der.slice(-32);

    const privateKey = buildOpenSSHPrivateKey(seed, rawPub);
    const publicKey = buildOpenSSHPublicKey(rawPub);

    return { privateKey, publicKey };
}

/**
 * Build an OpenSSH private key PEM string for ed25519.
 * ssh2 requires OpenSSH format for ed25519 (not PKCS8).
 */
function buildOpenSSHPrivateKey(seed, rawPub, comment = 'click-connect') {
    // OpenSSH ed25519 private key = seed (32) + public key (32) = 64 bytes
    const privKey64 = Buffer.concat([seed, rawPub]);

    function sshStr(val) {
        const buf = Buffer.isBuffer(val) ? val : Buffer.from(val);
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(buf.length);
        return Buffer.concat([len, buf]);
    }

    // Public key in SSH wire format
    const pubKeyWire = Buffer.concat([sshStr('ssh-ed25519'), sshStr(rawPub)]);

    // Random check integer for integrity verification
    const check = crypto.randomInt(0, 0xFFFFFFFF);
    const checkBuf = Buffer.allocUnsafe(4);
    checkBuf.writeUInt32BE(check);

    // Private block content: check1 check2 keytype pubkey privkey comment
    const privContent = Buffer.concat([
        checkBuf, checkBuf,
        sshStr('ssh-ed25519'),
        sshStr(rawPub),
        sshStr(privKey64),
        sshStr(comment),
    ]);

    // Pad to multiple of 8 with bytes 1,2,3,...
    const padLen = (8 - (privContent.length % 8)) % 8;
    const pad = Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1));
    const privBlock = Buffer.concat([privContent, pad]);

    // Full OpenSSH key body
    const nkeys = Buffer.allocUnsafe(4);
    nkeys.writeUInt32BE(1);

    const body = Buffer.concat([
        Buffer.from('openssh-key-v1\0'),
        sshStr('none'),       // cipher
        sshStr('none'),       // kdf
        sshStr(Buffer.alloc(0)), // kdf options (empty)
        nkeys,
        sshStr(pubKeyWire),   // public key
        sshStr(privBlock),    // private key block
    ]);

    const b64 = body.toString('base64').match(/.{1,70}/g).join('\n');
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/**
 * Build OpenSSH public key line for authorized_keys.
 */
function buildOpenSSHPublicKey(rawPub, comment = 'click-connect') {
    function sshStr(val) {
        const buf = Buffer.isBuffer(val) ? val : Buffer.from(val);
        const len = Buffer.allocUnsafe(4);
        len.writeUInt32BE(buf.length);
        return Buffer.concat([len, buf]);
    }
    const wire = Buffer.concat([sshStr('ssh-ed25519'), sshStr(rawPub)]);
    return `ssh-ed25519 ${wire.toString('base64')} ${comment}`;
}

/**
 * Validate that a string looks like an SSH private key (PEM or OpenSSH format).
 */
function isValidPrivateKey(key) {
    if (!key || typeof key !== 'string') return false;
    const trimmed = key.trim();
    return (
        trimmed.includes('-----BEGIN') &&
        (trimmed.includes('PRIVATE KEY') || trimmed.includes('OPENSSH PRIVATE KEY'))
    );
}

/**
 * Install a public key on a remote server via an existing SSH connection.
 * Appends to ~/.ssh/authorized_keys, avoiding duplicates.
 *
 * @param {Object} conn - ssh2 Client instance (already connected)
 * @param {string} publicKey - OpenSSH public key line
 */
async function installPublicKey(conn, publicKey) {
    const script = `
set -e
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

KEY='${publicKey.replace(/'/g, "'\\''")}'

if grep -qF "$KEY" ~/.ssh/authorized_keys 2>/dev/null; then
    echo "KEY_ALREADY_EXISTS"
else
    echo "$KEY" >> ~/.ssh/authorized_keys
    echo "KEY_INSTALLED"
fi
`;

    return new Promise((resolve, reject) => {
        conn.exec(script, (err, stream) => {
            if (err) return reject(err);

            let stdout = '';
            let stderr = '';

            stream.on('data', (data) => { stdout += data.toString(); });
            stream.stderr.on('data', (data) => { stderr += data.toString(); });

            stream.on('close', (code) => {
                if (code !== 0) {
                    return reject(new Error(`Key installation failed (exit ${code}): ${stderr}`));
                }
                const out = stdout.trim();
                if (out.includes('KEY_ALREADY_EXISTS')) {
                    logger.info('[SSHKey] Public key already in authorized_keys');
                } else {
                    logger.info('[SSHKey] Public key installed to authorized_keys');
                }
                resolve();
            });
        });
    });
}

module.exports = { generateEd25519KeyPair, isValidPrivateKey, installPublicKey };
