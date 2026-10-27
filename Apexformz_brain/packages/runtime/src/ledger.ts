import type { EventEnvelope } from '@apexformz/contracts';

export interface IngestResult {
  accepted: EventEnvelope[];
  duplicates: string[];
  rejected: Array<{ event_id: string; reason: string }>;
}

/**
 * Idempotent ingestion ledger keyed on (session_id, event_id) (TRD 13, G09).
 * Pure in-memory reference implementation shared by tests and the backend's
 * unit tests; the backend persists the same semantics with a unique index.
 */
export class EventLedger {
  private seen = new Map<string, Set<string>>();
  private store: EventEnvelope[] = [];

  ingest(batch: EventEnvelope[], validate?: (e: EventEnvelope) => string | null): IngestResult {
    const result: IngestResult = { accepted: [], duplicates: [], rejected: [] };
    for (const e of batch) {
      const err = validate?.(e) ?? null;
      if (err) {
        result.rejected.push({ event_id: e.event_id, reason: err });
        continue;
      }
      let set = this.seen.get(e.session_id);
      if (!set) {
        set = new Set();
        this.seen.set(e.session_id, set);
      }
      if (set.has(e.event_id)) {
        result.duplicates.push(e.event_id);
        continue;
      }
      set.add(e.event_id);
      this.store.push(e);
      result.accepted.push(e);
    }
    return result;
  }

  events(sessionId: string): EventEnvelope[] {
    return this.store.filter((e) => e.session_id === sessionId).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  }

  count(sessionId: string): number {
    return this.seen.get(sessionId)?.size ?? 0;
  }
}
