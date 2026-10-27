/**
 * ApexFormz Brain v1 REST API (TRD 13). API version is distinct from model,
 * sport-pack and data-schema versions; every response carries X-API-Version.
 */
import { Router, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { coreSatisfiesMinimum, validators } from '@apexformz/contracts';
import { authenticateToken, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import logger from '../utils/logger';
import { GamificationEngine } from '../utils/gamification';
import { ingestBatch } from './ingestion';
import { PrismaSessionEventRepository } from './prismaEventRepository';
import { isNotModified, listPacks, readAsset, readManifest, safeSportId, strongEtag } from './packs';
import { aggregateProgress } from './progress';
import { Prisma } from '@prisma/client';
import { completionPayload, presentBrainSession } from './sessionReview';

const router = Router();
const repo = new PrismaSessionEventRepository();

router.use((req, res: Response, next: NextFunction) => {
  res.setHeader('X-API-Version', '1');
  next();
});
router.use(authenticateToken);

async function ownedSession(req: AuthRequest, res: Response, id: string) {
  const session = await prisma.brainSession.findUnique({ where: { id } });
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found' });
    return null;
  }
  if (session.athlete_id !== req.userId) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return null;
  }
  return session;
}

// Authenticated history always scopes at the database boundary.
router.get('/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const sessions = await prisma.brainSession.findMany({ where: { athlete_id: req.userId! }, orderBy: { started_at: 'desc' }, take: 500 });
    return res.json({ success: true, data: sessions.map(presentBrainSession) });
  } catch (e) {
    logger.error('List brain sessions error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.get('/sessions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const session = await ownedSession(req, res, req.params.id);
    if (!session) return;
    return res.json({ success: true, data: presentBrainSession(session) });
  } catch (e) {
    logger.error('Get brain session error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/v1/sessions
router.post('/sessions', async (req: AuthRequest, res: Response) => {
  if (!validators.sessionStartRequest(req.body)) {
    return res.status(400).json({ success: false, error: 'SCHEMA_INVALID', details: validators.sessionStartRequest.errors.slice(0, 5) });
  }
  const r = req.body;
  try {
    const existing = await prisma.brainSession.findUnique({ where: { id: r.session_id } });
    if (existing) {
      if (existing.athlete_id !== req.userId) return res.status(403).json({ success: false, error: 'Forbidden' });
      return res.status(200).json({ success: true, data: existing }); // idempotent re-post
    }
    const session = await prisma.brainSession.create({
      data: { id: r.session_id, athlete_id: req.userId!, sport_id: r.sport_pack_id, pack_version: r.sport_pack_version, movement_id: r.movement_id, status: 'ACTIVE' },
    });
    logger.info(`🧠 Brain session ${session.id.slice(0, 8)} started (${r.sport_pack_id}@${r.sport_pack_version} ${r.movement_id})`);
    return res.status(201).json({ success: true, data: session });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      const existing = await prisma.brainSession.findUnique({ where: { id: r.session_id } });
      if (existing?.athlete_id === req.userId) return res.status(200).json({ success: true, data: existing });
      if (existing) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    logger.error('Create brain session error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/v1/sessions/:id/events  (batch, idempotent by event_id)
router.post('/sessions/:id/events', async (req: AuthRequest, res: Response) => {
  try {
    const session = await ownedSession(req, res, req.params.id);
    if (!session) return;
    const outcome = await ingestBatch(repo, session.id, req.body);
    logger.info(`📥 Ingested ${outcome.accepted.length} event(s) for ${session.id.slice(0, 8)} (dup=${outcome.duplicates.length}, rejected=${outcome.rejected.length})`);
    return res.status(200).json({ success: true, data: outcome });
  } catch (e) {
    logger.error('Ingest events error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/v1/sessions/:id/complete
router.post(
  '/sessions/:id/complete',
  [body('summary').isObject(), body('summary.last_score').optional({ nullable: true }).isFloat({ min: 0, max: 1 }), body('duration_s').optional().isInt({ min: 0 })],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });
    let payload: ReturnType<typeof completionPayload>;
    try { payload = completionPayload(req.body, req.params.id); }
    catch (e) { return res.status(400).json({ success: false, error: (e as Error).message }); }
    const summary = payload.summary;
    try {
      const result = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "BrainSession" WHERE "id" = ${req.params.id} FOR UPDATE`;
        const session = await tx.brainSession.findUnique({ where: { id: req.params.id } });
        if (!session) return { error: 'Session not found', status: 404 };
        if (session.athlete_id !== req.userId) return { error: 'Forbidden', status: 403 };
        if ((summary.sport_pack_id !== undefined && summary.sport_pack_id !== session.sport_id)
          || (summary.sport_pack_version !== undefined && summary.sport_pack_version !== session.pack_version)
          || (summary.movement_id !== undefined && summary.movement_id !== session.movement_id)) return { error: 'Summary does not match session', status: 400 };
        if (payload.review.session_technique_review && (payload.review.session_technique_review as { movement_id: string }).movement_id !== session.movement_id) return { error: 'Technique review does not match session', status: 400 };
        if (session.status === 'COMPLETED') {
          // A retry can confirm delivery of the remaining events, but cannot award XP twice or replace the verdict.
          const saved = (session.summary ?? {}) as Record<string, unknown>;
          const updated = summary.outbox_pending === 0 && Number(saved.outbox_pending) > 0
            ? await tx.brainSession.update({ where: { id: session.id }, data: { summary: { ...saved, outbox_pending: 0 } as object } }) : session;
          return { data: { session: updated, review: presentBrainSession(updated), gamification: null } };
        }
        const durationS = Number(payload.duration_s ?? Math.min(86400, Math.max(0, Math.round((Date.now() - session.started_at.getTime()) / 1000))));
        let gamification = null;
        const lastScore = typeof summary.last_score === 'number' ? summary.last_score : null;
        let xp = 0;
        if (durationS > 0) {
          xp = lastScore === null ? Math.max(10, Math.floor(durationS / 10)) : GamificationEngine.calculateSessionXp(durationS, lastScore * 100);
          gamification = await GamificationEngine.processSessionResult(req.userId!, xp, lastScore === null ? 0 : lastScore * 100, durationS, session.sport_id, tx);
        }
        const updated = await tx.brainSession.update({ where: { id: session.id }, data: { status: 'COMPLETED', ended_at: new Date(), summary: { ...summary, _review: payload.review, duration_s: durationS, xp_earned: xp } as object } });
        return { data: { session: updated, review: presentBrainSession(updated), gamification } };
      }, { timeout: 15000 });
      if ('error' in result) return res.status(result.status ?? 500).json({ success: false, error: result.error });
      return res.json({ success: true, data: result.data });
    } catch (e) {
      logger.error('Complete brain session error:', e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  },
);

// GET /api/v1/sport-packs
router.get('/sport-packs', async (_req: AuthRequest, res: Response) => {
  try {
    return res.json({ success: true, data: await listPacks() });
  } catch (e) {
    logger.error('List packs error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/v1/sport-packs/:sportId/manifest
router.get('/sport-packs/:sportId/manifest', async (req: AuthRequest, res: Response) => {
  if (!safeSportId(req.params.sportId)) return res.status(400).json({ success: false, error: 'Invalid sport id' });
  const m = await readManifest(req.params.sportId);
  if (!m) return res.status(404).json({ success: false, error: 'Sport pack not found' });
  const etag = strongEtag(m.text);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=60');
  if (isNotModified(req.headers['if-none-match'] as string | undefined, etag)) return res.status(304).end();
  res.type('application/json');
  return res.send(m.text);
});

// GET /api/v1/sport-packs/:sportId/assets/:asset
router.get('/sport-packs/:sportId/assets/:asset', async (req: AuthRequest, res: Response) => {
  if (!safeSportId(req.params.sportId)) return res.status(400).json({ success: false, error: 'Invalid sport id' });
  const text = await readAsset(req.params.sportId, req.params.asset);
  if (text === null) return res.status(404).json({ success: false, error: 'Asset not found or not listed in manifest' });
  const etag = strongEtag(text);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (isNotModified(req.headers['if-none-match'] as string | undefined, etag)) return res.status(304).end();
  res.type('application/json');
  return res.send(text);
});

// GET /api/v1/model-releases/compatible?core_version=1.0.0&platform=web
router.get('/model-releases/compatible', async (req: AuthRequest, res: Response) => {
  const core = String(req.query.core_version ?? '');
  const platform = String(req.query.platform ?? 'web');
  if (!/^\d+\.\d+\.\d+$/.test(core)) return res.status(400).json({ success: false, error: 'core_version must be semver' });
  try {
    const rows = await prisma.modelRelease.findMany({ orderBy: { created_at: 'desc' } });
    const compatible = rows.filter((r) => {
      const c = r.compatibility as { minimum_core_version?: string; platforms?: string[] };
      if (!c.minimum_core_version || !coreSatisfiesMinimum(c.minimum_core_version, core)) return false;
      return !c.platforms || c.platforms.includes(platform);
    });
    return res.json({ success: true, data: compatible });
  } catch (e) {
    logger.error('Model releases error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// POST /api/v1/analysis/jobs
router.post(
  '/analysis/jobs',
  [
    body('consent_scope').isIn(['deep_analysis', 'quality_improvement']),
    body('asset_ref').optional().isString(),
    body('feature_bundle_ref').optional().isString(),
    body('feature_bundle').optional().isArray({ min: 1, max: 5000 }),
    body('handedness').optional().isIn(['left', 'right', 'unknown']),
    body('view').optional().isString(),
    body('capabilities').optional().isArray(),
    body('capabilities.*').optional().isString(),
    body('sport_pack_id').isString(),
    body('sport_pack_version').isString(),
    body('movement_id').isString(),
  ],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, error: errors.array()[0].msg });
    const { asset_ref, feature_bundle_ref, feature_bundle, consent_scope, sport_pack_id, sport_pack_version, movement_id, handedness, view, capabilities } = req.body;
    if (!asset_ref && !feature_bundle_ref && !feature_bundle) return res.status(400).json({ success: false, error: 'asset_ref, feature_bundle_ref or feature_bundle required' });
    if (feature_bundle && !feature_bundle.every((frame: unknown) => validators.poseFrame(frame))) return res.status(400).json({ success: false, error: 'feature_bundle contains an invalid PoseFrame' });
    try {
      const job = await prisma.$transaction(async tx => {
        const ref = asset_ref ?? feature_bundle_ref;
        if (ref) {
          const assets = await tx.$queryRaw<Array<{id: string}>>(Prisma.sql`SELECT "id" FROM "ObjectAsset" WHERE "id" = ${ref} AND "owner_id" = ${req.userId!} AND "consent_scope" = ${consent_scope} AND "status" = 'READY' AND "expires_at" > (NOW() AT TIME ZONE 'UTC') FOR UPDATE`);
          if (!assets.length) return null;
        }
        return tx.analysisJob.create({
        data: { owner_id: req.userId!, asset_ref: asset_ref ?? feature_bundle_ref, consent_scope, status: 'QUEUED', request: {
          sport_pack_id, sport_pack_version, movement_id, kind: feature_bundle ? 'feature_bundle' : asset_ref ? 'asset' : 'feature_bundle_ref',
          ...(feature_bundle ? { feature_bundle } : {}), ...(handedness ? { handedness } : {}), ...(view ? { view } : {}), ...(capabilities ? { capabilities } : {}),
        } },
        });
      });
      if (!job) return res.status(404).json({ success: false, error: 'Asset unavailable or not owned/consented' });
      return res.status(202).json({ success: true, data: { job_id: job.id, status: job.status, retry_after_ms: 3000 } });
    } catch (e) {
      logger.error('Create analysis job error:', e);
      return res.status(500).json({ success: false, error: 'Server error' });
    }
  },
);

// GET /api/v1/analysis/jobs/:jobId
router.get('/analysis/jobs/:jobId', async (req: AuthRequest, res: Response) => {
  try {
    const job = await prisma.analysisJob.findUnique({ where: { id: req.params.jobId } });
    if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
    if (job.owner_id !== req.userId) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json({ success: true, data: job });
  } catch (e) {
    logger.error('Get analysis job error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/v1/athletes/:athleteId/progress
router.get('/athletes/:athleteId/progress', async (req: AuthRequest, res: Response) => {
  if (req.params.athleteId !== req.userId) return res.status(403).json({ success: false, error: 'Forbidden' });
  try {
    const sessions = await prisma.brainSession.findMany({ where: { athlete_id: req.userId } });
    const assessments = await prisma.criterionAssessment.findMany({ where: { session_id: { in: sessions.map((s) => s.id) } } });
    const progress = aggregateProgress(
      sessions,
      assessments.map((a) => ({ session_id: a.session_id, movement_id: '', criterion_id: a.criterion_id, status: a.status, score: a.score, rubric_version: a.rubric_version, created_at: a.created_at })),
    );
    return res.json({ success: true, data: progress });
  } catch (e) {
    logger.error('Progress error:', e);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
});

export default router;
