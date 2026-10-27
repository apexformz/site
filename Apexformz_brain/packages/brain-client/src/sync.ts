import type { EventEnvelope } from '@apexformz/contracts';

export interface SyncTransport {
  /** POST a batch; must resolve with accepted + duplicate ids (both count as committed). */
  postEvents(sessionId: string, events: EventEnvelope[]): Promise<{ accepted: string[]; duplicates: string[]; rejected: Array<{ event_id: string; reason: string }> }>;
}

export interface OutboxSource {
  drainOutbox(max: number): Promise<EventEnvelope[]>;
  ackOutbox(eventIds: string[]): void;
}

/**
 * Async cloud sync of the local outbox (TRD 13): deterministic retry/backoff,
 * exactly-once by event id on the server, never discards unsynced events.
 * Runs off the real-time path.
 */
export class OutboxSyncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  lastError: string | null = null;
  committed = 0;
  rejected: Array<{ event_id: string; reason: string }> = [];

  constructor(
    private readonly source: OutboxSource,
    private readonly transport: SyncTransport,
    private readonly sessionId: string,
    private readonly opts: { interval_ms?: number; batch?: number; max_backoff_ms?: number; online?: () => boolean } = {},
  ) {}

  private readonly onHidden = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void this.flush();
  };

  start(): void {
    this.stopped = false;
    this.schedule(this.opts.interval_ms ?? 3000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onHidden);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onHidden);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.flush().then((ok) => this.schedule(ok ? this.opts.interval_ms ?? 3000 : this.backoff())), ms);
  }

  private backoff(): number {
    this.attempt++;
    return Math.min(this.opts.max_backoff_ms ?? 60000, 1000 * 2 ** Math.min(this.attempt, 6));
  }

  /** Push one batch. Returns true when the outbox is empty or the push succeeded. */
  async flush(): Promise<boolean> {
    if (this.opts.online && !this.opts.online()) return false;
    const events = await this.source.drainOutbox(this.opts.batch ?? 200);
    if (!events.length) return true;
    try {
      const res = await this.transport.postEvents(this.sessionId, events);
      const committed = [...res.accepted, ...res.duplicates];
      this.source.ackOutbox(committed);
      this.committed += res.accepted.length;
      this.rejected.push(...res.rejected);
      // Rejected (schema-invalid) events are acked too so they do not block the queue; they stay in `rejected` for diagnostics.
      if (res.rejected.length) this.source.ackOutbox(res.rejected.map((r) => r.event_id));
      this.attempt = 0;
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = (e as Error).message;
      return false;
    }
  }
}

export interface IngestOutcome {
  accepted: string[];
  duplicates: string[];
  rejected: Array<{ event_id: string; reason: string }>;
}

/** The backend answers `{ success, data: outcome }`; a bare outcome is accepted too. Anything else is a protocol error, never a silent no-op. */
export function unwrapIngestResponse(json: unknown): IngestOutcome {
  const body = json as { success?: boolean; data?: unknown; error?: string } | null;
  if (body && typeof body === 'object' && body.success === false) throw new Error(`event ingestion rejected: ${body.error ?? 'unknown error'}`);
  const candidate = body && typeof body === 'object' && 'data' in body ? body.data : body;
  const o = candidate as Partial<IngestOutcome> | null;
  if (!o || !Array.isArray(o.accepted) || !Array.isArray(o.duplicates) || !Array.isArray(o.rejected)) {
    throw new Error('event ingestion returned an unexpected response shape');
  }
  return { accepted: o.accepted, duplicates: o.duplicates, rejected: o.rejected };
}

/**
 * Ship events persisted by earlier sessions (worker IndexedDB store) that were never acknowledged, grouped by
 * session, and acknowledge them so the store is cleared. Exactly-once is guaranteed by the server's event ids.
 */
export async function recoverPersistedOutbox(
  client: { recoverOutbox(): Promise<EventEnvelope[]>; ackOutbox(eventIds: string[]): void },
  transport: SyncTransport,
): Promise<{ sessions: number; committed: number; failed: number }> {
  const events = await client.recoverOutbox();
  const bySession = new Map<string, EventEnvelope[]>();
  for (const e of events) bySession.set(e.session_id, [...(bySession.get(e.session_id) ?? []), e]);
  let committed = 0;
  let failed = 0;
  for (const [sessionId, batch] of bySession) {
    batch.sort((a, b) => (a.sequence ?? a.monotonic_ms) - (b.sequence ?? b.monotonic_ms));
    for (let i = 0; i < batch.length; i += 200) {
      const slice = batch.slice(i, i + 200);
      try {
        const res = await transport.postEvents(sessionId, slice);
        client.ackOutbox([...res.accepted, ...res.duplicates, ...res.rejected.map((r) => r.event_id)]);
        committed += res.accepted.length + res.duplicates.length;
      } catch {
        failed += slice.length; // stays persisted; retried on the next launch
      }
    }
  }
  return { sessions: bySession.size, committed, failed };
}

/** Default transport against the backend v1 API. */
export function httpSyncTransport(baseUrl: string, getToken: () => string | null, fetchImpl: typeof fetch = fetch): SyncTransport {
  return {
    async postEvents(sessionId, events) {
      const token = getToken();
      const res = await fetchImpl(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(events),
      });
      if (!res.ok) throw new Error(`event ingestion failed: ${res.status}`);
      return unwrapIngestResponse(await res.json());
    },
  };
}
