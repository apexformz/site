import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@apexformz/runtime';
import type { SessionTechniqueReview } from '@apexformz/contracts';
import { authenticatedBrainSyncTransport, getBrainSession, listBrainSessions, loadBrainSession, retryBrainSessionSync, saveBrainSession, type StoredBrainSession } from './session';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), token: '' }));
vi.mock('../api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../auth', () => ({ getAccessToken: () => mocks.token || null }));
vi.mock('@apexformz/brain-client', () => ({ unwrapIngestResponse: (v: any) => v.data, IndexedDbOutboxStore: class {} }));

const summary: SessionSummary = { session_id: 's1', sport_pack_id: 'squash', sport_pack_version: '1.0.0', movement_id: 'squash.ready_stance', last_score: null, frames_processed: 20, frames_discarded: 0, executions_completed: 1, executions_aborted: 0, assessments: 1, feedback_issued: 0, criterion_state_counts: { UNCERTAIN: 1 }, abstention_reasons: {}, outbox_pending: 0, transitions: 2 };
const session = (extra: Partial<StoredBrainSession> = {}): StoredBrainSession => ({ session_id: 's1', athlete_id: 'athlete-a', sport: 'squash', movement_id: summary.movement_id, movement_name: 'Ready stance', mode: 'strict', backend_backed: true, started_at: '2026-10-26T09:00:00.000Z', ended_at: '2026-10-26T09:01:00.000Z', summary, last_assessment: null, pack: { id: 'squash', version: '1.0.0' }, duration_s: 60, completion_sync: 'pending', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  const values = new Map<string, string>();
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null });
  mocks.token = `x.${btoa(JSON.stringify({ userId: 'athlete-a' }))}.x`;
  mocks.get.mockRejectedValue(new Error('offline'));
  mocks.post.mockRejectedValue(new Error('offline'));
});
afterEach(() => vi.unstubAllGlobals());

describe('Brain session persistence across account and network boundaries', () => {
  it('keeps pending local completion when the server only has the active row', async () => {
    saveBrainSession(session());
    mocks.get.mockResolvedValue({ data: { success: true, data: session({ ended_at: null, summary: null }) } });
    expect((await getBrainSession('s1'))?.summary?.last_score).toBeNull();
    expect((await getBrainSession('s1'))?.ended_at).toBeTruthy();
  });

  it('loads a complete remote review on another browser and returns null for legacy ids', async () => {
    mocks.get.mockResolvedValueOnce({ data: { success: true, data: session({ completion_sync: 'synced', xp_earned: 10 }) } });
    expect(await getBrainSession('s1')).toMatchObject({ movement_name: 'Ready stance', xp_earned: 10, summary: { last_score: null } });
    expect(await getBrainSession('legacy-id')).toBeNull();
  });

  it('never exposes another account or guest history in an authenticated account', async () => {
    saveBrainSession(session());
    saveBrainSession(session({ session_id: 'other', athlete_id: 'athlete-b' }));
    saveBrainSession(session({ session_id: 'guest', athlete_id: null, backend_backed: false }));
    expect((await listBrainSessions()).map(s => s.session_id)).toEqual(['s1']);
    expect(loadBrainSession('other')).toBeNull();
    mocks.token = '';
    expect((await listBrainSessions()).map(s => s.session_id)).toEqual(['guest']);
    expect(loadBrainSession('s1')).toBeNull();
  });

  it('retains the completion retry marker after failure and sends the review on retry', async () => {
    const pending = await retryBrainSessionSync(session());
    expect(pending.completion_sync).toBe('pending');
    mocks.post.mockResolvedValueOnce({ data: { success: true, data: { review: { xp_earned: 10 } } } });
    const completed = await retryBrainSessionSync(pending);
    expect(completed).toMatchObject({ completion_sync: 'synced', xp_earned: 10 });
    expect(mocks.post).toHaveBeenLastCalledWith('/v1/sessions/s1/complete', expect.objectContaining({ duration_s: 60, review: expect.objectContaining({ mode: 'strict', movement_name: 'Ready stance' }) }), expect.anything());
  });
  it('preserves session technique evidence on retries, reload, and older-server responses', async () => {
    const snapshot: SessionTechniqueReview = { version: 1, session_id: 's1', movement_id: summary.movement_id, assessments_observed: 2, nonempty_assessments: 0, criteria: [], phases: [] };
    const pending = await retryBrainSessionSync(session({ session_technique_review: snapshot }));
    expect(loadBrainSession('s1')?.session_technique_review).toEqual(snapshot);
    mocks.post.mockResolvedValueOnce({ data: { success: true, data: { review: { xp_earned: 10 } } } });
    await retryBrainSessionSync(pending);
    expect(mocks.post).toHaveBeenLastCalledWith('/v1/sessions/s1/complete', expect.objectContaining({ review: expect.objectContaining({ session_technique_review: snapshot }) }), expect.anything());
    mocks.get.mockResolvedValueOnce({ data: { success: true, data: session({ completion_sync: 'synced', session_technique_review: null }) } });
    expect((await getBrainSession('s1'))?.session_technique_review).toEqual(snapshot);
  });

  it('does not send another user or guest session events using the current JWT', async () => {
    saveBrainSession(session({ athlete_id: 'athlete-b' }));
    await expect(authenticatedBrainSyncTransport().postEvents('s1', [])).rejects.toThrow(/account/);
    expect(mocks.post).not.toHaveBeenCalled();
    saveBrainSession(session());
    mocks.post.mockResolvedValue({ data: { success: true, data: { accepted: ['e1'], duplicates: [], rejected: [] } } });
    expect(await authenticatedBrainSyncTransport().postEvents('s1', [])).toMatchObject({ accepted: ['e1'] });
  });

  it('registers authenticated offline starts before completing and never promotes a guest', async () => {
    const start_request = { session_id: 's1', sport_pack_id: 'squash', sport_pack_version: '1.0.0', movement_id: summary.movement_id, calibration: {} } as any;
    mocks.post.mockResolvedValueOnce({ data: { success: true, data: { athlete_id: 'athlete-a' } } }).mockResolvedValueOnce({ data: { success: true, data: { review: { xp_earned: 10 } } } });
    expect(await retryBrainSessionSync(session({ backend_backed: false, start_request }))).toMatchObject({ backend_backed: true, completion_sync: 'synced' });
    expect(mocks.post.mock.calls[0][0]).toBe('/v1/sessions');
    mocks.post.mockClear();
    expect(await retryBrainSessionSync(session({ backend_backed: false, athlete_id: null }))).toMatchObject({ completion_sync: 'local' });
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
