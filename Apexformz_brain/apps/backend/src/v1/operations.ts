import { Router, type RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../utils/prisma';
let requests = 0;
let errors = 0;
let latency = 0;
export const recordOperations: RequestHandler = (_req, res, next) => {
  const start = performance.now();
  res.once('finish', () => { requests++; errors += Number(res.statusCode >= 500); latency += performance.now() - start; });
  next();
};
export const operationsRouter = Router();
operationsRouter.use((req, res, next) => {
  const expected = Buffer.from(process.env.APEXFORMZ_SERVICE_TOKEN ?? '');
  const supplied = Buffer.from(String(req.headers['x-service-token'] ?? ''));
  if (expected.length < 32 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return res.sendStatus(401);
  next();
});
operationsRouter.get('/metrics', async (_req, res) => {
  try {
    const [queued, expiredLeases, pendingDeletion, failed] = await Promise.all([
      prisma.analysisJob.count({ where: { status: { in: ['QUEUED', 'RETRYABLE'] } } }),
      prisma.analysisJob.count({ where: { status: 'RUNNING', lease_expires_at: { lt: new Date() } } }),
      prisma.objectAsset.count({ where: { status: 'DELETING', delete_after: { lt: new Date(Date.now() - 120000) } } }),
      prisma.analysisJob.count({ where: { status: 'FAILED', updated_at: { gt: new Date(Date.now() - 3600000) } } }),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ requests, errors, latency_ms_total: latency, queued_jobs: queued, expired_leases: expiredLeases,
      pending_deletions: pendingDeletion, failed_jobs_1h: failed, uptime_s: process.uptime(), release: process.env.APEXFORMZ_RELEASE_ID ?? 'local' });
  } catch { return res.sendStatus(503); }
});

