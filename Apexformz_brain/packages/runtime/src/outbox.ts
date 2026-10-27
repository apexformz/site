import { CONTRACT_VERSION, makeEventId, type EventEnvelope, type EventType } from '@apexformz/contracts';

/**
 * Durable sink behind the in-memory outbox (IndexedDB in the browser worker, a file on native). Events are
 * written on append and deleted on acknowledgement, so unsynced evidence survives a closed tab or a crash and is
 * recovered on the next launch. Implementations must be non-blocking; failures are reported through `stats`.
 */
export interface OutboxSink {
  put(event: EventEnvelope): void;
  remove(eventIds: string[]): void;
}

export interface OutboxOptions {
  quota: number;
  session_id: string;
  sport_pack_id: string;
  sport_pack_version: string;
  producer: string;
  sink?: OutboxSink;
}

/**
 * Local append-only event outbox (TRD 01/13). Bounded quota: telemetry samples
 * are evicted first; session, assessment, movement and feedback events are
 * never silently discarded (eviction of those is counted and surfaced).
 */
export class EventOutbox {
  private events: EventEnvelope[] = [];
  private sequence = 0;
  private acked = new Set<string>();
  private evictedTelemetry = 0;
  private evictedCritical = 0;

  constructor(private readonly opts: OutboxOptions) {}

  get size(): number {
    return this.events.length;
  }

  get stats() {
    return { size: this.events.length, sequence: this.sequence, evicted_telemetry: this.evictedTelemetry, evicted_critical: this.evictedCritical };
  }

  append<T extends Record<string, unknown>>(type: EventType, monotonicMs: number, payload: T, wallClockIso?: string): EventEnvelope<T> {
    this.sequence++;
    const env: EventEnvelope<T> = {
      schema_version: CONTRACT_VERSION,
      session_id: this.opts.session_id,
      event_id: makeEventId(this.opts.session_id, this.sequence),
      monotonic_ms: monotonicMs,
      wall_clock_iso: wallClockIso,
      sport_pack_id: this.opts.sport_pack_id,
      sport_pack_version: this.opts.sport_pack_version,
      producer: this.opts.producer,
      event_type: type,
      payload,
      sequence: this.sequence,
    };
    this.events.push(env as EventEnvelope);
    this.opts.sink?.put(env as EventEnvelope);
    this.enforceQuota();
    return env;
  }

  /** Peek at up to `max` unacknowledged events in order (deterministic retry). */
  drain(max = 200): EventEnvelope[] {
    return this.events.filter((e) => !this.acked.has(e.event_id)).slice(0, max);
  }

  /** Acknowledge cloud-committed events; they are removed from the outbox. */
  ack(eventIds: string[]): void {
    for (const id of eventIds) this.acked.add(id);
    this.events = this.events.filter((e) => !this.acked.has(e.event_id));
    for (const id of eventIds) this.acked.delete(id);
    if (eventIds.length) this.opts.sink?.remove(eventIds);
  }

  pending(): number {
    return this.events.length;
  }

  /** Memory quota only: evicted events stay in the durable sink (if any) and are shipped by outbox recovery. */
  private enforceQuota(): void {
    while (this.events.length > this.opts.quota) {
      const idx = this.events.findIndex((e) => e.event_type === 'telemetry.sample');
      if (idx >= 0) {
        const [t] = this.events.splice(idx, 1);
        this.evictedTelemetry++;
        this.opts.sink?.remove([t.event_id]); // telemetry is reproducible; do not let it fill the store
      } else {
        this.events.shift();
        this.evictedCritical++;
      }
    }
  }
}
