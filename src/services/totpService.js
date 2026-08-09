const QRCode = require('qrcode');
const otplib = require('otplib');
const cryptoService = require('./cryptoService');

const DEFAULT_ISSUER = 'C3 CELERITY';

/**
 * Thrown when a stored TOTP secret cannot be decrypted — in practice this means
 * ENCRYPTION_KEY no longer matches the one used at enrollment (e.g. the database
 * was restored from a backup taken on another installation).
 *
 * Callers must map this to an operator-facing message instead of surfacing the
 * underlying crypto/otplib error, which leaks library internals on a page that
 * is reachable before authentication completes.
 */
class TotpSecretUnreadableError extends Error {
    constructor() {
        super('TOTP secret cannot be decrypted with the current ENCRYPTION_KEY');
        this.name = 'TotpSecretUnreadableError';
        this.code = 'TOTP_SECRET_UNREADABLE';
    }
}

class TotpService {
    generateSecret() {
        return otplib.generateSecret();
    }

    encryptSecret(secret) {
        return cryptoService.encrypt(secret);
    }

    /**
     * Decrypt a stored secret. Returns '' when the ciphertext cannot be read
     * with the current key — CryptoJS either throws on malformed UTF-8 or
     * silently yields an empty string, so both cases are normalized here.
     */
    decryptSecret(secretEncrypted) {
        if (!secretEncrypted) return '';
        try {
            return cryptoService.decrypt(secretEncrypted) || '';
        } catch (_) {
            return '';
        }
    }

    buildOtpAuthUrl({ secret, username, issuer = DEFAULT_ISSUER }) {
        return otplib.generateURI({ secret, accountName: String(username), issuer });
    }

    async generateQrDataUrl(otpauthUrl) {
        return QRCode.toDataURL(otpauthUrl, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 220,
        });
    }

    async verifyToken({ secret, token }) {
        if (!secret) {
            throw new TotpSecretUnreadableError();
        }

        const normalizedToken = String(token || '').replace(/\s+/g, '');
        if (!normalizedToken) return false;

        const verificationResult = await otplib.verify({
            token: normalizedToken,
            secret,
        });

        if (typeof verificationResult === 'boolean') {
            return verificationResult;
        }

        return Boolean(verificationResult && verificationResult.valid);
    }

    async generateEnrollmentData({ username, issuer = DEFAULT_ISSUER }) {
        const secret = this.generateSecret();
        const secretEncrypted = this.encryptSecret(secret);
        const otpauthUrl = this.buildOtpAuthUrl({ secret, username, issuer });
        const qrDataUrl = await this.generateQrDataUrl(otpauthUrl);

        return {
            secret,
            secretEncrypted,
            otpauthUrl,
            qrDataUrl,
        };
    }
}

module.exports = new TotpService();
module.exports.TotpSecretUnreadableError = TotpSecretUnreadableError;