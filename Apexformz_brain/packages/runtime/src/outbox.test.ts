import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@apexformz/contracts';
import { EventOutbox, type OutboxSink } from './outbox';

class FakeSink implements OutboxSink {
  stored = new Map<string, EventEnvelope>();
  put(e: EventEnvelope): void {
    this.stored.set(e.event_id, e);
  }
  remove(ids: string[]): void {
    for (const id of ids) this.stored.delete(id);
  }
}

const opts = { quota: 3, session_id: 's1', sport_pack_id: 'p', sport_pack_version: '1.0.0', producer: 'test' };

describe('EventOutbox durable sink', () => {
  it('writes every event to the sink on append and deletes it on ack', () => {
    const sink = new FakeSink();
    const ob = new EventOutbox({ ...opts, sink });
    const a = ob.append('movement.event', 1, { x: 1 });
    const b = ob.append('assessment.set', 2, { x: 2 });
    expect([...sink.stored.keys()]).toEqual([a.event_id, b.event_id]);
    ob.ack([a.event_id]);
    expect([...sink.stored.keys()]).toEqual([b.event_id]);
    expect(ob.pending()).toBe(1);
  });

  it('memory eviction of critical events keeps them in the sink for recovery; evicted telemetry is dropped from both', () => {
    const sink = new FakeSink();
    const ob = new EventOutbox({ ...opts, sink });
    const t = ob.append('telemetry.sample', 1, {});
    const e1 = ob.append('movement.event', 2, {});
    const e2 = ob.append('movement.event', 3, {});
    const e3 = ob.append('movement.event', 4, {}); // quota 3: telemetry evicted first
    expect(sink.stored.has(t.event_id)).toBe(false);
    const e4 = ob.append('movement.event', 5, {}); // quota 3: oldest critical evicted from memory only
    expect(ob.pending()).toBe(3);
    expect(ob.stats.evicted_critical).toBe(1);
    expect([e1, e2, e3, e4].every((e) => sink.stored.has(e.event_id))).toBe(true);
  });

  it('works without a sink (memory-only, as in tests and native hosts without storage)', () => {
    const ob = new EventOutbox(opts);
    ob.append('movement.event', 1, {});
    expect(ob.drain()).toHaveLength(1);
  });
});
