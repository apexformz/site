import { describe, expect, it } from 'vitest';
import type { OnnxSessionLike } from '@apexformz/analysis';
import { InferenceWorkerUnavailable, remoteSessionFactory } from './remote_session';
import { openOrtSession } from './movement_model_loader';
import { pairedInferenceWorker as pairedWorker } from '../../../tests/helpers/paired_inference_worker';
import { arithmeticModel } from '../../../tests/helpers/onnx_arithmetic';

const fakeSession = (): OnnxSessionLike => ({
  run: async (feeds) => ({ logits: { data: Float32Array.from(feeds.input.data.slice(0, 3).map((v) => v * 2)), dims: [1, 3] } }),
  release: async () => undefined,
});

describe('remote movement inference', () => {
  it('returns the same outputs through the worker protocol', async () => {
    const session = await remoteSessionFactory(() => pairedWorker(async () => fakeSession()))(new Uint8Array([1, 2]), {});
    const out = await session.run({ input: { data: Float32Array.from([1, 2, 3, 4]), dims: [1, 4] }, mask: { data: new Float32Array(1), dims: [1, 1] } });
    expect(Array.from(out.logits.data)).toEqual([2, 4, 6]);
    expect(out.logits.dims).toEqual([1, 3]);
  });

  it('matches real inline ONNX inference and independently computed outputs, including masked frames', async () => {
    const bytes = arithmeticModel('movement');
    const inline = await openOrtSession(bytes, {});
    const remote = await remoteSessionFactory(() => pairedWorker((b) => openOrtSession(b, {})))(bytes, {});
    const T = 7;
    const input = Float32Array.from({ length: T * 99 }, (_, i) => Math.sin(i * 0.37) * 0.3);
    const mask = Float32Array.from({ length: T * 33 }, (_, i) => i % 5 === 0 ? 0 : 1);
    const feeds = () => ({ input: { data: input.slice(), dims: [1, T, 99] }, mask: { data: mask.slice(), dims: [1, T, 33] } });
    try {
      const a = await inline.run(feeds());
      const b = await remote.run(feeds());
      expect(b.logits.dims).toEqual([1, T, 3]);
      expect(Array.from(b.logits.data)).toEqual(Array.from(a.logits.data));
      for (let t = 0; t < T; t++) {
        const x = input.slice(t * 99, (t + 1) * 99).reduce((s, v) => s + v, 0) / 99;
        const m = mask.slice(t * 33, (t + 1) * 33).reduce((s, v) => s + v, 0) / 33;
        [x + m, x - m, x * m].forEach((v, k) => expect(b.logits.data[t * 3 + k]).toBeCloseTo(v, 6));
      }
    } finally {
      await inline.release?.();
      await remote.release?.();
    }
  }, 60_000);

  it('a worker that cannot start or load is reported so the brain can fall back to inline', async () => {
    await expect(remoteSessionFactory(() => { throw new Error('no nested workers'); })(new Uint8Array([1]), {})).rejects.toBeInstanceOf(InferenceWorkerUnavailable);
    const w = pairedWorker(async () => { throw new Error('bad model'); });
    await expect(remoteSessionFactory(() => w)(new Uint8Array([1]), {})).rejects.toBeInstanceOf(InferenceWorkerUnavailable);
    expect(w.terminated).toBe(true);
  });

  it('a run error is passed back as an error, and a crashed worker fails pending and later runs', async () => {
    const failing: OnnxSessionLike = { run: async () => { throw new Error('bad input'); } };
    const session = await remoteSessionFactory(() => pairedWorker(async () => failing))(new Uint8Array([1]), {});
    await expect(session.run({ input: { data: new Float32Array(1), dims: [1] } })).rejects.toThrow('bad input');
    const w = pairedWorker(async () => fakeSession());
    const s2 = await remoteSessionFactory(() => w)(new Uint8Array([1]), {});
    w.onerror?.({});
    await expect(s2.run({ input: { data: new Float32Array(3), dims: [3] } })).rejects.toThrow('inference worker failed');
  });
});
