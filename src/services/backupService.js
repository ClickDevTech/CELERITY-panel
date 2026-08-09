/**
 * Backup Service - automatic MongoDB backups with optional S3 upload
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const config = require('../../config');
const logger = require('../utils/logger');
const cryptoService = require('./cryptoService');

const execFileAsync = promisify(execFile);
const BACKUP_FILE_PREFIX = 'celerity-backup-';
const LEGACY_BACKUP_FILE_PREFIXES = ['hysteria-backup-'];
const BACKUP_FILE_PREFIXES = [BACKUP_FILE_PREFIX, ...LEGACY_BACKUP_FILE_PREFIXES];
// Sidecar file stored next to the mongodump output inside the archive.
const BACKUP_META_FILE = 'celerity-meta.json';

/**
 * Compare the ENCRYPTION_KEY fingerprint recorded in an archive against the one
 * this installation runs with.
 *
 * Returns 'match', 'mismatch', or 'unknown' for archives created before the
 * fingerprint existed (or written by another tool).
 */
async function readEncryptionKeyStatus(dumpPath) {
    try {
        const raw = await fs.readFile(path.join(dumpPath, BACKUP_META_FILE), 'utf8');
        const meta = JSON.parse(raw);
        if (!meta?.encryptionKeyFingerprint) return { status: 'unknown' };
        return {
            status: meta.encryptionKeyFingerprint === cryptoService.keyFingerprint() ? 'match' : 'mismatch',
            createdAt: meta.createdAt || null,
        };
    } catch (_) {
        return { status: 'unknown' };
    }
}

/**
 * Extract database name from MONGO_URI, fallback to 'hysteria'.
 */
function getDbName() {
    try {
        return new URL(config.MONGO_URI).pathname.replace(/^\//, '') || 'hysteria';
    } catch (_) {
        return 'hysteria';
    }
}

// Lazy-load S3 client (only when needed)
let s3Client = null;

function normalizeS3Prefix(prefix) {
    return String(prefix || 'backups').trim().replace(/^\/+|\/+$/g, '');
}

function buildS3Key(prefix, fileName) {
    const normalizedPrefix = normalizeS3Prefix(prefix);
    return normalizedPrefix ? `${normalizedPrefix}/${fileName}` : fileName;
}

function isBackupFileName(name) {
    return BACKUP_FILE_PREFIXES.some(prefix => name.startsWith(prefix)) && name.endsWith('.tar.gz');
}

function isBackupKeyForPrefix(key, prefix) {
    const normalizedPrefix = normalizeS3Prefix(prefix);
    return BACKUP_FILE_PREFIXES.some(filePrefix => key.startsWith(buildS3Key(normalizedPrefix, filePrefix))) && key.endsWith('.tar.gz');
}

function getS3Client(settings) {
    if (!s3Client && settings?.backup?.s3?.enabled) {
        try {
            const { S3Client } = require('@aws-sdk/client-s3');
            s3Client = new S3Client({
                region: settings.backup.s3.region || 'us-east-1',
                endpoint: settings.backup.s3.endpoint || undefined,
                credentials: {
                    accessKeyId: settings.backup.s3.accessKeyId,
                    secretAccessKey: cryptoService.decryptSafe(settings.backup.s3.secretAccessKey),
                },
                forcePathStyle: !!settings.backup.s3.endpoint, // for MinIO and similar
            });
        } catch (err) {
            logger.error(`[Backup] Failed to initialize S3 client: ${err.message}`);
            return null;
        }
    }
    return s3Client;
}

/**
 * Create MongoDB backup
 */
async function createBackup(settings) {
    const backupDir = path.join(__dirname, '../../backups');

    await fs.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupName = `${BACKUP_FILE_PREFIX}${timestamp}`;
    const backupPath = path.join(backupDir, backupName);
    const archivePath = path.join(backupDir, `${backupName}.tar.gz`);

    try {
        const mongoUri = config.MONGO_URI;

        logger.info(`[Backup] Starting backup: ${backupName}`);
        await execFileAsync('mongodump', ['--uri', mongoUri, '--out', backupPath, '--gzip']);
        logger.info(`[Backup] Dump created: ${backupPath}`);

        // Record which ENCRYPTION_KEY the encrypted fields in this dump belong to,
        // so a restore onto another installation can warn instead of silently
        // producing unreadable SSH credentials and TOTP secrets.
        await fs.writeFile(
            path.join(backupPath, BACKUP_META_FILE),
            JSON.stringify({
                createdAt: new Date().toISOString(),
                encryptionKeyFingerprint: cryptoService.keyFingerprint(),
            }, null, 2)
        );

        await execFileAsync('tar', ['-czf', archivePath, '-C', backupDir, backupName]);
        logger.info(`[Backup] Archive created: ${archivePath}`);

        await fs.rm(backupPath, { recursive: true });

        const stats = await fs.stat(archivePath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        let s3 = {
            enabled: !!settings?.backup?.s3?.enabled,
            success: false,
            skipped: !settings?.backup?.s3?.enabled,
            key: null,
            error: null,
        };

        if (settings?.backup?.s3?.enabled) {
            try {
                s3 = await uploadToS3(archivePath, `${backupName}.tar.gz`, settings);
            } catch (error) {
                s3 = {
                    enabled: true,
                    success: false,
                    skipped: false,
                    key: null,
                    error: error.message,
                };
                logger.error(`[Backup] S3 upload error: ${error.message}`);
            }
        }

        const keepLast = settings?.backup?.keepLast || 7;
        await rotateBackups(backupDir, keepLast);

        const Settings = require('../models/settingsModel');
        await Settings.update({ 'backup.lastBackup': new Date() });

        logger.info(`[Backup] Completed: ${backupName} (${sizeMB} MB)`);

        return {
            success: true,
            filename: `${backupName}.tar.gz`,
            path: archivePath,
            size: stats.size,
            sizeMB: parseFloat(sizeMB),
            s3,
        };

    } catch (error) {
        logger.error(`[Backup] Error: ${error.message}`);

        try {
            await fs.rm(backupPath, { recursive: true }).catch(() => {});
        } catch (e) {}

        throw error;
    }
}

/**
 * Upload file to S3
 */
async function uploadToS3(filePath, fileName, settings) {
    const client = getS3Client(settings);
    if (!client) {
        throw new Error('S3 client not available');
    }

    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const fileStream = fsSync.createReadStream(filePath);
    const stats = await fs.stat(filePath);

    const bucket = settings.backup.s3.bucket;
    const key = buildS3Key(settings.backup.s3.prefix, fileName);

    logger.info(`[Backup] Uploading to S3: ${bucket}/${key}`);

    await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileStream,
        ContentLength: stats.size,
        ContentType: 'application/gzip',
    }));

    logger.info(`[Backup] Uploaded to S3: ${key}`);

    // Rotate in S3 if configured
    if (settings.backup.s3.keepLast) {
        await rotateS3Backups(settings);
    }

    return {
        enabled: true,
        success: true,
        skipped: false,
        key,
        error: null,
    };
}

/**
 * Rotate backups in S3
 */
async function rotateS3Backups(settings) {
    const client = getS3Client(settings);
    if (!client) return;
    
    try {
        const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
        
        const bucket = settings.backup.s3.bucket;
        const prefix = normalizeS3Prefix(settings.backup.s3.prefix);
        const keepLast = settings.backup.s3.keepLast || 7;
        
        const listResults = await Promise.all(BACKUP_FILE_PREFIXES.map(filePrefix => client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: buildS3Key(prefix, filePrefix),
        }))));
        const contents = listResults.flatMap(result => result.Contents || []);

        if (contents.length <= keepLast) {
            return;
        }
        
        // Sort by date (oldest first)
        const sorted = contents
            .filter(obj => isBackupKeyForPrefix(obj.Key, prefix))
            .sort((a, b) => a.LastModified - b.LastModified);
        
        // Delete excess
        const toDelete = sorted.slice(0, sorted.length - keepLast);
        
        for (const obj of toDelete) {
            await client.send(new DeleteObjectCommand({
                Bucket: bucket,
                Key: obj.Key,
            }));
            logger.info(`[Backup] Deleted from S3: ${obj.Key}`);
        }
        
    } catch (error) {
        logger.error(`[Backup] S3 rotation error: ${error.message}`);
    }
}

/**
 * Rotate local backups (keep last N)
 */
async function rotateBackups(backupDir, keepLast) {
    try {
        const entries = await fs.readdir(backupDir, { withFileTypes: true });
        const files = await Promise.all(
            entries
                .filter(e => e.isFile() && isBackupFileName(e.name))
                .map(async (e) => {
                    const filePath = path.join(backupDir, e.name);
                    const stats = await fs.stat(filePath);
                    return { name: e.name, path: filePath, mtime: stats.mtime };
                })
        );
        files.sort((a, b) => a.mtime - b.mtime);

        if (files.length <= keepLast) {
            return;
        }

        const toDelete = files.slice(0, files.length - keepLast);

        for (const file of toDelete) {
            await fs.unlink(file.path);
            logger.info(`[Backup] Rotated old backup: ${file.name}`);
        }

        logger.info(`[Backup] Rotation complete. Kept ${keepLast} backups, deleted ${toDelete.length}`);

    } catch (error) {
        logger.error(`[Backup] Rotation error: ${error.message}`);
    }
}

/**
 * Get list of local backups
 */
async function listBackups() {
    const backupDir = path.join(__dirname, '../../backups');

    try {
        await fs.access(backupDir);
    } catch {
        return [];
    }

    const entries = await fs.readdir(backupDir, { withFileTypes: true });
    const files = await Promise.all(
        entries
            .filter(e => e.isFile() && isBackupFileName(e.name))
            .map(async (e) => {
                const filePath = path.join(backupDir, e.name);
                const stats = await fs.stat(filePath);
                return {
                    name: e.name,
                    path: filePath,
                    size: stats.size,
                    sizeMB: (stats.size / 1024 / 1024).toFixed(2),
                    created: stats.mtime,
                };
            })
    );
    files.sort((a, b) => b.created - a.created);
    return files;
}

/**
 * Check if backup should run
 */
async function shouldRunBackup(settings) {
    if (!settings?.backup?.enabled) {
        return false;
    }
    
    const intervalHours = settings.backup.intervalHours || 24;
    const lastBackup = settings.backup.lastBackup;
    
    if (!lastBackup) {
        return true; // Never backed up before
    }
    
    const hoursSinceLastBackup = (Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60);
    
    return hoursSinceLastBackup >= intervalHours;
}

/**
 * Scheduled backup (called from cron)
 */
async function scheduledBackup() {
    try {
        const Settings = require('../models/settingsModel');
        const settings = await Settings.get();
        
        if (await shouldRunBackup(settings)) {
            logger.info('[Backup] Starting scheduled backup');
            await createBackup(settings);
        }
    } catch (error) {
        logger.error(`[Backup] Scheduled backup failed: ${error.message}`);
    }
}

/**
 * Test S3 connection
 */
async function testS3Connection(s3Config) {
    try {
        const {
            S3Client,
            HeadBucketCommand,
            PutObjectCommand,
            DeleteObjectCommand,
        } = require('@aws-sdk/client-s3');
        
        const client = new S3Client({
            region: s3Config.region || 'us-east-1',
            endpoint: s3Config.endpoint || undefined,
            credentials: {
                accessKeyId: s3Config.accessKeyId,
                secretAccessKey: s3Config.secretAccessKey,
            },
            forcePathStyle: !!s3Config.endpoint,
        });
        
        await client.send(new HeadBucketCommand({ Bucket: s3Config.bucket }));

        const testKey = buildS3Key(
            s3Config.prefix || 'backups',
            `.celerity-s3-test-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.txt`
        );

        await client.send(new PutObjectCommand({
            Bucket: s3Config.bucket,
            Key: testKey,
            Body: 'celerity-s3-write-test',
            ContentType: 'text/plain',
        }));

        await client.send(new DeleteObjectCommand({
            Bucket: s3Config.bucket,
            Key: testKey,
        }));

        return { success: true };
        
    } catch (error) {
        return { 
            success: false, 
            error: error.message,
        };
    }
}

/**
 * Get list of backups from S3
 */
async function listS3Backups(settings) {
    const client = getS3Client(settings);
    if (!client) {
        return [];
    }
    
    try {
        const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
        
        const bucket = settings.backup.s3.bucket;
        const prefix = normalizeS3Prefix(settings.backup.s3.prefix);
        
        const results = await Promise.all(BACKUP_FILE_PREFIXES.map(filePrefix => client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: buildS3Key(prefix, filePrefix),
        }))));
        const contents = results.flatMap(result => result.Contents || []);

        if (contents.length === 0) {
            return [];
        }
        
        return contents
            .filter(obj => isBackupKeyForPrefix(obj.Key, prefix))
            .map(obj => ({
                name: obj.Key.split('/').pop(),
                key: obj.Key,
                size: obj.Size,
                sizeMB: (obj.Size / 1024 / 1024).toFixed(2),
                created: obj.LastModified,
                source: 's3',
            }))
            .sort((a, b) => b.created - a.created); // newest first
            
    } catch (error) {
        logger.error(`[Backup] List S3 backups error: ${error.message}`);
        return [];
    }
}

/**
 * Get a readable stream for an S3 backup object (for HTTP download).
 * Returns { stream, contentLength, contentType }.
 */
async function getS3BackupStream(settings, key) {
    const client = getS3Client(settings);
    if (!client) {
        throw new Error('S3 client not available');
    }

    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const bucket = settings.backup.s3.bucket;

    const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));

    return {
        stream: response.Body,
        contentLength: response.ContentLength,
        contentType: response.ContentType || 'application/gzip',
    };
}

/**
 * Resolve absolute path of a local backup file by name (with safety checks).
 */
function getLocalBackupPath(name) {
    const backupDir = path.join(__dirname, '../../backups');
    const safeName = path.basename(name || '');
    if (!safeName || safeName === '.' || safeName === '..') {
        throw new Error('Invalid backup name');
    }
    if (!isBackupFileName(safeName)) {
        throw new Error('Invalid backup name');
    }
    return path.join(backupDir, safeName);
}

/**
 * Download backup from S3 for restore
 */
async function downloadFromS3(settings, key) {
    const client = getS3Client(settings);
    if (!client) {
        throw new Error('S3 client not available');
    }
    
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    
    const bucket = settings.backup.s3.bucket;
    const fileName = path.basename(key);
    if (!fileName || fileName === '.' || fileName === '..') {
        throw new Error('Invalid S3 key');
    }
    const localPath = path.join('/tmp', `celerity-s3-restore-${Date.now()}-${fileName}`);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    
    logger.info(`[Backup] Downloading from S3: ${key}`);
    
    const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
    }));
    
    const writeStream = fsSync.createWriteStream(localPath);
    
    await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream);
        response.Body.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
    
    logger.info(`[Backup] Downloaded: ${localPath}`);
    
    return localPath;
}

/**
 * Restore database from an extracted archive path.
 */
async function restoreArchive(archivePath, source, identifier) {
    const extractDir = path.join('/tmp', `restore-${Date.now()}`);

    try {
        await fs.mkdir(extractDir, { recursive: true });

        await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir]);
        logger.info(`[Restore] Archive extracted to ${extractDir}`);

        const dbName = getDbName();

        const findDumpPath = async (dir) => {
            const items = await fs.readdir(dir);
            const dbPath = path.join(dir, dbName);
            try {
                const stat = await fs.stat(dbPath);
                if (stat.isDirectory()) return dir;
            } catch {}
            if (items.length === 1) {
                const subPath = path.join(dir, items[0]);
                const stat = await fs.stat(subPath);
                if (stat.isDirectory()) return findDumpPath(subPath);
            }
            return dir;
        };

        const dumpPath = await findDumpPath(extractDir);
        const dbDir = path.join(dumpPath, dbName);

        try {
            await fs.access(dbDir);
        } catch {
            throw new Error(`Invalid backup: ${dbName} database folder not found`);
        }

        const mongoUri = config.MONGO_URI;

        // Checked before the restore so the warning is emitted even if mongorestore
        // later fails. A mismatch is not fatal: the data itself restores fine, only
        // the encrypted fields become unreadable.
        const encryptionKey = await readEncryptionKeyStatus(dumpPath);
        if (encryptionKey.status === 'mismatch') {
            logger.warn('[Restore] Backup was created with a different ENCRYPTION_KEY. SSH credentials, TOTP secrets and other encrypted fields in this dump cannot be decrypted. Restore the original key from the old .env, or re-enter SSH credentials and reset 2FA (node scripts/reset-2fa.js <username>).');
        } else if (encryptionKey.status === 'unknown') {
            logger.info('[Restore] Backup has no ENCRYPTION_KEY fingerprint (created by an older version) — key match could not be verified.');
        }

        logger.info(`[Restore] Starting restore from ${source}: ${identifier}`);
        await execFileAsync('mongorestore', ['--uri', mongoUri, '--drop', '--gzip', '--db', dbName, dbDir]);
        logger.info(`[Restore] Database restored successfully`);

        await fs.rm(extractDir, { recursive: true });

        return { success: true, encryptionKey };

    } catch (error) {
        try {
            await fs.rm(extractDir, { recursive: true }).catch(() => {});
        } catch (e) {}

        throw error;
    }
}

/**
 * Restore from backup (local or S3)
 */
async function restoreBackup(settings, source, identifier) {
    let archivePath;
    let tempDownload = false;

    if (source === 's3') {
        if (!isBackupKeyForPrefix(identifier, settings?.backup?.s3?.prefix || 'backups')) {
            throw new Error('Invalid S3 key');
        }
        archivePath = await downloadFromS3(settings, identifier);
        tempDownload = true;
    } else {
        const safeName = path.basename(identifier);
        if (!safeName || safeName === '.' || safeName === '..') {
            throw new Error('Invalid backup identifier');
        }
        archivePath = path.join(__dirname, '../../backups', safeName);
        try {
            await fs.access(archivePath);
        } catch {
            throw new Error('Backup file not found');
        }
    }

    try {
        return await restoreArchive(archivePath, source, identifier);
    } finally {
        if (tempDownload) {
            await fs.unlink(archivePath).catch(() => {});
        }
    }
}

/**
 * Restore from an uploaded archive file.
 */
async function restoreUploadedBackup(filePath, originalName) {
    const safeName = path.basename(originalName || filePath || '');
    if (!safeName || safeName === '.' || safeName === '..') {
        throw new Error('Invalid backup file');
    }
    if (!safeName.endsWith('.tar.gz') && !safeName.endsWith('.tgz')) {
        throw new Error('Only .tar.gz or .tgz files are allowed');
    }

    try {
        await fs.access(filePath);
    } catch {
        throw new Error('Backup file not found');
    }

    return restoreArchive(filePath, 'upload', safeName);
}

module.exports = {
    createBackup,
    listBackups,
    listS3Backups,
    downloadFromS3,
    getS3BackupStream,
    getLocalBackupPath,
    restoreBackup,
    restoreUploadedBackup,
    isBackupKeyForPrefix,
    shouldRunBackup,
    scheduledBackup,
    testS3Connection,
    rotateBackups,
    resetS3Client() { s3Client = null; },
};

