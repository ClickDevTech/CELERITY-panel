/**
 * Encryption service for user passwords and SSH credentials
 */

const crypto = require('crypto');
const CryptoJS = require('crypto-js');
const config = require('../../config');

class CryptoService {
    constructor() {
        this.key = config.ENCRYPTION_KEY;
    }

    /**
     * Generate deterministic password from userId
     */
    generatePassword(userId) {
        const hash = CryptoJS.HmacSHA256(String(userId), this.key);
        return hash.toString(CryptoJS.enc.Hex).substring(0, 24);
    }

    /**
     * Encrypt data
     */
    encrypt(data) {
        return CryptoJS.AES.encrypt(String(data), this.key).toString();
    }

    /**
     * Decrypt data
     */
    decrypt(encryptedData) {
        const bytes = CryptoJS.AES.decrypt(encryptedData, this.key);
        return bytes.toString(CryptoJS.enc.Utf8);
    }

    /**
     * Decrypt with backwards-compatible plaintext fallback.
     * Returns original value if decryption fails (legacy unencrypted data).
     */
    decryptSafe(value) {
        if (!value) return '';
        try {
            const d = this.decrypt(value);
            if (d) return d;
        } catch (_) {}
        return value;
    }

    /**
     * Decrypt a stored SSH private key.
     * Validates that the result looks like a PEM key; falls back to raw value.
     */
    decryptPrivateKey(key) {
        if (!key) return '';
        try {
            const decrypted = this.decryptSafe(key);
            if (decrypted && decrypted.includes('-----BEGIN')) return decrypted;
        } catch (_) {}
        return key;
    }

    /**
     * Encrypt SSH password and privateKey fields before saving to DB.
     */
    encryptSshCredentials(ssh) {
        if (!ssh) return ssh;
        const result = { ...ssh };
        if (result.password) result.password = this.encrypt(result.password);
        if (result.privateKey) result.privateKey = this.encrypt(result.privateKey);
        return result;
    }

    /**
     * Decrypt SSH credentials with backwards-compatible plaintext fallback.
     */
    decryptSshCredentials(ssh) {
        if (!ssh) return {};
        return {
            ...ssh,
            password: this.decryptSafe(ssh.password),
            privateKey: this.decryptPrivateKey(ssh.privateKey),
        };
    }

    /**
     * Stable, non-reversible identifier of the active ENCRYPTION_KEY.
     *
     * Written into backup archives so a restore can tell the operator upfront
     * that the dump was produced under a different key — in which case every
     * encrypted field in it (SSH credentials, TOTP secrets, ClickHouse password)
     * is unreadable on this installation.
     */
    keyFingerprint() {
        return CryptoJS.HmacSHA256('celerity-encryption-key-fingerprint', this.key)
            .toString(CryptoJS.enc.Hex)
            .slice(0, 16);
    }

    /**
     * Generate random secret for node stats API
     */
    generateNodeSecret() {
        return CryptoJS.lib.WordArray.random(16).toString();
    }

    /**
     * Generate an x25519 keypair for Xray Reality LOCALLY (no SSH / no xray binary).
     *
     * Xray uses raw 32-byte keys encoded as base64url WITHOUT padding. We strip
     * the fixed PKCS8/SPKI ASN.1 prefixes (16 bytes for private, 12 for public)
     * to get the raw 32-byte payload, then base64url-encode.
     *
     * @returns {{ privateKey: string, publicKey: string }}
     */
    generateX25519KeysLocal() {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');

        // PKCS8 DER for x25519 private = 16-byte ASN.1 prefix + 32-byte raw key.
        // SPKI  DER for x25519 public  = 12-byte ASN.1 prefix + 32-byte raw key.
        const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
        const pubDer = publicKey.export({ format: 'der', type: 'spki' });
        const privRaw = privDer.subarray(privDer.length - 32);
        const pubRaw = pubDer.subarray(pubDer.length - 32);

        const b64url = (buf) => buf.toString('base64')
            .replace(/=+$/, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');

        return { privateKey: b64url(privRaw), publicKey: b64url(pubRaw) };
    }
}

module.exports = new CryptoService();
