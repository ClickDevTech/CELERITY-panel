/**
 * SSH Key generation and installation service
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Generate ed25519 keypair.
 * Returns private key in PEM (PKCS8) format for ssh2,
 * and public key in OpenSSH wire format for authorized_keys.
 */
function generateEd25519KeyPair() {
    const { publicKey: pubDer, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const sshPublicKey = derToOpenSSHPublicKey(pubDer);
    return { privateKey, publicKey: sshPublicKey };
}

/**
 * Convert DER-encoded ed25519 SPKI public key to OpenSSH authorized_keys format.
 * ed25519 SPKI DER always contains the 32-byte raw key in the last 32 bytes.
 */
function derToOpenSSHPublicKey(derBuffer) {
    const rawKey = derBuffer.slice(-32);

    const keyTypeBuf = Buffer.from('ssh-ed25519');
    const wireBuf = Buffer.alloc(4 + keyTypeBuf.length + 4 + rawKey.length);
    wireBuf.writeUInt32BE(keyTypeBuf.length, 0);
    keyTypeBuf.copy(wireBuf, 4);
    wireBuf.writeUInt32BE(rawKey.length, 4 + keyTypeBuf.length);
    rawKey.copy(wireBuf, 8 + keyTypeBuf.length);

    return `ssh-ed25519 ${wireBuf.toString('base64')} click-connect`;
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
