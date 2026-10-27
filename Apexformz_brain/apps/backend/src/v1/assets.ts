import { Router, raw } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, DeleteObjectsCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../utils/prisma';
import { authenticateToken, type AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import axios from 'axios';

export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const ASSET_TYPES = new Set(['application/json', 'video/mp4', 'video/webm', 'image/jpeg', 'image/png']);
let client: S3Client | undefined;
export function storageConfig() {
  const bucket = process.env.APEXFORMZ_S3_BUCKET;
  const region = process.env.AWS_REGION;
  if (!bucket || !region) throw new Error('Private S3 storage is not configured');
  return { Bucket: bucket, ExpectedBucketOwner: process.env.APEXFORMZ_AWS_ACCOUNT_ID };
}
export function s3() {
  storageConfig();
  return client ??= new S3Client({ region: process.env.AWS_REGION, maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 } });
}
export async function storageReady() { await s3().send(new HeadBucketCommand(storageConfig())); }
export function checkUpload(bytes: Buffer, mime: string, hash: string, consent: string) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ASSET_BYTES) throw new Error('Empty or oversized asset');
  if (!ASSET_TYPES.has(mime)) throw new Error('Unsupported asset type');
  if (!['deep_analysis', 'quality_improvement'].includes(consent)) throw new Error('Explicit consent required');
  if (!/^[a-f0-9]{64}$/.test(hash) || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('SHA-256 mismatch');
}
export async function resolveOwnedAsset(id: string, owner: string, consent: string) {
  const asset = await prisma.objectAsset.findFirst({ where: {
    id, owner_id: owner, consent_scope: consent, status: 'READY', expires_at: { gt: new Date() },
  } });
  if (!asset?.version_id) throw new Error('Asset unavailable or not owned/consented');
  return asset;
}
export async function purgeVersions(key: string) {
  // Exact key only: a prefix match must never delete a neighbouring asset.
  // This SDK does not expose a ListObjectVersions paginator; both markers are required.
  let keyMarker: string | undefined;
  let versionMarker: string | undefined;
  do {
    const page = await s3().send(new ListObjectVersionsCommand({ ...storageConfig(), Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
    const objects = [...page.Versions ?? [], ...page.DeleteMarkers ?? []]
      .filter(v => v.Key === key && v.VersionId).map(v => ({ Key: key, VersionId: v.VersionId! }));
    if (objects.length) {
      const result = await s3().send(new DeleteObjectsCommand({ ...storageConfig(), Delete: { Objects: objects, Quiet: true } }));
      if (result.Errors?.length) throw new Error('S3 version deletion incomplete');
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker);
}
export async function requestAssetDeletion(id: string, owner: string) {
  const asset = await prisma.objectAsset.findFirst({ where: { id, owner_id: owner } });
  if (!asset) return null;
  // Recovery must reapply these tombstones after restoring an older database backup.
  await s3().send(new PutObjectCommand({ ...storageConfig(), Key: 'deletions/' + id + '.json',
    Body: JSON.stringify({ asset_id: id, storage_key: asset.storage_key, requested_at: new Date().toISOString() }),
    ContentType: 'application/json', ServerSideEncryption: 'AES256' }));
  await prisma.$transaction(async tx => {
    await tx.objectAsset.update({ where: { id }, data: { status: 'DELETING',
      // No signed upload URLs exist. This also fences an in-flight server upload.
      delete_after: new Date(Math.max(Date.now(), asset.created_at.getTime() + 5 * 60000)) } });
    await tx.analysisJob.updateMany({ where: { asset_ref: id, owner_id: owner }, data: {
      status: 'FAILED', error: 'ASSET_DELETED', request: Prisma.DbNull, output: Prisma.DbNull,
      output_ref: null, lease_token: null, lease_expires_at: null, next_attempt_at: null,
    } });
  });
  return asset;
}
let sweepRunning = false;
export async function sweepAssets() {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const expired = await prisma.objectAsset.findMany({ where: { OR: [
      { status: 'READY', expires_at: { lte: new Date() } },
      { status: 'UPLOADING', created_at: { lte: new Date(Date.now() - 5 * 60000) } },
    ] }, take: 100 });
    for (const a of expired) await requestAssetDeletion(a.id, a.owner_id);
    const pending = await prisma.objectAsset.findMany({ where: { status: 'DELETING', delete_after: { lte: new Date() } }, take: 100 });
    for (const a of pending) {
      await purgeVersions(a.storage_key);
      const jobs = await prisma.analysisJob.findMany({ where: { asset_ref: a.id } });
      for (const job of jobs) {
        await axios.delete((process.env.AI_SERVICE_URL || 'http://localhost:8000') + '/v1/analysis/jobs/' + encodeURIComponent(job.remote_id ?? job.id),
          { timeout: 10000, headers: { 'X-Service-Token': process.env.APEXFORMZ_SERVICE_TOKEN ?? '' } });
        await prisma.analysisJob.update({ where: { id: job.id }, data: { remote_id: null } });
      }
      await prisma.objectAsset.updateMany({ where: { id: a.id, status: 'DELETING' }, data: { status: 'DELETED', deleted_at: new Date() } });
    }
  } finally { sweepRunning = false; }
}
export function startAssetRetention() {
  if (!process.env.APEXFORMZ_S3_BUCKET || process.env.ENABLE_ASSET_RETENTION === 'false') return null;
  const run = () => void sweepAssets().catch(() => logger.error('Asset retention sweep failed; inspect S3 access and database'));
  run();
  const timer = setInterval(run, 60000); timer.unref();
  return timer;
}
export const assetRouter = Router();
assetRouter.use(authenticateToken);
// Binary body avoids base64 expansion; Content-Type is application/octet-stream.
// X-Asset-Content-Type describes the stored media and is validated before upload.
assetRouter.post('/', raw({ type: 'application/octet-stream', limit: MAX_ASSET_BYTES }), async (req: AuthRequest, res) => {
  const mime = String(req.headers['x-asset-content-type'] ?? '');
  const hash = String(req.headers['x-content-sha256'] ?? '');
  const consent = String(req.headers['x-consent-scope'] ?? '');
  try { checkUpload(req.body, mime, hash, consent); } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  const id = randomUUID();
  try {
    storageConfig();
    const expires = new Date(Date.now() + (consent === 'deep_analysis' ? 7 : 30) * 86400000);
    const key = 'assets/' + id;
    await prisma.objectAsset.create({ data: { id, owner_id: req.userId!, storage_key: key, hash,
      content_type: mime, byte_size: req.body.length, consent_scope: consent, retention_policy: consent === 'deep_analysis' ? '7d' : '30d',
      encryption_metadata: { algorithm: 'AES256', bucket: storageConfig().Bucket }, status: 'UPLOADING', expires_at: expires } });
    const result = await s3().send(new PutObjectCommand({ ...storageConfig(), Key: key, Body: req.body, ContentType: mime,
      ServerSideEncryption: 'AES256', ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64'), IfNoneMatch: '*' }));
    if (!result.VersionId) throw new Error('S3 bucket versioning is required');
    const ready = await prisma.objectAsset.updateMany({ where: { id, status: 'UPLOADING' },
      data: { status: 'READY', version_id: result.VersionId } });
    if (ready.count !== 1) { await purgeVersions(key); throw new Error('Asset deleted during upload'); }
    return res.status(201).json({ data: { asset_ref: id, sha256: hash, expires_at: expires, status: 'READY' } });
  } catch {
    await prisma.objectAsset.updateMany({ where: { id, status: 'UPLOADING' }, data: { status: 'DELETING', delete_after: new Date(Date.now() + 5 * 60000) } }).catch(() => undefined);
    return res.status(503).json({ error: 'Private asset storage unavailable' });
  }
});
assetRouter.get('/:id/download', async (req: AuthRequest, res) => {
  try {
    const a = await prisma.objectAsset.findFirst({ where: { id: req.params.id, owner_id: req.userId, status: 'READY', expires_at: { gt: new Date() } } });
    if (!a?.version_id) return res.status(404).json({ error: 'Asset unavailable' });
    const url = await getSignedUrl(s3(), new GetObjectCommand({ ...storageConfig(), Key: a.storage_key, VersionId: a.version_id,
      ResponseContentDisposition: 'attachment', ResponseContentType: 'application/octet-stream' }), { expiresIn: 60 });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ data: { url, expires_in_s: 60 } });
  } catch { return res.status(503).json({ error: 'Private asset storage unavailable' }); }
});
assetRouter.delete('/:id', async (req: AuthRequest, res) => {
  try {
    if (!await requestAssetDeletion(req.params.id, req.userId!)) return res.status(404).json({ error: 'Asset unavailable' });
    await sweepAssets();
    return res.status(202).json({ data: { status: 'DELETING', asset_ref: req.params.id } });
  } catch { return res.status(503).json({ error: 'Deletion pending; retry required' }); }
});

