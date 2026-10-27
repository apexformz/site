import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@apexformz/contracts';
import { OutboxSyncer, httpSyncTransport, recoverPersistedOutbox, unwrapIngestResponse, type SyncTransport } from './sync';
import { MemoryOutboxStore } from './outbox_store';

const env = (session: string, seq: number): EventEnvelope => ({
  schema_version: '1.0.0', session_id: session, event_id: `${session}-${seq}`, monotonic_ms: seq * 10, sport_pack_id: 'p', sport_pack_version: '1.0.0',
  producer: 'test', event_type: 'movement.event', payload: {}, sequence: seq,
} as EventEnvelope);

describe('ingest response contract', () => {
  it('unwraps the backend envelope { success, data }', () => {
    const r = unwrapIngestResponse({ success: true, data: { accepted: ['a'], duplicates: ['b'], rejected: [] } });
    expect(r).toEqual({ accepted: ['a'], duplicates: ['b'], rejected: [] });
  });
  it('accepts a bare outcome and rejects anything else loudly', () => {
    expect(unwrapIngestResponse({ accepted: [], duplicates: [], rejected: [] }).accepted).toEqual([]);
    expect(() => unwrapIngestResponse({ success: true })).toThrowError(/unexpected response shape/);
    expect(() => unwrapIngestResponse({ success: false, error: 'Forbidden' })).toThrowError(/Forbidden/);
    expect(() => unwrapIngestResponse(null)).toThrowError();
  });
  it('httpSyncTransport posts the batch and returns the unwrapped outcome', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return { ok: true, status: 200, json: async () => ({ success: true, data: { accepted: ['s-1'], duplicates: [], rejected: [] } }) } as Response;
    }) as unknown as typeof fetch;
    const t = httpSyncTransport('http://api/v1', () => 'tok', fetchImpl);
    const res = await t.postEvents('s', [env('s', 1)]);
    expect(res.accepted).toEqual(['s-1']);
    expect(calls[0].url).toBe('http://api/v1/sessions/s/events');
    expect(Array.isArray(calls[0].body)).toBe(true);
  });
});

describe('OutboxSyncer acknowledgement', () => {
  it('acks accepted, duplicate and rejected ids so the queue drains', async () => {
    const pending = [env('s', 1), env('s', 2), env('s', 3)];
    const acked: string[] = [];
    const source = { drainOutbox: async () => pending.filter((e) => !acked.includes(e.event_id)), ackOutbox: (ids: string[]) => acked.push(...ids) };
    const transport: SyncTransport = { postEvents: async (_s, events) => ({ accepted: [events[0].event_id], duplicates: [events[1].event_id], rejected: [{ event_id: events[2].event_id, reason: 'SCHEMA_INVALID' }] }) };
    const syncer = new OutboxSyncer(source, transport, 's');
    expect(await syncer.flush()).toBe(true);
    expect(acked.sort()).toEqual(['s-1', 's-2', 's-3']);
    expect(syncer.committed).toBe(1);
    expect(syncer.rejected).toHaveLength(1);
    expect(await syncer.flush()).toBe(true); // empty now
  });
});

describe('recoverPersistedOutbox', () => {
  it('ships persisted events of earlier sessions grouped by session and clears them from the store', async () => {
    const store = new MemoryOutboxStore();
    for (const e of [env('old-a', 2), env('old-a', 1), env('old-b', 1)]) store.put(e);
    const posted: Array<{ session: string; ids: string[] }> = [];
    const transport: SyncTransport = { postEvents: async (session, events) => { posted.push({ session, ids: events.map((e) => e.event_id) }); return { accepted: events.map((e) => e.event_id), duplicates: [], rejected: [] }; } };
    const client = { recoverOutbox: () => store.all(), ackOutbox: (ids: string[]) => store.remove(ids) };
    const r = await recoverPersistedOutbox(client, transport);
    expect(r).toEqual({ sessions: 2, committed: 3, failed: 0 });
    expect(posted.find((p) => p.session === 'old-a')!.ids).toEqual(['old-a-1', 'old-a-2']); // sequence order restored
    expect(await store.all()).toHaveLength(0);
  });

  it('keeps events in the store when the server is unreachable', async () => {
    const store = new MemoryOutboxStore();
    store.put(env('old', 1));
    const transport: SyncTransport = { postEvents: async () => { throw new Error('offline'); } };
    const r = await recoverPersistedOutbox({ recoverOutbox: () => store.all(), ackOutbox: (ids) => store.remove(ids) }, transport);
    expect(r.failed).toBe(1);
    expect(await store.all()).toHaveLength(1);
  });
});
