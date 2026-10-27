import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { completionPayload, presentBrainSession } from './sessionReview';

const db = vi.hoisted(() => ({ findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), transaction: vi.fn(), reward: vi.fn() }));
vi.mock('../utils/prisma', () => ({ prisma: { brainSession: { findUnique: db.findUnique, findMany: db.findMany, update: db.update }, $transaction: db.transaction } }));
vi.mock('../utils/logger', () => ({ default: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../utils/gamification', () => ({ GamificationEngine: { calculateSessionXp: () => 20, processSessionResult: db.reward } }));
import router from './router';

const row = () => ({ id: 's1', athlete_id: 'athlete-a', sport_id: 'squash', movement_id: 'squash.ready_stance', pack_version: '1.0.0', status: 'ACTIVE', started_at: new Date('2026-10-26T09:00:00Z'), ended_at: null as Date | null, summary: null as any });
function request(method: string, path: string, user: string | null = 'athlete-a', body: unknown = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req: any = { method, url: path, headers: user ? { authorization: `Bearer ${jwt.sign({ userId: user }, 'test-session-secret')}` } : {}, body };
    const res: any = { statusCode: 200, setHeader: () => {}, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { resolve({ status: this.statusCode, body: value }); return this; } };
    router.handle(req, res, (error: unknown) => error ? reject(error) : reject(new Error('Route not handled')));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-session-secret';
  const saved = row();
  db.findUnique.mockImplementation(async ({ where }) => where.id === 's1' ? saved : null);
  db.findMany.mockImplementation(async ({ where }) => where.athlete_id === saved.athlete_id ? [saved] : []);
  db.update.mockImplementation(async ({ data }) => Object.assign(saved, data));
  db.transaction.mockImplementation(async fn => fn({ brainSession: { findUnique: db.findUnique, update: db.update }, $queryRaw: vi.fn() }));
  db.reward.mockResolvedValue({ xpEarned: 10 });
});

describe('authenticated Brain session review API', () => {
  it('requires authentication, restricts detail ownership and scopes history queries', async () => {
    expect((await request('GET', '/sessions', null)).status).toBe(401);
    expect(db.findMany).not.toHaveBeenCalled();
    expect((await request('GET', '/sessions/s1', 'athlete-b')).status).toBe(403);
    expect((await request('GET', '/sessions/missing')).status).toBe(404);
    const history = await request('GET', '/sessions');
    expect(history.status).toBe(200);
    expect(history.body.data[0]).toMatchObject({ session_id: 's1', athlete_id: 'athlete-a', summary: null, pack: { id: 'squash', version: '1.0.0' } });
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { athlete_id: 'athlete-a' } }));
    expect((await request('GET', '/sessions', 'athlete-b')).body.data).toEqual([]);
  });

  it('persists duration/review and unscored verdict, and awards completion once on retries', async () => {
    const body = { summary: { session_id: 's1', sport_pack_id: 'squash', sport_pack_version: '1.0.0', movement_id: 'squash.ready_stance', frames_processed: 20, last_score: null, outbox_pending: 2 }, duration_s: 60, review: { movement_name: 'Ready stance', mode: 'strict', pose_backend: 'mediapipe', repetition: { rep_count: 3, periodicity: .8, period_ms: 1000, dominant_feature: 'knee_angle' } } };
    const complete = await request('POST', '/sessions/s1/complete', 'athlete-a', body);
    expect(complete.status).toBe(200);
    expect(complete.body.data.review).toMatchObject({ duration_s: 60, movement_name: 'Ready stance', xp_earned: 10, summary: { last_score: null }, completion_sync: 'pending' });
    const retry = await request('POST', '/sessions/s1/complete', 'athlete-a', { ...body, summary: { ...body.summary, last_score: 1, outbox_pending: 0 } });
    expect(retry.status).toBe(200);
    expect(db.reward).toHaveBeenCalledTimes(1);
    const detail = await request('GET', '/sessions/s1');
    expect(detail.body.data).toMatchObject({ duration_s: 60, movement_name: 'Ready stance', mode: 'strict', completion_sync: 'synced', summary: { last_score: null }, repetition: { rep_count: 3 } });
    expect(detail.body.data.summary._review).toBeUndefined();
  });

  it('rejects foreign completion ownership and mismatched/invalid payloads before writes', async () => {
    expect((await request('POST', '/sessions/s1/complete', 'athlete-b', { summary: { last_score: null } })).status).toBe(403);
    expect((await request('POST', '/sessions/s1/complete', 'athlete-a', { summary: { session_id: 'another', last_score: null } })).status).toBe(400);
    expect((await request('POST', '/sessions/s1/complete', 'athlete-a', { summary: { movement_id: 'foreign', last_score: null } })).status).toBe(400);
    expect((await request('POST', '/sessions/s1/complete', 'athlete-a', { summary: { last_score: null, frames_processed: -1 } })).status).toBe(400);
    expect(db.reward).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
  it('persists and reloads the bounded technique review without awarding completion again', async () => {
    const snapshot = { version: 1, session_id: 's1', movement_id: 'squash.ready_stance', assessments_observed: 2, nonempty_assessments: 0, criteria: [], phases: [] };
    const payload = { summary: { last_score: null }, duration_s: 60, review: { session_technique_review: snapshot } };
    expect((await request('POST', '/sessions/s1/complete', 'athlete-a', payload)).status).toBe(200);
    expect((await request('GET', '/sessions/s1')).body.data.session_technique_review).toEqual(snapshot);
    await request('POST', '/sessions/s1/complete', 'athlete-a', payload);
    expect(db.reward).toHaveBeenCalledTimes(1);
    expect((await request('GET', '/sessions')).body.data[0].session_technique_review).toEqual(snapshot);
  });
  it('checks the review movement against the owned session when summary omits it', async () => {
    const snapshot = { version: 1, session_id: 's1', movement_id: 'foreign', assessments_observed: 0, nonempty_assessments: 0, criteria: [], phases: [] };
    expect((await request('POST', '/sessions/s1/complete', 'athlete-a', { summary: {}, review: { session_technique_review: snapshot } })).status).toBe(400);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe('session review serialization', () => {
  it('strips arbitrary summary/review fields and refuses invalid assessment data', () => {
    const cleaned = completionPayload({ summary: { last_score: null, raw_media: 'data:secret' }, review: { arbitrary: true } }, 's1');
    expect(cleaned.summary).not.toHaveProperty('raw_media');
    expect(cleaned.review).not.toHaveProperty('arbitrary');
    expect(() => completionPayload({ summary: {}, review: { last_assessment: { session_id: 's1' } } }, 's1')).toThrow(/assessment/);
    expect(() => completionPayload({ summary: {}, duration_s: 1e9 }, 's1')).toThrow(/duration/);
    expect(presentBrainSession({ ...row(), summary: { last_score: null }, status: 'COMPLETED', ended_at: new Date('2026-10-26T09:02:00Z') })).toMatchObject({ duration_s: 120, summary: { last_score: null } });
  });
});
