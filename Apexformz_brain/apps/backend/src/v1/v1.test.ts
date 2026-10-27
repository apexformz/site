import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, type EventEnvelope } from '@apexformz/contracts';
import { InMemorySessionEventRepository, deriveRows, ingestBatch } from './ingestion';
import { isNotModified, isServableAsset, listedAssets, strongEtag } from './packs';
import { InMemoryJobStore, JobDispatcher, TransientError, type JobHttpClient, type JobRecord } from './jobs';
import { aggregateProgress } from './progress';

function envelope(sessionId: string, seq: number, type: EventEnvelope['event_type'] = 'telemetry.sample', payload: Record<string, unknown> = {}): EventEnvelope {
  return {
    schema_version: CONTRACT_VERSION, session_id: sessionId, event_id: `${sessionId}:${String(seq).padStart(8, '0')}`, monotonic_ms: seq * 40,
    sport_pack_id: 'badminton', sport_pack_version: '1.0.0', producer: 'test', event_type: type, payload, sequence: seq,
  };
}

describe('event ingestion (G09 exactly-once)', () => {
  it('accepts a batch once and reports retries as duplicates', async () => {
    const repo = new InMemorySessionEventRepository();
    const batch = [envelope('s1', 1), envelope('s1', 2), envelope('s1', 3)];
    const first = await ingestBatch(repo, 's1', batch);
    expect(first.accepted).toHaveLength(3);
    const retry = await ingestBatch(repo, 's1', [...batch, envelope('s1', 4)]);
    expect(retry.duplicates).toEqual(batch.map((e) => e.event_id));
    expect(retry.accepted).toEqual(['s1:00000004']);
    expect(repo.rows.get('s1')).toHaveLength(4);
  });

  it('rejects foreign-session and schema-invalid envelopes without touching the store', async () => {
    const repo = new InMemorySessionEventRepository();
    const out = await ingestBatch(repo, 's1', [envelope('s2', 1), { nope: true }, envelope('s1', 1), envelope('s1', 1)]);
    expect(out.rejected.map((r) => r.reason.split(':')[0])).toEqual(['SESSION_MISMATCH', 'SCHEMA_INVALID']);
    expect(out.accepted).toEqual(['s1:00000001']);
    expect(out.duplicates).toEqual(['s1:00000001']); // duplicated inside the same batch
    expect(repo.rows.get('s2')).toBeUndefined();
  });

  it('rejects non-array and oversized batches', async () => {
    const repo = new InMemorySessionEventRepository();
    expect((await ingestBatch(repo, 's1', { a: 1 })).rejected[0].reason).toBe('BATCH_NOT_ARRAY');
    const big = Array.from({ length: 501 }, (_, i) => envelope('s1', i));
    expect((await ingestBatch(repo, 's1', big)).rejected[0].reason).toMatch(/BATCH_TOO_LARGE/);
  });

  it('derives execution and assessment rows without raw media', () => {
    const rows = deriveRows([
      envelope('s1', 1, 'movement.event', { state: 'COMPLETE', movement_id: 'badminton.lunge', start_ms: 100, end_ms: 900, model_version: 'h@1' }),
      envelope('s1', 2, 'movement.event', { state: 'EXECUTING', movement_id: 'badminton.lunge', start_ms: 100 }),
      envelope('s1', 3, 'assessment.set', { execution_id: 'e1', rubric_version: '1.0.0', criteria: [{ criterion_id: 'c', state: 'PASS', score: 1, evidence: { frame_ids: [1, 2] }, measurement: { reason: null } }] }),
    ]);
    expect(rows.executions).toHaveLength(1);
    expect(rows.executions[0].end_ms).toBe(900);
    expect(rows.assessments[0]).toMatchObject({ criterion_id: 'c', status: 'PASS', score: 1, rubric_version: '1.0.0' });
    expect(JSON.stringify(rows.assessments[0].evidence_ref)).not.toContain('landmarks');
  });
});

describe('sport pack distribution', () => {
  it('computes strong etags and honours If-None-Match', () => {
    const etag = strongEtag('{"id":"badminton"}');
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(isNotModified(etag, etag)).toBe(true);
    expect(isNotModified(`"other", ${etag}`, etag)).toBe(true);
    expect(isNotModified(`W/${etag}`, etag)).toBe(true);
    expect(isNotModified('*', etag)).toBe(true);
    expect(isNotModified(undefined, etag)).toBe(false);
    expect(isNotModified('"nope"', etag)).toBe(false);
  });

  it('only serves assets the manifest lists and blocks traversal', () => {
    const manifest = { game_rules: 'competition_rules.json', court_geometry: 'court_geometry.json', models: [{ path: 'models/ref.json' }], asset_hashes: { 'provenance.json': 'x' } };
    expect([...listedAssets(manifest)].sort()).toEqual(['competition_rules.json', 'court_geometry.json', 'models/ref.json', 'provenance.json']);
    expect(isServableAsset(manifest, 'court_geometry.json')).toBe(true);
    expect(isServableAsset(manifest, 'models/ref.json')).toBe(true);
    expect(isServableAsset(manifest, '../shooting/manifest.json')).toBe(false);
    expect(isServableAsset(manifest, 'manifest.json')).toBe(false);
    expect(isServableAsset(manifest, '/etc/passwd')).toBe(false);
  });
});

describe('analysis job dispatcher', () => {
  const job = (id: string): JobRecord => ({ id, owner_id: 'u', asset_ref: 'a', consent_scope: 'deep_analysis', status: 'QUEUED', output_ref: null, error: null, attempts: 0, request: null, updated_at: 0 });
  let now = 0;
  const clock = () => now;
  const sleep = async () => undefined;

  it('moves QUEUED -> RUNNING -> COMPLETED', async () => {
    const store = new InMemoryJobStore();
    store.add(job('j1'));
    let polls = 0;
    const http: JobHttpClient = { submit: async () => ({ remote_id: 'r1' }), poll: async () => (++polls < 3 ? { status: 'RUNNING' } : { status: 'COMPLETED', output_ref: 's3://out' }) };
    const d = new JobDispatcher(store, http, clock, sleep);
    expect(await d.step()).toBe('COMPLETED');
    expect(store.jobs.get('j1')).toMatchObject({ status: 'COMPLETED', output_ref: 's3://out', attempts: 1 });
    expect(await d.step()).toBeNull();
  });

  it('marks transient failures RETRYABLE with backoff and FAILED after max attempts', async () => {
    const store = new InMemoryJobStore();
    store.add(job('j2'));
    const http: JobHttpClient = { submit: async () => { throw new TransientError('econnrefused'); }, poll: async () => ({ status: 'RUNNING' }) };
    const d = new JobDispatcher(store, http, clock, sleep, { maxAttempts: 3, baseBackoffMs: 1000, pollIntervalMs: 1, maxPolls: 2 });
    now = 0;
    expect(await d.step()).toBe('RETRYABLE');
    expect(store.jobs.get('j2')!.next_attempt_at).toBe(1000);
    now = 500;
    expect(await d.step()).toBeNull(); // backoff not elapsed
    now = 1000;
    expect(await d.step()).toBe('RETRYABLE');
    expect(store.jobs.get('j2')!.next_attempt_at).toBe(1000 + 2000);
    now = 5000;
    expect(await d.step()).toBe('FAILED');
    expect(store.jobs.get('j2')).toMatchObject({ status: 'FAILED', attempts: 3 });
  });

  it('remote FAILED is terminal (not retried)', async () => {
    const store = new InMemoryJobStore();
    store.add(job('j3'));
    const http: JobHttpClient = { submit: async () => ({ remote_id: 'r' }), poll: async () => ({ status: 'FAILED', error: 'bad asset' }) };
    const d = new JobDispatcher(store, http, clock, sleep);
    expect(await d.step()).toBe('FAILED');
    expect(store.jobs.get('j3')!.error).toBe('bad asset');
  });
});

describe('progress aggregation', () => {
  it('never averages across rubric versions', () => {
    const t = new Date('2026-10-25T00:00:00Z');
    const sessions = [
      { id: 's1', movement_id: 'badminton.lunge', sport_id: 'badminton', pack_version: '1.0.0', started_at: t, ended_at: t, status: 'COMPLETED' },
      { id: 's2', movement_id: 'badminton.lunge', sport_id: 'badminton', pack_version: '1.1.0', started_at: t, ended_at: null, status: 'ACTIVE' },
    ];
    const assessments = [
      { session_id: 's1', movement_id: '', criterion_id: 'a', status: 'PASS', score: 1, rubric_version: '1.0.0', created_at: t },
      { session_id: 's1', movement_id: '', criterion_id: 'b', status: 'NOT_ASSESSABLE', score: null, rubric_version: '1.0.0', created_at: t },
      { session_id: 's2', movement_id: '', criterion_id: 'a', status: 'IMPROVE', score: 0.2, rubric_version: '1.1.0', created_at: t },
    ];
    const p = aggregateProgress(sessions, assessments);
    expect(p).toHaveLength(1);
    expect(p[0].sessions).toBe(2);
    expect(p[0].criterion_state_counts).toEqual({ PASS: 1, NOT_ASSESSABLE: 1, IMPROVE: 1 });
    expect(p[0].by_rubric_version['1.0.0'].mean_score).toBe(1);
    expect(p[0].by_rubric_version['1.1.0'].mean_score).toBe(0.2);
  });
});
