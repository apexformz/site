import type { AssessmentSet, SessionStartRequest, SessionTechniqueReview } from '@apexformz/contracts';
import type { SessionSummary } from '@apexformz/runtime';
import { IndexedDbOutboxStore, unwrapIngestResponse, type SyncTransport } from '@apexformz/brain-client';
import { api } from '../api';
import { getAccessToken } from '../auth';

export interface StoredBrainSession {
  session_id: string;
  sport: string;
  movement_id: string;
  /** Display name of the movement from the sport pack (ids such as squash.dynamic.0031 are not readable). */
  movement_name?: string | null;
  mode: 'strict' | 'development';
  backend_backed: boolean;
  started_at: string;
  ended_at: string | null;
  summary: SessionSummary | null;
  last_assessment: AssessmentSet | null;
  session_technique_review?: SessionTechniqueReview | null;
  pack: { id: string; version: string } | null;
  /** Class-agnostic repetition estimate from the last tick (RepNet-style). */
  repetition?: { rep_count: number; period_ms: number | null; periodicity: number; dominant_feature: string | null } | null;
  pose_backend?: string | null;
  duration_s?: number;
  xp_earned?: number;
  completion_sync?: 'pending' | 'synced' | 'local';
  athlete_id?: string | null;
  /** Retained only for an authenticated offline start so it can be retried exactly once. */
  start_request?: SessionStartRequest;
  /** This browser owns the durable event outbox; another browser cannot clear its pending count. */
  outbox_local?: boolean;
}

export const BRAIN_SESSION_KEY = (id: string) => `brain_session_${id}`;

/** This claim scopes the browser cache only; API authentication still verifies the JWT. */
export function currentBrainAthleteId(): string | null {
  try {
    const part = getAccessToken()?.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.userId === 'string' ? payload.userId : null;
  } catch { return null; }
}

const belongsToCurrentAthlete = (session: StoredBrainSession) => {
  const athlete = currentBrainAthleteId();
  return athlete ? session.athlete_id === athlete : !session.athlete_id && !session.backend_backed;
};

export function saveBrainSession(s: StoredBrainSession): void {
  try {
    localStorage.setItem(BRAIN_SESSION_KEY(s.session_id), JSON.stringify(s));
  } catch {
    // ignore storage failures
  }
}

export function loadBrainSession(id: string): StoredBrainSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(BRAIN_SESSION_KEY(id));
    const saved = raw ? JSON.parse(raw) as StoredBrainSession : null;
    return saved?.session_id === id && belongsToCurrentAthlete(saved) ? saved : null;
  } catch {
    return null;
  }
}

function localId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `local-${crypto.randomUUID()}`;
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create the session on the backend when logged in and reachable; otherwise
 * fall back to a local-only session (the on-device loop never depends on the API).
 */
export async function createSession(request: Omit<SessionStartRequest, 'session_id'>): Promise<{ session_id: string; backend_backed: boolean; athlete_id: string | null }> {
  const token = getAccessToken();
  const athlete_id = currentBrainAthleteId();
  const candidate = localId();
  if (!token) return { session_id: candidate, backend_backed: false, athlete_id };
  try {
    const { data } = await api.post('/v1/sessions', { ...request, session_id: candidate }, { timeout: 4000 });
    if (data?.success) return { session_id: data.data?.id ?? data.data?.session_id ?? candidate, backend_backed: true, athlete_id: data.data?.athlete_id ?? athlete_id };
  } catch {
    // offline or backend down: continue locally
  }
  return { session_id: candidate, backend_backed: false, athlete_id };
}

/** POST /api/v1/sessions/:id/complete expects `{ summary, duration_s }` (apps/backend/src/v1/router.ts). */
export async function completeSession(sessionId: string, summary: SessionSummary, durationS?: number): Promise<boolean> {
  try {
    const body = { summary, ...(typeof durationS === 'number' && durationS >= 0 ? { duration_s: Math.round(durationS) } : {}) };
    const { data } = await api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/complete`, body, { timeout: 6000 });
    return Boolean(data?.success);
  } catch {
    return false;
  }
}

/** Uses the same Axios token refresh as auth, results, and the rest of the application. */
export function authenticatedBrainSyncTransport(): SyncTransport {
  return {
    async postEvents(sessionId, events) {
      // Recovery can contain older users' or guest events; never send them under a new account.
      const stored = loadBrainSession(sessionId);
      if (!stored?.athlete_id || stored.athlete_id !== currentBrainAthleteId() || !stored.backend_backed) throw new Error('Session is not available for this account');
      const { data } = await api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, events, { timeout: 10000 });
      return unwrapIngestResponse(data);
    },
  };
}

function preferSession(local: StoredBrainSession | null, remote: StoredBrainSession): StoredBrainSession {
  // A failed completion remains retryable even when the server still has an ACTIVE row.
  if (local?.completion_sync === 'pending' && local.ended_at && !remote.ended_at) return local;
  return { ...local, ...remote,
    ...(remote.session_technique_review == null && local?.session_technique_review ? { session_technique_review: local.session_technique_review } : {}),
    ...(local?.completion_sync === 'pending' && (local.summary?.outbox_pending ?? 0) > 0 ? { completion_sync: 'pending' as const, summary: { ...remote.summary!, outbox_pending: local.summary!.outbox_pending } } : {}) };
}

export async function getBrainSession(id: string): Promise<StoredBrainSession | null> {
  const local = loadBrainSession(id);
  if (!getAccessToken()) return local;
  try {
    const { data } = await api.get(`/v1/sessions/${encodeURIComponent(id)}`, { timeout: 6000 });
    if (!data?.success || !data.data || !belongsToCurrentAthlete(data.data)) return local;
    const session = preferSession(local, data.data);
    saveBrainSession(session);
    return session;
  } catch { return local; }
}

export async function listBrainSessions(): Promise<StoredBrainSession[]> {
  const sessions = new Map<string, StoredBrainSession>();
  if (typeof window !== 'undefined') {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith('brain_session_')) continue;
        const session = loadBrainSession(key.slice('brain_session_'.length));
        if (session) sessions.set(session.session_id, session);
      }
    } catch { /* Browser storage can be unavailable. */ }
  }
  if (getAccessToken()) {
    try {
      const { data } = await api.get('/v1/sessions', { timeout: 6000 });
      if (data?.success && Array.isArray(data.data)) {
        for (const remote of data.data as StoredBrainSession[]) {
          if (!belongsToCurrentAthlete(remote)) continue;
          const session = preferSession(sessions.get(remote.session_id) ?? null, remote);
          sessions.set(session.session_id, session);
          saveBrainSession(session);
        }
      }
    } catch { /* Offline history remains available for this account. */ }
  }
  return [...sessions.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

const pendingRetries = new Map<string, Promise<StoredBrainSession>>();
export function retryBrainSessionSync(session: StoredBrainSession): Promise<StoredBrainSession> {
  const existing = pendingRetries.get(session.session_id);
  if (existing) return existing;
  const pending = syncCompletedSession(session).finally(() => pendingRetries.delete(session.session_id));
  pendingRetries.set(session.session_id, pending);
  return pending;
}

async function syncCompletedSession(session: StoredBrainSession): Promise<StoredBrainSession> {
  let updated = { ...session };
  if (!session.athlete_id) {
    updated.completion_sync = 'local';
    saveBrainSession(updated);
    return updated;
  }
  if (session.athlete_id !== currentBrainAthleteId() || !session.summary || !session.ended_at) return updated;
  updated.completion_sync = 'pending';
  saveBrainSession(updated);
  try {
    if (!updated.backend_backed) {
      if (!updated.start_request) return updated;
      const { data } = await api.post('/v1/sessions', updated.start_request, { timeout: 6000 });
      if (!data?.success || data.data?.athlete_id !== updated.athlete_id) return updated;
      updated.backend_backed = true;
      saveBrainSession(updated);
    }
    // Recover this session only. Evidence for other accounts and guest sessions stays local.
    if (typeof indexedDB !== 'undefined') {
      const store = new IndexedDbOutboxStore(indexedDB);
      try {
        const events = (await store.all()).filter(e => e.session_id === updated.session_id).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        const transport = authenticatedBrainSyncTransport();
        for (let i = 0; i < events.length; i += 200) {
          const result = await transport.postEvents(updated.session_id, events.slice(i, i + 200));
          if (result.rejected.length) throw new Error('Some session evidence was rejected');
          store.remove([...result.accepted, ...result.duplicates]);
        }
        const remaining = (await store.all()).filter(e => e.session_id === updated.session_id).length;
        if (updated.outbox_local || events.length > 0 || updated.summary!.outbox_pending === 0) {
          updated.summary = { ...updated.summary!, outbox_pending: remaining };
        }
      } finally { store.close(); }
    }
    const { data } = await api.post(`/v1/sessions/${encodeURIComponent(updated.session_id)}/complete`, {
      summary: updated.summary,
      duration_s: updated.duration_s,
      review: { mode: updated.mode, movement_name: updated.movement_name, last_assessment: updated.last_assessment, session_technique_review: updated.session_technique_review, repetition: updated.repetition, pose_backend: updated.pose_backend },
    }, { timeout: 15000 });
    if (data?.success) {
      updated.xp_earned = data.data?.review?.xp_earned ?? data.data?.gamification?.xpEarned ?? updated.xp_earned ?? 0;
      updated.completion_sync = (updated.summary?.outbox_pending ?? 0) === 0 ? 'synced' : 'pending';
    }
  } catch { /* Persist the pending marker; the results page can retry safely. */ }
  saveBrainSession(updated);
  return updated;
}
