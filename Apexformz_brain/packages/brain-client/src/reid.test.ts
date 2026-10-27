import { describe, expect, it } from 'vitest';
import type { OnnxSessionLike } from '@apexformz/analysis';
import { arithmeticModel, arithmeticReidConfig as shipped } from '../../../tests/helpers/onnx_arithmetic';
import { cropRect, loadReidEmbedder, ReidEmbedder, rgbaToTensor, validateReidConfig } from './reid';
import { openAnyOrtSession } from './movement_model_loader';

describe('re-identification embedder', () => {
  it('accepts a complete config and rejects broken ones', () => {
    expect(validateReidConfig(shipped).input.height).toBe(32);
    expect(() => validateReidConfig({ ...shipped, digest: 'sha256:abc' })).toThrow(/digest/);
    expect(() => validateReidConfig({ ...shipped, input: { ...shipped.input, std: [0, 1, 1] } })).toThrow(/normalization/);
  });

  it('pads and clamps crop rectangles, and skips tiny people', () => {
    const r = cropRect({ x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.8 }, 1000, 1000, [0.1, 0.06])!;
    expect([r.sx, r.sy, r.sw]).toEqual([380, 164, 240]);
    expect(Math.abs(r.sh - 672)).toBeLessThanOrEqual(1); // floating-point rounding of the padded edge
    expect(cropRect({ x0: 0.0, y0: 0.0, x1: 0.05, y1: 0.95 }, 1000, 1000, [0.1, 0.06])!.sx).toBe(0);
    expect(cropRect({ x0: 0.5, y0: 0.5, x1: 0.502, y1: 0.51 }, 1000, 1000, [0.1, 0.06])).toBeNull();
  });

  it('normalizes RGBA pixels and executes an input-dependent ONNX graph for each person', async () => {
    const { width, height, mean, std } = shipped.input;
    const colors = [[50, 120, 220], [200, 80, 10]];
    const tensor = new Float32Array(2 * 3 * width * height);
    colors.forEach((rgb, i) => {
      const rgba = Uint8ClampedArray.from({ length: 4 * width * height }, (_, k) => k % 4 === 3 ? 255 : rgb[k % 4]);
      rgbaToTensor(rgba, width, height, mean, std, tensor, i * 3 * width * height);
    });
    const session = await openAnyOrtSession(arithmeticModel('reid'), {});
    const embedder = new ReidEmbedder(session, validateReidConfig(shipped));
    try {
      const embeddings = await embedder.embed(tensor, 2);
      expect(embeddings).toHaveLength(2);
      embeddings.forEach((e, i) => {
        expect(e).toHaveLength(8);
        const weightedMean = colors[i].reduce((sum, pixel, ch) => sum + ((pixel / 255 - mean[ch]) / std[ch]) * (ch + 1), 0);
        e.forEach((v, k) => expect(v).toBeCloseTo(weightedMean * (k + 1) / 8, 4));
      });
    } finally { await embedder.close(); }
  }, 60_000);

  it('verifies the model digest and splits a batch into per-person embeddings', async () => {
    const model = new Uint8Array([1, 2, 3]);
    const digest = `sha256:${Buffer.from(await crypto.subtle.digest('SHA-256', model)).toString('hex')}`;
    const fake: OnnxSessionLike = { run: async (f) => ({ embedding: { data: Float32Array.from({ length: 2 * 4 }, (_, k) => k + f.input.dims[0] * 0), dims: [2, 4] } }) };
    const respond = (body: unknown) => ({ ok: true, json: async () => body, arrayBuffer: async () => model.buffer, headers: new Headers() }) as unknown as Response;
    const fetchFor = (cfg: unknown) => (async (url: string) => respond(String(url).endsWith('.json') ? cfg : model)) as unknown as typeof fetch;
    const embedder = await loadReidEmbedder('http://x/models/reid/reid.json', async () => fake, fetchFor({ ...shipped, digest, embedding_dim: 8 }));
    const parts = await embedder.embed(new Float32Array(2 * 3 * shipped.input.height * shipped.input.width), 2);
    expect(parts.map((p) => Array.from(p))).toEqual([[0, 1, 2, 3], [4, 5, 6, 7]]);
    await expect(loadReidEmbedder('http://x/models/reid/reid.json', async () => fake, fetchFor({ ...shipped, digest: `sha256:${'0'.repeat(64)}` })))
      .rejects.toThrow(/digest mismatch/);
  });
});
