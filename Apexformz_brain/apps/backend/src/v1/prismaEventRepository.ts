import type { EventEnvelope } from '@apexformz/contracts';
import { prisma } from '../utils/prisma';
import { deriveRows, type SessionEventRepository } from './ingestion';

/** Prisma-backed repository: unique(session_id, id) is the final idempotency guard. */
export class PrismaSessionEventRepository implements SessionEventRepository {
  async existingIds(sessionId: string, ids: string[]): Promise<Set<string>> {
    const rows = await prisma.sessionEvent.findMany({ where: { session_id: sessionId, id: { in: ids } }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  async insertMany(events: EventEnvelope[]): Promise<Set<string>> {
    if (!events.length) return new Set();
    const sessionId = events[0].session_id;
    if (events.some(e => e.session_id !== sessionId)) throw new Error('event transaction must contain one session');
    return prisma.$transaction(async (tx) => {
      // Serialize one session's batches before checking which envelopes are new.
      // Derivations and envelopes then commit once, together, including under retries.
      const sessions = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BrainSession" WHERE "id" = ${sessionId} FOR UPDATE`;
      if (!sessions.length) throw new Error('event session does not exist');
      const existing = new Set((await tx.sessionEvent.findMany({ where: { session_id: sessionId, id: { in: events.map(e => e.event_id) } }, select: { id: true } })).map(e => e.id));
      const fresh = events.filter(e => !existing.has(e.event_id) && (existing.add(e.event_id), true));
      if (!fresh.length) return new Set<string>();
      const derived = deriveRows(fresh);
      await tx.sessionEvent.createMany({
        data: fresh.map((e) => ({
          id: e.event_id,
          session_id: e.session_id,
          monotonic_ms: e.monotonic_ms,
          event_type: e.event_type,
          payload_schema: e.schema_version,
          payload: e.payload as object,
          sequence: e.sequence ?? null,
        })),
      });
      if (derived.executions.length) {
        await tx.movementExecution.createMany({ data: derived.executions.map((x) => ({ ...x, model_versions: x.model_versions as object })) });
      }
      if (derived.assessments.length) {
        await tx.criterionAssessment.createMany({ data: derived.assessments.map((a) => ({ ...a, evidence_ref: a.evidence_ref as object })) });
      }
      return new Set(fresh.map(e => e.event_id));
    });
  }
}
