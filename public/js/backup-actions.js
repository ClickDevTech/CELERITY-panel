// Shared database backup/restore actions for dashboard and settings pages.
(function () {
    function getMessage(i18n, keys, fallback) {
        for (const key of keys) {
            if (i18n && i18n[key]) return i18n[key];
        }
        return fallback;
    }

    async function parseErrorResponse(res) {
        try {
            const data = await res.json();
            return data.error || data.message || 'unknown';
        } catch (_) {
            return res.statusText || 'unknown';
        }
    }

    function triggerDownload(blob, filename) {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }

    async function downloadBackup(options) {
        const opts = options || {};
        const i18n = opts.i18n || {};
        const notify = opts.showToast || window.showToast || function () {};

        notify(getMessage(i18n, ['creatingBackup'], 'Creating backup...'), 'info');

        try {
            const res = await fetch(opts.url || '/panel/backup', {
                method: 'POST',
                credentials: 'include',
            });

            if (!res.ok) {
                const error = await parseErrorResponse(res);
                notify(`${getMessage(i18n, ['error'], 'Error')}: ${error}`, 'error');
                return false;
            }

            const blob = await res.blob();
            const contentDisposition = res.headers.get('Content-Disposition');
            let filename = 'backup.tar.gz';
            if (contentDisposition) {
                const match = contentDisposition.match(/filename="?([^";\n]+)"?/);
                if (match) filename = match[1];
            }

            triggerDownload(blob, filename);
            const s3Status = res.headers.get('X-Celerity-S3-Status');
            if (s3Status === 'failed') {
                const s3Error = decodeURIComponent(res.headers.get('X-Celerity-S3-Error') || 'unknown');
                const s3Message = getMessage(i18n, ['s3UploadFailed'], 'S3 upload failed: {error}')
                    .replace('{error}', s3Error);
                notify(`${getMessage(i18n, ['backupDownloaded'], 'Backup downloaded')}. ${s3Message}`, 'warning');
            } else {
                notify(getMessage(i18n, ['backupDownloaded'], 'Backup downloaded'), 'success');
            }
            if (typeof opts.onSuccess === 'function') opts.onSuccess(filename);
            return true;
        } catch (error) {
            notify(getMessage(i18n, ['backupError'], 'Backup error') + ': ' + error.message, 'error');
            return false;
        }
    }

    async function restoreBackupFromFile(input, options) {
        const opts = options || {};
        const i18n = opts.i18n || {};
        const notify = opts.showToast || window.showToast || function () {};
        const file = input?.files?.[0];
        if (!file) return false;

        const confirmTemplate = getMessage(
            i18n,
            ['restoreUploadConfirm', 'restoreConfirm'],
            'Restore database from "{filename}"?\n\nCurrent data will be replaced!'
        );
        if (!confirm(confirmTemplate.replace('{filename}', file.name))) {
            input.value = '';
            return false;
        }

        notify(getMessage(i18n, ['restoringDb', 'restoring'], 'Restoring...'), 'info');

        const formData = new FormData();
        formData.append('backup', file);

        try {
            const res = await fetch(opts.url || '/panel/restore', {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = await res.json();

            if (data.success) {
                notify(getMessage(i18n, ['dbRestored', 'restored'], 'Database restored'), 'success');
                // Blocking dialog on purpose: the page reloads right after, which
                // would hide a toast the operator has to act on.
                if (data.warning) alert(data.warning);
                if (typeof opts.onSuccess === 'function') opts.onSuccess(data);
                const reloadDelay = Number.isFinite(opts.reloadDelay) ? opts.reloadDelay : 1500;
                if (opts.reload !== false) setTimeout(() => location.reload(), reloadDelay);
                return true;
            }

            notify(`${getMessage(i18n, ['error', 'restoreError'], 'Error')}: ${data.error || 'unknown'}`, 'error');
            return false;
        } catch (error) {
            notify(`${getMessage(i18n, ['restoreError', 'error'], 'Restore error')}: ${error.message}`, 'error');
            return false;
        } finally {
            input.value = '';
        }
    }

    window.CelerityBackupActions = {
        downloadBackup,
        restoreBackupFromFile,
    };
})();
