import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../src/utils/prisma';
import router from '../src/v1/router';
import { signToken } from '../src/utils/auth.utils';
import { PrismaSessionEventRepository } from '../src/v1/prismaEventRepository';
import { AiServiceJobClient, PrismaJobStore } from '../src/v1/prismaJobs';
import { JobDispatcher, TransientError } from '../src/v1/jobs';
import { ingestBatch } from '../src/v1/ingestion';
import type { EventEnvelope } from '@apexformz/contracts';
import { syntheticPoseFrame } from '@apexformz/signal';

const schema = process.env.APEXFORMZ_INTEGRATION_SCHEMA;
if (!schema || !/^apexformz_it_[a-f0-9]{32}$/.test(schema) || new URL(process.env.DATABASE_URL!).searchParams.get('schema') !== schema) {
  throw new Error('Run through tools/test_backend_postgres.mjs; an isolated generated schema is mandatory');
}
let server: Server;
let base: string;
let owner: string;
let outsider: string;
let ownerToken: string;
let outsiderToken: string;
let aiProcess: ChildProcess | null = null;
let aiPort = 0;
async function startAi() {
  if (!aiPort) {
    const temporary = createServer();
    await new Promise<void>(resolve => temporary.listen(0, '127.0.0.1', resolve));
    aiPort = (temporary.address() as { port: number }).port;
    await new Promise<void>(resolve => temporary.close(() => resolve()));
  }
  const localPython = path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.APEXFORMZ_PYTHON || (existsSync(localPython) ? localPython : 'python');
  aiProcess = spawn(python, ['apps/backend/tests/serve_analysis_fixture.py', '--port', String(aiPort)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  aiProcess.stderr?.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4000); });
  aiProcess.on('error', error => { errors += error.message; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${aiPort}/health`)).ok) return; } catch { /* starting */ }
    if (aiProcess.exitCode !== null) throw new Error(`AI integration host failed: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`AI integration host did not start: ${errors}`);
}
async function stopAi() {
  const child = aiProcess;
  aiProcess = null;
  if (child && child.exitCode === null) await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); });
}
const request = (id: string) => ({ session_id: id, sport_pack_id: 'squash', sport_pack_version: '1.0.0', movement_id: 'squash.dynamic.0001',
  calibration: { full_body_framing: true, camera_tilt_deg: 0, nominal_view: 'front', handedness: 'right', scale_known: false } });
const envelope = (session: string, id: string, event_type: EventEnvelope['event_type'] = 'telemetry.sample', payload = {}): EventEnvelope => ({
  schema_version: '1.0.0', session_id: session, event_id: id, monotonic_ms: 100, sport_pack_id: 'squash', sport_pack_version: '1.0.0',
  producer: 'postgres-integration', event_type, payload, sequence: 1,
});
async function http(method: string, route: string, body?: unknown, token = ownerToken) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function session() {
  const id = randomUUID();
  expect((await http('POST', '/sessions', request(id))).status).toBe(201);
  return id;
}
async function job() {
  return prisma.analysisJob.create({ data: { owner_id: owner, asset_ref: 'fixture://features', consent_scope: 'deep_analysis' } });
}

beforeAll(async () => {
  await prisma.$connect();
  const users = await Promise.all(['owner', 'other'].map(name => prisma.user.create({ data: {
    name, email: `${name}-${randomUUID()}@example.test`, password_hash: 'not-used-by-integration',
    stats: { create: {} }, leaderboard: { create: { sport: 'squash' } },
  } })));
  [owner, outsider] = users.map(u => u.id);
  [ownerToken, outsiderToken] = users.map(u => signToken({ userId: u.id, email: u.email }, process.env.JWT_SECRET!, { expiresIn: '5m' }));
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1', router);
  server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
});
afterAll(async () => {
  await stopAi();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await prisma.$disconnect();
});

describe('PostgreSQL migrations, authenticated persistence and isolation', () => {
  it('applies the real migration chain and its composite event key', async () => {
    const applied = await prisma.$queryRaw<Array<{ migration_name: string }>>`SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL ORDER BY "migration_name"`;
    expect(applied.map(x => x.migration_name)).toEqual(['0001_brain_init', '0002_event_scope_job_leases', '0003_durable_analysis_output', '0004_private_s3_assets']);
    const key = await prisma.$queryRaw<Array<{ definition: string }>>`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = '"SessionEvent"'::regclass AND contype = 'p'`;
    expect(key[0].definition).toBe('PRIMARY KEY (session_id, id)');
  });

  it('requires real JWT authentication and preserves session ownership during concurrent creation', async () => {
    const id = randomUUID();
    expect((await http('POST', '/sessions', request(id), '')).status).toBe(401);
    expect((await http('POST', '/sessions', request(id), ownerToken + 'corrupt')).status).toBe(401);
    const created = await Promise.all(Array.from({ length: 6 }, () => http('POST', '/sessions', request(id))));
    expect(created.every(r => [200, 201].includes(r.status))).toBe(true);
    expect(await prisma.brainSession.count({ where: { id } })).toBe(1);
    expect((await http('POST', '/sessions', request(id), outsiderToken)).status).toBe(403);
    expect((await http('POST', `/sessions/${id}/events`, [envelope(id, 'forbidden')], outsiderToken)).status).toBe(403);
    expect((await http('POST', `/sessions/${id}/complete`, { summary: {} }, outsiderToken)).status).toBe(403);
    expect((await http('GET', `/athletes/${owner}/progress`, undefined, outsiderToken)).status).toBe(403);
    expect(await prisma.sessionEvent.count({ where: { session_id: id } })).toBe(0);
  });

  it('commits concurrent duplicate envelopes and their derived rows exactly once', async () => {
    const id = await session();
    const batch = [envelope(id, 'movement', 'movement.event', { state: 'COMPLETE', movement_id: 'squash.dynamic.0001', start_ms: 10, end_ms: 100 }),
      envelope(id, 'assessment', 'assessment.set', { execution_id: 'e1', rubric_version: '1', criteria: [
        { criterion_id: 'stance', state: 'NOT_ASSESSABLE', score: null, measurement: { reason: 'NO_APPROVED_RUBRIC' } },
      ] })];
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => http('POST', `/sessions/${id}/events`, batch)));
    expect(outcomes.every(r => r.status === 200)).toBe(true);
    expect(outcomes.flatMap(r => r.body.data.accepted).sort()).toEqual(['assessment', 'movement']);
    expect(outcomes.flatMap(r => r.body.data.duplicates)).toHaveLength(14);
    expect(await prisma.sessionEvent.count({ where: { session_id: id } })).toBe(2);
    expect(await prisma.movementExecution.count({ where: { session_id: id } })).toBe(1);
    expect(await prisma.criterionAssessment.count({ where: { session_id: id } })).toBe(1);
    // Reopen a new database connection, proving this was durable persistence.
    const reopened = new PrismaClient();
    try { expect(await reopened.sessionEvent.count({ where: { session_id: id } })).toBe(2); }
    finally { await reopened.$disconnect(); }
    const another = await session();
    expect((await http('POST', `/sessions/${another}/events`, [envelope(another, 'movement')])).body.data.accepted).toEqual(['movement']);
  });

  it('rolls back envelopes if a derived insert fails', async () => {
    const id = await session();
    // Inject a database rejection in this isolated schema after the envelope insert.
    await prisma.$executeRawUnsafe('ALTER TABLE "MovementExecution" ADD CONSTRAINT "integration_nonnegative_start" CHECK ("start_ms" >= 0)');
    try {
      await expect(ingestBatch(new PrismaSessionEventRepository(), id, [envelope(id, 'atomic', 'movement.event', {
        state: 'COMPLETE', movement_id: 'squash.dynamic.0001', start_ms: -1,
      })])).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "MovementExecution" DROP CONSTRAINT "integration_nonnegative_start"');
    }
    expect(await prisma.sessionEvent.count({ where: { session_id: id } })).toBe(0);
    expect(await prisma.movementExecution.count({ where: { session_id: id } })).toBe(0);
  });

  it('completes and awards XP atomically once, including concurrent requests and different sessions', async () => {
    const ids = await Promise.all([session(), session()]);
    const before = await prisma.userStats.findUniqueOrThrow({ where: { user_id: owner } });
    const results = await Promise.all(ids.flatMap(id => Array.from({ length: 4 }, () => http('POST', `/sessions/${id}/complete`, {
      duration_s: 100, summary: { last_score: null, frames_processed: 30 },
    }))));
    expect(results.every(r => r.status === 200)).toBe(true);
    const stats = await prisma.userStats.findUniqueOrThrow({ where: { user_id: owner } });
    expect(stats.xp - before.xp).toBe(20);
    expect(stats.total_sessions - before.total_sessions).toBe(2);
    expect(await prisma.brainSession.count({ where: { id: { in: ids }, status: 'COMPLETED' } })).toBe(2);
  });

  it('rolls completion back when reward persistence fails and permits a later retry', async () => {
    const id = await session();
    await prisma.userStats.delete({ where: { user_id: owner } });
    expect((await http('POST', `/sessions/${id}/complete`, { duration_s: 100, summary: { last_score: null } })).status).toBe(500);
    expect((await prisma.brainSession.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    await prisma.userStats.create({ data: { user_id: owner } });
    expect((await http('POST', `/sessions/${id}/complete`, { duration_s: 100, summary: { last_score: null } })).status).toBe(200);
    expect((await prisma.userStats.findUniqueOrThrow({ where: { user_id: owner } })).total_sessions).toBe(1);
  });

  it('persists consent-scoped jobs and restricts job status to the owner', async () => {
    const result = await http('POST', '/analysis/jobs', { feature_bundle: [syntheticPoseFrame(0, 0)], consent_scope: 'deep_analysis',
      sport_pack_id: 'squash', sport_pack_version: '1.0.0', movement_id: 'squash.dynamic.0001' });
    expect(result.status).toBe(202);
    const id = result.body.data.job_id;
    expect((await http('GET', `/analysis/jobs/${id}`)).body.data.owner_id).toBe(owner);
    expect((await http('GET', `/analysis/jobs/${id}`, undefined, outsiderToken)).status).toBe(403);
    await prisma.analysisJob.update({ where: { id }, data: { status: 'COMPLETED' } });
  });
});

describe('PostgreSQL durable queue claims and recovery', () => {
  it('rejects arbitrary, expired, foreign and differently-consented asset references', async () => {
    const asset = await prisma.objectAsset.create({ data: { owner_id: owner, storage_key: 'assets/' + randomUUID(), hash: 'a'.repeat(64),
      retention_policy: '7d', encryption_metadata: {}, consent_scope: 'deep_analysis', status: 'READY', version_id: 'test-version', expires_at: new Date(Date.now() + 60000) } });
    const payload = { asset_ref: asset.id, consent_scope: 'deep_analysis', sport_pack_id: 'squash', sport_pack_version: '1.0.0', movement_id: 'squash.dynamic.0001' };
    expect((await http('POST', '/analysis/jobs', { ...payload, asset_ref: 'https://example.invalid/private' })).status).toBe(404);
    expect((await http('POST', '/analysis/jobs', payload, outsiderToken)).status).toBe(404);
    expect((await http('POST', '/analysis/jobs', { ...payload, consent_scope: 'quality_improvement' })).status).toBe(404);
    await prisma.objectAsset.update({ where: { id: asset.id }, data: { expires_at: new Date(0) } });
    expect((await http('POST', '/analysis/jobs', payload)).status).toBe(404);
    await prisma.objectAsset.update({ where: { id: asset.id }, data: { expires_at: new Date(Date.now() + 60000) } });
    const accepted = await http('POST', '/analysis/jobs', payload);
    expect(accepted.status).toBe(202);
    await prisma.analysisJob.update({ where: { id: accepted.body.data.job_id }, data: { status: 'COMPLETED' } });
  });
  it('allows one concurrent claim and fences a dead worker after lease recovery', async () => {
    const row = await job();
    const now = Date.now();
    const stores = Array.from({ length: 6 }, () => new PrismaJobStore());
    const claims = (await Promise.all(stores.map(s => s.claimNext(now, now, 1000)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.id).toBe(row.id);
    expect(await stores[0].claimNext(now + 999, now + 999)).toBeNull();
    const recovered = await new PrismaJobStore().claimNext(now + 1001, now + 1001);
    expect(recovered?.id).toBe(row.id);
    expect(recovered?.lease_token).not.toBe(claims[0]!.lease_token);
    expect(recovered?.attempts).toBe(2);
    expect(await stores[0].update(row.id, { status: 'COMPLETED', output_ref: 'stale' }, claims[0]!.lease_token!)).toBe(false);
    expect(await stores[0].update(row.id, { status: 'COMPLETED', output_ref: 'current' }, recovered!.lease_token!)).toBe(true);
  });

  it('persists retry backoff across store recreation and retries only when due', async () => {
    const row = await job();
    let now = Date.now();
    const fail = { submit: async () => { throw new TransientError('temporary outage'); }, poll: async () => ({ status: 'RUNNING' as const }) };
    const opts = { maxAttempts: 2, baseBackoffMs: 1000, pollIntervalMs: 0, maxPolls: 1 };
    expect(await new JobDispatcher(new PrismaJobStore(), fail, () => now, async () => {}, opts).step()).toBe('RETRYABLE');
    const saved = await prisma.analysisJob.findUniqueOrThrow({ where: { id: row.id } });
    expect(saved.next_attempt_at?.getTime()).toBe(now + 1000);
    now += 999;
    expect(await new JobDispatcher(new PrismaJobStore(), fail, () => now, async () => {}, opts).step()).toBeNull();
    now++;
    expect(await new JobDispatcher(new PrismaJobStore(), fail, () => now, async () => {}, opts).step()).toBe('FAILED');
    expect((await prisma.analysisJob.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(2);
  });

  it('resumes a persisted remote job after restart without submitting it again', async () => {
    const row = await job();
    const now = Date.now();
    const store = new PrismaJobStore();
    const claim = await store.claimNext(now, now, 1);
    await store.update(row.id, { remote_id: 'remote-existing' }, claim!.lease_token!);
    let submissions = 0;
    const client = { submit: async () => { submissions++; return { remote_id: 'wrong' }; },
      poll: async (id: string) => { expect(id).toBe('remote-existing'); return { status: 'COMPLETED' as const, output_ref: 'fixture://completed' }; } };
    expect(await new JobDispatcher(new PrismaJobStore(), client, () => now + 2, async () => {}).step()).toBe('COMPLETED');
    expect(submissions).toBe(0);
    expect(await prisma.analysisJob.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'COMPLETED', output_ref: 'fixture://completed', attempts: 2, lease_token: null });
  });

  it('runs the real FastAPI feature-bundle path, recovers remote state loss, and persists output durably', async () => {
    await startAi();
    const feature_bundle = Array.from({ length: 20 }, (_, i) => syntheticPoseFrame(i, i * 40, {
      right_knee_flexion: i > 5 && i < 15 ? 70 : 0, right_arm_raise: 40, right_elbow_flexion: 20,
    }, { session_id: 'integration-retrospective' }));
    const result = await http('POST', '/analysis/jobs', { feature_bundle, consent_scope: 'deep_analysis', sport_pack_id: 'badminton',
      sport_pack_version: '1.0.0', movement_id: 'badminton.lunge', capabilities: ['body_pose', 'optional_implement'] });
    expect(result.status).toBe(202);
    const id = result.body.data.job_id;
    const store = new PrismaJobStore();
    const client = new AiServiceJobClient(`http://127.0.0.1:${aiPort}`);
    const claim = await store.claimNext(Date.now(), Date.now(), 1);
    expect(claim?.id).toBe(id);
    const submitted = await client.submit(claim!);
    await store.update(id, { remote_id: submitted.remote_id }, claim!.lease_token!);
    // Reboot the actual Python service: its in-memory remote id disappears.
    await stopAi();
    await startAi();
    const opts = { maxAttempts: 5, baseBackoffMs: 0, pollIntervalMs: 25, maxPolls: 200 };
    const dispatcher = new JobDispatcher(new PrismaJobStore(), client, () => Date.now(), ms => new Promise(resolve => setTimeout(resolve, ms)), opts);
    expect(await dispatcher.step()).toBe('RETRYABLE');
    expect((await prisma.analysisJob.findUniqueOrThrow({ where: { id } })).remote_id).toBeNull();
    expect(await dispatcher.step()).toBe('COMPLETED');
    const reopened = new PrismaClient();
    try {
      const persisted = await reopened.analysisJob.findUniqueOrThrow({ where: { id } });
      expect(persisted.output).toMatchObject({ retrospective: true, frames: 20, model_version: 'retrospective_segmenter@1.0.0' });
      expect(persisted.attempts).toBe(3);
      expect((await http('GET', `/analysis/jobs/${id}`)).body.data.output).toEqual(persisted.output);
    } finally { await reopened.$disconnect(); }
  });

  it('stores structured FastAPI terminal errors as readable database errors', async () => {
    const result = await http('POST', '/analysis/jobs', { feature_bundle: [syntheticPoseFrame(0, 0)], consent_scope: 'deep_analysis',
      sport_pack_id: 'badminton', sport_pack_version: '1.0.0', movement_id: 'badminton.unknown' });
    const dispatcher = new JobDispatcher(new PrismaJobStore(), new AiServiceJobClient(`http://127.0.0.1:${aiPort}`),
      () => Date.now(), ms => new Promise(resolve => setTimeout(resolve, ms)), { maxAttempts: 5, baseBackoffMs: 0, pollIntervalMs: 25, maxPolls: 200 });
    expect(await dispatcher.step()).toBe('FAILED');
    expect((await prisma.analysisJob.findUniqueOrThrow({ where: { id: result.body.data.job_id } })).error).toContain('UNKNOWN_SPORT_PACK:');
  });
});
