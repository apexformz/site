/**
 * Idempotent session event ingestion (TRD 13). Pure logic with an injected
 * repository so it is testable without a database. Exactly-once semantics are
 * keyed on (session_id, event_id); the Prisma implementation relies on the
 * unique(session_id, id) index as the final guard against races.
 */
import { validators, type EventEnvelope } from '@apexformz/contracts';

export interface SessionEventRepository {
  existingIds(sessionId: string, ids: string[]): Promise<Set<string>>;
  /** IDs inserted by this transaction; concurrent losers are duplicates. */
  insertMany(events: EventEnvelope[]): Promise<Set<string>>;
}

export interface IngestOutcome {
  accepted: string[];
  duplicates: string[];
  rejected: Array<{ event_id: string; reason: string }>;
}

export const MAX_BATCH = 500;

export class InMemorySessionEventRepository implements SessionEventRepository {
  readonly rows = new Map<string, EventEnvelope[]>();

  async existingIds(sessionId: string, ids: string[]): Promise<Set<string>> {
    const have = new Set((this.rows.get(sessionId) ?? []).map((e) => e.event_id));
    return new Set(ids.filter((id) => have.has(id)));
  }

  async insertMany(events: EventEnvelope[]): Promise<Set<string>> {
    const inserted = new Set<string>();
    for (const e of events) {
      const list = this.rows.get(e.session_id) ?? [];
      if (list.some((x) => x.event_id === e.event_id)) continue; // unique index semantics
      list.push(e);
      this.rows.set(e.session_id, list);
      inserted.add(e.event_id);
    }
    return inserted;
  }
}

/**
 * Validate and ingest a batch for one session. `expectedSessionId` is the path
 * parameter; envelopes for other sessions are rejected, never silently moved.
 */
export async function ingestBatch(repo: SessionEventRepository, expectedSessionId: string, batch: unknown): Promise<IngestOutcome> {
  const out: IngestOutcome = { accepted: [], duplicates: [], rejected: [] };
  if (!Array.isArray(batch)) {
    out.rejected.push({ event_id: '(batch)', reason: 'BATCH_NOT_ARRAY' });
    return out;
  }
  if (batch.length > MAX_BATCH) {
    out.rejected.push({ event_id: '(batch)', reason: `BATCH_TOO_LARGE:${MAX_BATCH}` });
    return out;
  }
  const valid: EventEnvelope[] = [];
  const seenInBatch = new Set<string>();
  for (const raw of batch) {
    const id = typeof raw === 'object' && raw !== null && typeof (raw as { event_id?: unknown }).event_id === 'string' ? (raw as { event_id: string }).event_id : '(unknown)';
    if (!validators.eventEnvelope(raw)) {
      out.rejected.push({ event_id: id, reason: `SCHEMA_INVALID:${validators.eventEnvelope.errors.slice(0, 2).join('; ')}` });
      continue;
    }
    if (raw.session_id !== expectedSessionId) {
      out.rejected.push({ event_id: id, reason: 'SESSION_MISMATCH' });
      continue;
    }
    if (seenInBatch.has(raw.event_id)) {
      out.duplicates.push(raw.event_id);
      continue;
    }
    seenInBatch.add(raw.event_id);
    valid.push(raw);
  }
  if (!valid.length) return out;
  const existing = await repo.existingIds(expectedSessionId, valid.map((e) => e.event_id));
  const fresh = valid.filter((e) => !existing.has(e.event_id));
  for (const e of valid) if (existing.has(e.event_id)) out.duplicates.push(e.event_id);
  const inserted = fresh.length ? await repo.insertMany(fresh) : new Set<string>();
  for (const e of fresh) (inserted.has(e.event_id) ? out.accepted : out.duplicates).push(e.event_id);
  return out;
}

/** Derived rows mirrored from event payloads (best effort, same transaction in Prisma). */
export interface DerivedRows {
  executions: Array<{ session_id: string; movement_id: string; start_ms: number; end_ms: number | null; model_versions: Record<string, unknown>; state: string }>;
  assessments: Array<{ session_id: string; execution_id: string | null; criterion_id: string; status: string; score: number | null; rubric_version: string; evidence_ref: Record<string, unknown> }>;
}

export function deriveRows(events: EventEnvelope[]): DerivedRows {
  const out: DerivedRows = { executions: [], assessments: [] };
  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    if (e.event_type === 'movement.event' && (p.state === 'COMPLETE' || p.state === 'ABORTED') && typeof p.movement_id === 'string') {
      out.executions.push({
        session_id: e.session_id,
        movement_id: p.movement_id,
        start_ms: Number(p.start_ms ?? e.monotonic_ms),
        end_ms: typeof p.end_ms === 'number' ? p.end_ms : null,
        model_versions: { model_version: p.model_version ?? null, sport_pack_version: e.sport_pack_version },
        state: String(p.state),
      });
    }
    if (e.event_type === 'assessment.set' && Array.isArray(p.criteria)) {
      for (const c of p.criteria as Array<Record<string, unknown>>) {
        out.assessments.push({
          session_id: e.session_id,
          execution_id: typeof p.execution_id === 'string' ? p.execution_id : null,
          criterion_id: String(c.criterion_id),
          status: String(c.state),
          score: typeof c.score === 'number' ? c.score : null,
          rubric_version: String(p.rubric_version ?? 'unknown'),
          // Evidence references only (frame ids, reason); never raw media.
          evidence_ref: { frame_ids: (c.evidence as Record<string, unknown> | undefined)?.frame_ids ?? [], reason: (c.measurement as Record<string, unknown> | undefined)?.reason ?? null, event_id: e.event_id },
        });
      }
    }
  }
  return out;
}
