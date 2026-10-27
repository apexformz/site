import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildContainers, buildFiles, inventory, inventoryDiff, productionBlockers, REQUIRED_CHECKS, sourceInventory, stageCandidate, verifyCheckReceipt, verifyContainerReceipt, verifyInventory } from '../../tools/release_artifacts';

const roots: string[] = [];
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function temp() { const root = mkdtempSync(join(tmpdir(), 'apex-release-test-')); roots.push(root); return root; }
function write(root: string, path: string, value: unknown) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = temp();
  write(root, 'package.json', { private: true });
  write(root, 'apps/backend/package.json', {});
  write(root, 'apps/frontend/package.json', {});
  write(root, 'apps/backend/dist/server.cjs', 'test-built-backend');
  write(root, 'apps/frontend/.next/BUILD_ID', 'test-build');
  write(root, 'apps/frontend/.next/standalone/apps/frontend/server.js', 'test-built-frontend');
  const trust = { schema_version: 1, mode: 'development', registry: { schema_version: '1.0.0', keys: [] } };
  write(root, 'apps/frontend/src/lib/brain/pack-trust.generated.json', trust);
  write(root, 'apps/frontend/public/pack-trust.json', trust);
  write(root, 'apps/frontend/public/models/squash/static_pose.onnx', 'test model bytes, not a deployment model');
  write(root, 'apps/frontend/public/models/squash/static_pose.deployment.json', { production_eligible: false, calibration: { status: 'provisional' } });
  write(root, 'apps/frontend/public/models/squash/static_pose.model_card.json', { production_eligible: false, metrics: { status: 'not_evaluated' } });
  const names = ['static_pose.onnx', 'static_pose.deployment.json', 'static_pose.model_card.json'].map(p => `apps/frontend/public/models/squash/${p}`);
  write(root, 'tests/models/installed-models.lock.json', { schema_version: 1, artifact_set: 'test-only', files: names.map(path => { const bytes = readFileSync(join(root, path)); return { path, bytes: bytes.length, sha256: hash(bytes) }; }) });
  write(root, 'sport-packs/squash/manifest.json', { signature: { algorithm: 'hmac-sha256', key_id: 'dev-test' } });
  write(root, 'sport-packs/squash/technique_criteria.json', { criteria: [{ validation_status: 'provisional', expert_citation: { status: 'provisional' } }] });
  const receipt = { schema_version: 1, status: 'passed', build_trust_mode: 'development', frontend_public_config: { api_url: 'https://example.invalid/api', socket_url: null }, source_sha256: sourceInventory(root).sha256, prebuild_source_sha256: sourceInventory(root, true).sha256,
    build_inventory: inventory(root, buildFiles(root)), pack_inventory: inventory(join(root, 'sport-packs'), ['squash/manifest.json', 'squash/technique_criteria.json']),
    checks: REQUIRED_CHECKS.map(name => ({ name, exit_code: 0 })) };
  write(root, 'receipt.json', receipt);
  return { root, receipt };
}

describe('release inventory and eligibility gates', () => {
  it('ignores generated benchmark and egg metadata while retaining test sources and unrelated result files', () => {
    const { root } = fixture();
    const testBody = 'packages/perception-py/tests/test_pose_backends.py';
    write(root, testBody, 'def test_example(): assert True\n');
    const before = sourceInventory(root);
    const beforeBuild = sourceInventory(root, true);
    write(root, 'packages/perception-py/tests/_bench_results.json', { measured_fps: 20 });
    write(root, 'packages/perception-py/src/apexformz_perception.egg-info/SOURCES.txt', 'machine-specific generated metadata');
    expect(sourceInventory(root)).toEqual(before);
    expect(sourceInventory(root, true)).toEqual(beforeBuild);
    write(root, 'packages/perception-py/tests/_bench_results.json', { measured_fps: 35 });
    expect(sourceInventory(root)).toEqual(before);
    write(root, testBody, 'def test_example(): assert False\n');
    const change = inventoryDiff(before, sourceInventory(root));
    expect(change.added).toEqual([]); expect(change.removed).toEqual([]);
    expect(change.changed.map(file => file.path)).toEqual([testBody]);
    expect(change.changed[0].before.sha256).not.toBe(change.changed[0].after.sha256);
    write(root, 'packages/perception-py/tests/other_results.json', { source_fixture: true });
    expect(inventoryDiff(before, sourceInventory(root)).added.map(file => file.path)).toEqual(['packages/perception-py/tests/other_results.json']);
  });
  it('is deterministic across discovery order and catches byte changes and extra files', () => {
    const root = temp(); write(root, 'a', 'one'); write(root, 'b', 'two');
    const first = inventory(root, ['b', 'a']);
    expect(first).toEqual(inventory(root, ['a', 'b', 'a']));
    verifyInventory(root, first);
    write(root, 'b', 'changed'); expect(() => verifyInventory(root, first)).toThrow(/mismatch/);
    write(root, 'b', 'two'); write(root, 'extra', 'unlisted'); expect(() => verifyInventory(root, first)).toThrow(/unlisted/);
  });
  it('rejects parent traversal and invalid inventory digests', () => {
    const root = temp(); write(root, 'a', 'one');
    expect(() => inventory(root, ['../a'])).toThrow(/unsafe/);
    const inv = inventory(root, ['a']); inv.sha256 = '0'.repeat(64);
    expect(() => verifyInventory(root, inv)).toThrow(/invalid release inventory/);
  });
  it('requires every successful check, current sources and the exact built outputs', () => {
    const { root, receipt } = fixture(); verifyCheckReceipt(root, receipt);
    expect(() => verifyCheckReceipt(root, { ...receipt, checks: receipt.checks.filter(c => c.name !== 'postgres-integration') })).toThrow(/required release check/);
    write(root, 'apps/frontend/.next/server/added.js', 'unverified server entrypoint');
    expect(() => verifyCheckReceipt(root, receipt)).toThrow(/build changed/);
    rmSync(join(root, 'apps/frontend/.next/server/added.js'));
    write(root, 'apps/backend/dist/server.cjs', 'different build'); expect(() => verifyCheckReceipt(root, receipt)).toThrow(/build changed/);
  });
  it('never calls a passing engineering candidate production eligible and excludes local secrets', () => {
    const { root } = fixture(); write(root, 'apps/frontend/.env.local', 'LOCAL_SECRET=must-not-be-staged');
    write(root, 'apps/frontend/public/local-private.pem', 'private key material must not be staged');
    write(root, 'apps/ai-service/app/data/legacy.pth', 'legacy unpinned model');
    write(root, 'apps/frontend/public/models/unlocked.onnx', 'unlocked optional model');
    const out = join(temp(), 'candidate'); const result = stageCandidate(root, out, join(root, 'receipt.json'));
    verifyInventory(out, result);
    expect(result.files.some(f => f.path.includes('.env') || f.path.endsWith('.pem') || f.path.includes('unlocked.onnx'))).toBe(false);
    expect(result.files.some(f => f.path.endsWith('.pth'))).toBe(false);
    const candidate = JSON.parse(readFileSync(join(out, 'candidate.json'), 'utf8'));
    expect(candidate.frontend_public_config).toEqual({ api_url: 'https://example.invalid/api', socket_url: null });
    expect(() => buildContainers(out, join(out, '..receipt.json'))).toThrow(/outside the immutable candidate/);
    expect(candidate.production_eligible).toBe(false);
    expect(candidate.production_blockers.join('\n')).toMatch(/development pack trust/);
    expect(candidate.production_blockers.join('\n')).toMatch(/provisional/);
    expect(candidate.production_blockers.join('\n')).toMatch(/coach approval/);
    expect(candidate.production_blockers.join('\n')).toMatch(/Ed25519/);
  });
  it('refuses changed pack inputs and missing or corrupted locked models', () => {
    const { root } = fixture(); write(root, 'sport-packs/squash/manifest.json', { changed: true });
    expect(() => stageCandidate(root, join(temp(), 'candidate'), join(root, 'receipt.json'))).toThrow(/packs differ/);
    write(root, 'apps/frontend/public/models/squash/static_pose.onnx', 'bad bytes');
    expect(() => productionBlockers(root, 'production')).toThrow(/SHA-256/);
  });
  it('requires container evidence for this exact candidate and all three image digests', () => {
    const receipt = { schema_version: 1, status: 'passed', inventory_sha256: 'candidate-A', images: ['backend', 'frontend', 'ai-service'].map(name => ({ name, id: `sha256:${'a'.repeat(64)}` })) };
    verifyContainerReceipt(receipt, 'candidate-A');
    expect(() => verifyContainerReceipt(receipt, 'candidate-B')).toThrow(/does not match/);
    expect(() => verifyContainerReceipt({ ...receipt, images: receipt.images.slice(0, 2) }, 'candidate-A')).toThrow(/all three/);
  });
});
