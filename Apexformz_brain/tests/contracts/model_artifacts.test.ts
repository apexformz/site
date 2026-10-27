import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportArtifacts, restoreArtifacts, validateArtifactLock, verifiedArtifacts, type ModelArtifactLock } from '../../tools/browser_model_artifacts';

const bytes = Buffer.from('test model bytes');
const entry = { path: 'apps/frontend/public/models/test/model.onnx', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
const lock: ModelArtifactLock = { schema_version: 1, artifact_set: 'test', files: [entry] };

describe('model artifact bundles', () => {
  it('round-trips verified bytes into a clean checkout and is idempotent', () => {
    const temp = mkdtempSync(join(tmpdir(), 'apex-model-bundle-'));
    const source = join(temp, 'source'); const dest = join(temp, 'dest'); const bundle = join(temp, 'bundle');
    mkdirSync(dirname(join(source, entry.path)), { recursive: true }); mkdirSync(dest);
    writeFileSync(join(source, entry.path), bytes);
    exportArtifacts(bundle, source, lock);
    restoreArtifacts(bundle, dest, false, lock);
    restoreArtifacts(bundle, dest, false, lock);
    expect(verifiedArtifacts(dest, lock).get(entry.path)).toEqual(bytes);
    writeFileSync(join(bundle, entry.path), 'tampered');
    expect(() => restoreArtifacts(bundle, dest, true, lock)).toThrow(/mismatch/);
    expect(readFileSync(join(dest, entry.path))).toEqual(bytes);
  });

  it('rejects absent files, unsafe paths, duplicate entries, and unrequested replacement', () => {
    const temp = mkdtempSync(join(tmpdir(), 'apex-model-missing-'));
    expect(() => verifiedArtifacts(temp, lock)).toThrow(/missing model artifact/);
    expect(() => validateArtifactLock({ ...lock, files: [entry, entry] })).toThrow(/duplicate/);
    expect(() => validateArtifactLock({ ...lock, files: [{ ...entry, path: 'apps/frontend/public/models/../../outside.onnx' }] })).toThrow(/unsafe/);
    const source = join(temp, 'source'); const dest = join(temp, 'dest'); const bundle = join(temp, 'bundle');
    for (const root of [source, dest]) mkdirSync(dirname(join(root, entry.path)), { recursive: true });
    writeFileSync(join(source, entry.path), bytes); writeFileSync(join(dest, entry.path), 'existing');
    exportArtifacts(bundle, source, lock);
    expect(() => restoreArtifacts(bundle, dest, false, lock)).toThrow(/refusing to overwrite/);
    expect(readFileSync(join(dest, entry.path), 'utf8')).toBe('existing');
  });
});
