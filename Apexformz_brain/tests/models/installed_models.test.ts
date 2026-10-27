import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifiedArtifacts } from '../../tools/browser_model_artifacts';
import { openAnyOrtSession, openOrtSession } from '../../packages/brain-client/src/movement_model_loader';
import { remoteSessionFactory } from '../../packages/brain-client/src/remote_session';
import { ReidEmbedder, rgbaToTensor, validateReidConfig } from '../../packages/brain-client/src/reid';
import { validateMovementModelConfig } from '@apexformz/analysis';
import { pairedInferenceWorker } from '../helpers/paired_inference_worker';
import movementReference from './installed-movement-outputs.json';
import reidReference from '../../packages/brain-client/src/__fixtures__/reid_embedding.json';

const PREFIX = 'apps/frontend/public/models/';
let assets: Map<string, Buffer>;
const asset = (path: string) => {
  const data = assets.get(PREFIX + path);
  if (!data) throw new Error(`model artifact is not locked: ${path}`);
  return data;
};
const json = (path: string) => JSON.parse(asset(path).toString('utf8'));
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

beforeAll(() => { assets = verifiedArtifacts(); });

describe('installed models (required, SHA-256-pinned release artifacts)', () => {
  for (const task of ['static_pose', 'dynamic_movement'] as const) {
    it(`${task}: actual ONNX matches PyTorch reference and worker inference`, async () => {
      const config = validateMovementModelConfig(json(`squash/${task}.deployment.json`));
      const bytes = new Uint8Array(asset(`squash/${task}.onnx`));
      const reference = movementReference.models[task];
      expect(digest(bytes)).toBe(config.model.digest);
      expect(config.model.digest).toBe(reference.model_digest);
      expect(config.model.version).toBe(reference.model_version);
      expect(config.classes).toHaveLength(reference.output_dims.at(-1)!);
      const T = reference.window_frames;
      const input = Float32Array.from({ length: T * 99 }, (_, i) => (i % 31 - 15) / 32);
      const mask = Float32Array.from({ length: T * 33 }, (_, i) => Number(i % 11 !== 0));
      const feeds = () => ({ input: { data: input.slice(), dims: [1, T, 99] }, mask: { data: mask.slice(), dims: [1, T, 33] } });
      const inline = await openOrtSession(bytes, {});
      const remote = await remoteSessionFactory(() => pairedInferenceWorker((b) => openOrtSession(b, {})))(bytes, {});
      try {
        const a = await inline.run(feeds()); const b = await remote.run(feeds());
        expect(a.logits.dims).toEqual(reference.output_dims);
        expect(b.logits.dims).toEqual(reference.output_dims);
        expect(Array.from(b.logits.data)).toEqual(Array.from(a.logits.data));
        expect(a.logits.data).toHaveLength(reference.output.length);
        let maxDiff = 0;
        a.logits.data.forEach((v, k) => { expect(Number.isFinite(v)).toBe(true); maxDiff = Math.max(maxDiff, Math.abs(v - reference.output[k])); });
        expect(maxDiff).toBeLessThan(5e-4);
      } finally { await inline.release?.(); await remote.release?.(); }
    });
  }

  it('re-ID: pixels -> normalized tensor -> installed OSNet matches Python reference', async () => {
    const config = validateReidConfig(json('reid/reid.json'));
    const bytes = new Uint8Array(asset(`reid/${config.model_url}`));
    expect(digest(bytes)).toBe(config.digest);
    const fx = reidReference as unknown as { rgba_base64: string; width: number; height: number; embedding: number[] };
    expect([fx.width, fx.height]).toEqual([config.input.width, config.input.height]);
    const tensor = new Float32Array(3 * fx.width * fx.height);
    rgbaToTensor(new Uint8ClampedArray(Buffer.from(fx.rgba_base64, 'base64')), fx.width, fx.height, config.input.mean, config.input.std, tensor);
    const embedder = new ReidEmbedder(await openAnyOrtSession(bytes, {}), config);
    try {
      const [e] = await embedder.embed(tensor, 1);
      expect(e).toHaveLength(config.embedding_dim);
      expect(e).toHaveLength(fx.embedding.length);
      let maxDiff = 0;
      e.forEach((v, k) => { expect(Number.isFinite(v)).toBe(true); maxDiff = Math.max(maxDiff, Math.abs(v - fx.embedding[k])); });
      expect(maxDiff).toBeLessThan(1e-3);
    } finally { await embedder.close(); }
  });
});
