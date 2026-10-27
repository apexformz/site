import { validators } from '@apexformz/contracts';
import { parseTechniqueReview } from './techniqueReview';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const score = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const COUNTS = ['frames_processed', 'frames_discarded', 'executions_completed', 'executions_aborted', 'assessments', 'feedback_issued', 'outbox_pending', 'transitions'];

/** Accept only the runtime summary and the small, pose-free presentation snapshot. */
export function completionPayload(body: unknown, id: string): { summary: JsonObject; review: JsonObject; duration_s?: number } {
  if (!object(body) || !object(body.summary)) throw new Error('A session summary is required');
  const source = body.summary;
  if (source.session_id !== undefined && source.session_id !== id) throw new Error('Summary session does not match');
  if (source.last_score !== undefined && !score(source.last_score)) throw new Error('Invalid last score');
  const summary: JsonObject = { last_score: source.last_score ?? null };
  for (const key of ['session_id', 'sport_pack_id', 'sport_pack_version', 'movement_id']) {
    if (source[key] !== undefined) {
      if (typeof source[key] !== 'string' || (source[key] as string).length > 200) throw new Error(`Invalid ${key}`);
      summary[key] = source[key];
    }
  }
  for (const key of COUNTS) {
    if (source[key] !== undefined && !count(source[key])) throw new Error(`Invalid ${key}`);
    summary[key] = source[key] ?? 0;
  }
  for (const key of ['criterion_state_counts', 'abstention_reasons']) {
    const values = source[key] ?? {};
    if (!object(values) || Object.keys(values).length > 200 || !Object.entries(values).every(([k, v]) => k.length <= 100 && count(v))) throw new Error(`Invalid ${key}`);
    summary[key] = values;
  }
  if (body.duration_s !== undefined && (!count(body.duration_s) || (body.duration_s as number) > 86400)) throw new Error('Invalid session duration');
  const input = body.review ?? {};
  if (!object(input)) throw new Error('Invalid review');
  const review: JsonObject = { mode: input.mode === 'development' ? 'development' : 'strict' };
  if (input.mode !== undefined && input.mode !== 'strict' && input.mode !== 'development') throw new Error('Invalid coaching mode');
  for (const key of ['movement_name', 'pose_backend']) {
    if (input[key] !== undefined && input[key] !== null && (typeof input[key] !== 'string' || (input[key] as string).length > 300)) throw new Error(`Invalid ${key}`);
    review[key] = input[key] ?? null;
  }
  if (input.last_assessment != null) {
    if (!validators.assessmentSet(input.last_assessment) || input.last_assessment.session_id !== id) throw new Error('Invalid last assessment');
    review.last_assessment = input.last_assessment;
  }
  if (input.session_technique_review != null) {
    review.session_technique_review = parseTechniqueReview(input.session_technique_review, id, typeof source.movement_id === 'string' ? source.movement_id : undefined);
  }
  if (input.repetition != null) {
    const r = input.repetition;
    if (!object(r) || !count(r.rep_count) || !(r.period_ms === null || typeof r.period_ms === 'number' && Number.isFinite(r.period_ms) && r.period_ms > 0)
      || !score(r.periodicity) || r.periodicity === null || !(r.dominant_feature === null || typeof r.dominant_feature === 'string' && r.dominant_feature.length <= 200)) throw new Error('Invalid repetition snapshot');
    review.repetition = { rep_count: r.rep_count, period_ms: r.period_ms, periodicity: r.periodicity, dominant_feature: r.dominant_feature };
  }
  return { summary, review, ...(body.duration_s !== undefined ? { duration_s: body.duration_s as number } : {}) };
}

export interface SessionRow {
  id: string; athlete_id: string; sport_id: string; movement_id: string; pack_version: string;
  status: string; started_at: Date; ended_at: Date | null; summary: unknown;
}

export function presentBrainSession(row: SessionRow) {
  const saved = object(row.summary) ? row.summary : null;
  const review = saved && object(saved._review) ? saved._review : {};
  const summary = saved ? Object.fromEntries(Object.entries(saved).filter(([k]) => !['_review', 'duration_s', 'xp_earned'].includes(k))) : null;
  return {
    session_id: row.id, athlete_id: row.athlete_id, sport: row.sport_id, movement_id: row.movement_id,
    movement_name: review.movement_name ?? null, mode: review.mode === 'development' ? 'development' : 'strict',
    backend_backed: true, started_at: row.started_at.toISOString(), ended_at: row.ended_at?.toISOString() ?? null,
    summary, last_assessment: review.last_assessment ?? null, session_technique_review: review.session_technique_review ?? null, pack: { id: row.sport_id, version: row.pack_version },
    repetition: review.repetition ?? null, pose_backend: review.pose_backend ?? null,
    duration_s: saved?.duration_s ?? (row.ended_at ? Math.max(0, Math.round((row.ended_at.getTime() - row.started_at.getTime()) / 1000)) : 0),
    xp_earned: saved?.xp_earned ?? 0, completion_sync: row.status === 'COMPLETED' && !(Number(saved?.outbox_pending) > 0) ? 'synced' : 'pending',
  };
}
