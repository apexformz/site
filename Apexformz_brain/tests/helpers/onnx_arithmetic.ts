import { createHash } from 'node:crypto';
import fixture from '../fixtures/onnx_arithmetic.json';

export function arithmeticModel(kind: 'movement' | 'reid'): Uint8Array {
  const bytes = Buffer.from(fixture[kind].base64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== fixture[kind].sha256) throw new Error(`corrupt ${kind} ONNX test fixture`);
  return new Uint8Array(bytes);
}

export const arithmeticReidConfig = {
  schema_version: '1.0.0', model_id: 'test.rgb_means', digest: `sha256:${fixture.reid.sha256}`, model_url: 'reid.onnx',
  input: { height: 32, width: 16, layout: 'NCHW', color: 'RGB', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], crop_padding: [0.1, 0.06] },
  embedding_dim: 8,
};
