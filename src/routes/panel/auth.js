const router = require('express').Router();
const bcrypt = require('bcryptjs');

const Admin = require('../../models/adminModel');
const totpService = require('../../services/totpService');
const logger = require('../../utils/logger');
const {
    loginLimiter,
    totpVerifyLimiter,
    clearPanelTotpPending,
    clearPanelLoginTotpLockout,
    setPanelLoginTotpLockout,
    getPanelLoginTotpLockout,
    renderPanelLoginPage,
    getPanelTotpPending,
    renderPanelTotpPage,
    redirectSettingsSecurity,
} = require('./helpers');

function renderSetupPage(res, { error = null, enableTotp = false, formData = {} } = {}) {
    return res.render('setup', {
        error,
        enableTotp,
        formData,
    });
}

// GET /panel/login
router.get('/login', async (req, res) => {
    try {
        if (req.session && req.session.authenticated) {
            return res.redirect('/panel');
        }

        const loginLockout = getPanelLoginTotpLockout(req);
        if (loginLockout) {
            const pendingForLockout = getPanelTotpPending(req, { clearInvalid: false });
            if (pendingForLockout?.type === 'login') {
                clearPanelTotpPending(req);
            }

            return renderPanelLoginPage(req, res, { status: 429 });
        }

        const pending = getPanelTotpPending(req);
        if (pending && (pending.type === 'login' || pending.type === 'setup')) {
            return res.redirect('/panel/totp');
        }

        const hasAdmin = await Admin.hasAdmin();
        if (!hasAdmin) {
            if (pending && pending.type === 'setup') {
                return res.redirect('/panel/totp');
            }

            clearPanelTotpPending(req);
            clearPanelLoginTotpLockout(req);
            return renderSetupPage(res, { error: null, enableTotp: false });
        }

        if (pending && pending.type !== 'login') {
            clearPanelTotpPending(req);
        }

        return renderPanelLoginPage(req, res);
    } catch (error) {
        logger.error('[Panel] GET /login error:', error.message);
        return res.status(500).send('Internal Server Error');
    }
});

// POST /panel/setup
router.post('/setup', async (req, res) => {
    try {
        const hasAdmin = await Admin.hasAdmin();
        if (hasAdmin) {
            clearPanelTotpPending(req);
            return res.redirect('/panel/login');
        }

        const { username, password, passwordConfirm, enableTotp } = req.body;
        const setupFormData = {
            username: typeof username === 'string' ? username.trim() : '',
        };

        if (!username || username.length < 3) {
            return renderSetupPage(res, {
                error: res.locals.t?.('setup.usernameTooShort') || 'Username must be at least 3 characters',
                enableTotp: enableTotp === 'on',
                formData: setupFormData,
            });
        }
        if (!password || password.length < 6) {
            return renderSetupPage(res, {
                error: res.locals.t?.('setup.passwordTooShort') || 'Password must be at least 6 characters',
                enableTotp: enableTotp === 'on',
                formData: setupFormData,
            });
        }
        if (password !== passwordConfirm) {
            return renderSetupPage(res, {
                error: res.locals.t?.('setup.passwordsMismatch') || 'Passwords do not match',
                enableTotp: enableTotp === 'on',
                formData: setupFormData,
            });
        }

        const normalizedUsername = username.toLowerCase().trim();
        const setupWithTotp = enableTotp === 'on';

        if (!setupWithTotp) {
            await Admin.createAdmin(normalizedUsername, password);
            await Admin.recordSuccessfulLogin(normalizedUsername);
            clearPanelTotpPending(req);
            req.session.authenticated = true;
            req.session.adminUsername = normalizedUsername;

            logger.info(`[Panel] Administrator created: ${normalizedUsername}`);
            return res.redirect('/panel');
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const secret = totpService.generateSecret();
        const secretEncrypted = totpService.encryptSecret(secret);

        req.session.panelTotpPending = {
            type: 'setup',
            username: normalizedUsername,
            passwordHash,
            secretEncrypted,
            createdAt: Date.now(),
        };

        logger.info(`[Panel] 2FA setup required for new admin: ${normalizedUsername} (IP: ${req.ip})`);
        return res.redirect('/panel/totp');
    } catch (error) {
        logger.error('[Panel] Admin creation error:', error.message);
        return renderSetupPage(res, {
            error: `${res.locals.t?.('common.error') || 'Error'}: ${error.message}`,
            enableTotp: req.body.enableTotp === 'on',
            formData: {
                username: typeof req.body.username === 'string' ? req.body.username.trim() : '',
            },
        });
    }
});

// POST /panel/login (with rate limiting)
router.post('/login', loginLimiter, async (req, res) => {
    try {
        const lockout = getPanelLoginTotpLockout(req);
        if (lockout) {
            const pendingForLockout = getPanelTotpPending(req, { clearInvalid: false });
            if (pendingForLockout?.type === 'login') {
                clearPanelTotpPending(req);
            }

            return renderPanelLoginPage(req, res, { status: 429 });
        }

        const { username, password } = req.body;

        const hasAdmin = await Admin.hasAdmin();
        if (!hasAdmin) {
            return res.redirect('/panel/login');
        }

        const admin = await Admin.verifyPassword(username, password);

        if (!admin) {
            logger.warn(`[Panel] Failed login attempt: ${username} from IP: ${req.ip}`);
            return renderPanelLoginPage(req, res, {
                error: res.locals.t?.('auth.invalidCredentials') || 'Invalid username or password',
            });
        }

        if (admin.twoFactor?.enabled) {
            if (!admin.twoFactor.secretEncrypted) {
                logger.warn(`[Panel] Missing TOTP secret for enabled 2FA login: ${admin.username} (IP: ${req.ip})`);
                return renderPanelLoginPage(req, res, {
                    error: res.locals.t?.('auth.totpConfigError') || 'TOTP configuration error',
                });
            }

            req.session.panelTotpPending = {
                type: 'login',
                username: admin.username,
                secretEncrypted: admin.twoFactor.secretEncrypted,
                createdAt: Date.now(),
            };
            clearPanelLoginTotpLockout(req);
            delete req.session.authenticated;
            delete req.session.adminUsername;

            logger.info(`[Panel] 2FA required for ${admin.username} (IP: ${req.ip})`);
            return res.redirect('/panel/totp');
        }

        clearPanelTotpPending(req);
        clearPanelLoginTotpLockout(req);
        req.session.authenticated = true;
        req.session.adminUsername = admin.username;
        await Admin.recordSuccessfulLogin(admin.username);

        logger.info(`[Panel] Successful login: ${admin.username} from IP: ${req.ip}`);
        return res.redirect('/panel');
    } catch (error) {
        logger.error('[Panel] POST /login error:', error.message);
        return renderPanelLoginPage(req, res, {
            error: res.locals.t?.('common.error') || 'An error occurred. Please try again.',
        });
    }
});

// GET /panel/totp - Universal TOTP confirmation page
router.get('/totp', async (req, res) => {
    try {
        const pending = getPanelTotpPending(req);
        if (!pending) {
            if (req.session?.authenticated) {
                return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpPendingExpired') || 'TOTP session expired' });
            }
            return res.redirect('/panel/login');
        }

        if (pending.type === 'setup') {
            const hasAdmin = await Admin.hasAdmin();
            if (hasAdmin) {
                clearPanelTotpPending(req);
                return res.redirect('/panel/login');
            }
        }

        return renderPanelTotpPage(res, pending);
    } catch (error) {
        logger.error('[Panel] GET /totp error:', error.message);
        return res.redirect('/panel/login');
    }
});

// POST /panel/totp - Universal TOTP confirmation handler
router.post('/totp', totpVerifyLimiter, async (req, res) => {
    const pending = getPanelTotpPending(req);
    if (!pending) {
        if (req.session?.authenticated) {
            return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpPendingExpired') || 'TOTP session expired' });
        }
        return res.redirect('/panel/login');
    }

    const token = String(req.body.token || '').trim();
    if (!token) {
        return renderPanelTotpPage(res, pending, res.locals.t?.('auth.totpRequired') || 'Enter verification code');
    }

    try {
        if (pending.type === 'setup') {
            const hasAdmin = await Admin.hasAdmin();
            if (hasAdmin) {
                clearPanelTotpPending(req);
                return res.redirect('/panel/login');
            }

            const secret = totpService.decryptSecret(pending.secretEncrypted);
            const isValid = await totpService.verifyToken({ secret, token });
            if (!isValid) {
                logger.warn(`[Panel] Failed setup 2FA confirmation for ${pending.username} (IP: ${req.ip})`);
                return renderPanelTotpPage(res, pending, res.locals.t?.('auth.invalidTotp') || 'Invalid verification code');
            }

            await Admin.createAdminWithHash(pending.username, pending.passwordHash, {
                twoFactor: {
                    enabled: true,
                    secretEncrypted: pending.secretEncrypted,
                    enabledAt: new Date(),
                },
            });
            await Admin.recordSuccessfulLogin(pending.username);
            req.session.authenticated = true;
            req.session.adminUsername = pending.username;
            clearPanelTotpPending(req);

            logger.info(`[Panel] Administrator created with 2FA: ${req.session.adminUsername}`);
            return res.redirect('/panel');
        }

        if (pending.type === 'login') {
            const secret = totpService.decryptSecret(pending.secretEncrypted);
            const isValid = await totpService.verifyToken({ secret, token });
            if (!isValid) {
                logger.warn(`[Panel] Failed login 2FA confirmation for ${pending.username} (IP: ${req.ip})`);
                return renderPanelTotpPage(res, pending, res.locals.t?.('auth.invalidTotp') || 'Invalid verification code');
            }

            req.session.authenticated = true;
            req.session.adminUsername = pending.username;
            await Admin.recordSuccessfulLogin(pending.username);
            clearPanelTotpPending(req);

            logger.info(`[Panel] Successful login with 2FA: ${pending.username} (IP: ${req.ip})`);
            return res.redirect('/panel');
        }

        if (pending.action === 'password_change') {
            const admin = await Admin.findOne({ username: pending.username.toLowerCase().trim() });
            if (!admin?.twoFactor?.enabled || !admin.twoFactor.secretEncrypted) {
                clearPanelTotpPending(req);
                return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpConfigError') || 'TOTP configuration error' });
            }

            const currentSecret = totpService.decryptSecret(admin.twoFactor.secretEncrypted);
            const isCurrentCodeValid = await totpService.verifyToken({ secret: currentSecret, token });
            if (!isCurrentCodeValid) {
                return renderPanelTotpPage(res, pending, res.locals.t?.('auth.invalidCurrentTotp') || 'Invalid current TOTP code');
            }

            await Admin.changePasswordWithHash(pending.username, pending.payload.newPasswordHash);
            clearPanelTotpPending(req);

            logger.info(`[Panel] Password changed for: ${pending.username}`);
            return redirectSettingsSecurity(res, { message: res.locals.t?.('auth.passwordChanged') || 'Password successfully changed' });
        }

        if (pending.action === 'totp_disable_verify_current') {
            const currentSecret = totpService.decryptSecret(pending.payload.currentSecretEncrypted);
            const isCurrentCodeValid = await totpService.verifyToken({ secret: currentSecret, token });
            if (!isCurrentCodeValid) {
                return renderPanelTotpPage(res, pending, res.locals.t?.('auth.invalidCurrentTotp') || 'Invalid current TOTP code');
            }

            await Admin.clearTwoFactor(pending.username);
            clearPanelTotpPending(req);

            logger.info(`[Panel] Settings TOTP disabled for ${pending.username}`);
            return redirectSettingsSecurity(res, { message: res.locals.t?.('auth.totpDisabled') || 'TOTP disabled' });
        }

        if (pending.action === 'totp_rotate_verify_current') {
            const currentSecret = totpService.decryptSecret(pending.payload.currentSecretEncrypted);
            const isCurrentCodeValid = await totpService.verifyToken({ secret: currentSecret, token });
            if (!isCurrentCodeValid) {
                return renderPanelTotpPage(res, pending, res.locals.t?.('auth.invalidCurrentTotp') || 'Invalid current TOTP code');
            }

            const enrollment = await totpService.generateEnrollmentData({ username: pending.username });
            req.session.panelTotpPending = {
                ...pending,
                action: 'totp_rotate_enroll',
                payload: null,
                secretEncrypted: enrollment.secretEncrypted,
                createdAt: Date.now(),
            };

            return renderPanelTotpPage(res, req.session.panelTotpPending);
        }

        if (pending.action === 'totp_enable_enroll' || pending.action === 'totp_rotate_enroll') {
            const secret = totpService.decryptSecret(pending.secretEncrypted);
            const isValid = await totpService.verifyToken({ secret, token });
            if (!isValid) {
                return renderPanelTotpPage(res, pending, res.locals.t?.('auth.invalidTotp') || 'Invalid verification code');
            }

            await Admin.setTwoFactorEnabled(pending.username, pending.secretEncrypted, new Date());
            clearPanelTotpPending(req);

            const successMessage = pending.action === 'totp_rotate_enroll'
                ? (res.locals.t?.('auth.totpRotated') || 'New TOTP secret configured')
                : (res.locals.t?.('auth.totpEnabled') || 'TOTP enabled');

            logger.info(`[Panel] Settings TOTP flow completed for ${pending.username}: ${pending.action}`);
            return redirectSettingsSecurity(res, { message: successMessage });
        }

        clearPanelTotpPending(req);
        return redirectSettingsSecurity(res, { error: res.locals.t?.('auth.totpFlowError') || 'Error starting TOTP flow' });
    } catch (error) {
        logger.error('[Panel] Universal TOTP confirmation error:', error.message);

        // An unreadable secret means ENCRYPTION_KEY no longer matches the stored
        // ciphertext; no code can ever verify, so point the operator at the
        // recovery path instead of echoing the crypto error.
        if (error.code === 'TOTP_SECRET_UNREADABLE') {
            logger.error('[Panel] TOTP secret is unreadable — ENCRYPTION_KEY likely differs from the one used at enrollment. Recover with: node scripts/reset-2fa.js <username>');
            const configError = res.locals.t?.('auth.totpConfigError') || 'TOTP configuration error';
            return renderPanelTotpPage(res, pending, configError);
        }

        if (pending.type === 'settings') {
            return renderPanelTotpPage(res, pending, error.message);
        }

        return renderPanelTotpPage(res, pending, `${res.locals.t?.('common.error') || 'Error'}: ${error.message}`);
    }
});

// GET /panel/logout
router.get('/logout', (req, res) => {
    const username = req.session?.adminUsername;
    req.session.destroy((err) => {
        if (err) logger.error('[Panel] Session destroy error on logout:', err.message);
        if (username) {
            logger.info(`[Panel] Logout: ${username}`);
        }
        res.redirect('/panel/login');
    });
});

module.exports = router;
