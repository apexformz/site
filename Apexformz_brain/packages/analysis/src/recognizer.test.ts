import { describe, expect, it, vi } from 'vitest';
import { finalFrameLogits, OnnxRecognizer, seriesToTensor } from './recognizer';
import type { ResampledSeries } from '@apexformz/signal';

function series(): ResampledSeries {
  return { timestamps_ms: [0, 100], values: [[{ x: 1, y: 2, z: 3 }], [{ x: 4, y: 5, z: null }]], mask: [[true], [true]], padded: [false, false] };
}

describe('movement ONNX decoding', () => {
  it('decodes the last causal timestep instead of softmax over the flattened sequence', async () => {
    const run = vi.fn(async () => ({ logits: { data: new Float32Array([20, 0, 0, 0, 10, 0]), dims: [1, 2, 3] } }));
    const recognizer = new OnnxRecognizer({ model_id: 'test', version: '1' }, ['source forehand', 'source backhand', 'UNKNOWN'], async () => ({ run }));
    await recognizer.load();
    const output = await recognizer.predictAsync(series());
    expect(output.probabilities['source backhand']).toBeGreaterThan(0.99);
    expect(output.probabilities['source forehand']).toBeLessThan(0.001);
    expect(Object.values(output.probabilities).reduce((sum, p) => sum + p, output.unknown_probability)).toBeCloseTo(1);
  });

  it('uses the last observed timestep when a sequence ends with padding', async () => {
    const recognizer = new OnnxRecognizer({ model_id: 'test', version: '1' }, ['capture', 'UNKNOWN'], async () => ({ run: async () => ({ logits: { data: [10, 0, 0, 10], dims: [1, 2, 2] } }) }));
    await recognizer.load();
    const input = series(); input.mask[1] = [false]; input.padded[1] = true;
    expect((await recognizer.predictAsync(input)).probabilities.capture).toBeGreaterThan(0.99);
  });

  it('does not infer on a fully missing window and respects masks even when stale coordinates remain', async () => {
    const run = vi.fn();
    const recognizer = new OnnxRecognizer({ model_id: 'test', version: '1' }, ['capture', 'UNKNOWN'], async () => ({ run }));
    await recognizer.load();
    const input = series(); input.mask = [[false], [false]];
    expect([...seriesToTensor(input).input.data]).toEqual([0, 0, 0, 0, 0, 0]);
    expect((await recognizer.predictAsync(input)).unknown_probability).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('applies temperature calibration and supports static [1,C] output', async () => {
    const recognizer = new OnnxRecognizer({ model_id: 'test', version: '1' }, ['capture', 'UNKNOWN'], async () => ({ run: async () => ({ logits: { data: [2, 0], dims: [1, 2] } }) }), 2);
    await recognizer.load();
    expect((await recognizer.predictAsync(series())).probabilities.capture).toBeCloseTo(0.7310586);
  });

  it('rejects incompatible, missing-shape and non-finite logits instead of assigning wrong classes', () => {
    expect(() => finalFrameLogits({ data: [1, 2, 3, 4], dims: [2, 2] }, 2, 2)).toThrow(/shape/);
    expect(() => finalFrameLogits({ data: [1, 2, 3, 4] }, 2, 2)).toThrow(/metadata/);
    expect(() => finalFrameLogits({ data: [NaN, 1], dims: [1, 2] }, 2, 1)).toThrow(/non-finite/);
  });
});
