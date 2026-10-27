/** Local, offline release staging. A candidate is never a production approval. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateArtifactLock, verifiedArtifacts } from './browser_model_artifacts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const slash = (file: string) => file.split(sep).join('/');
export interface Inventory { schema_version: 1; files: { path: string; bytes: number; sha256: string }[]; sha256: string }
export const REQUIRED_CHECKS = ['prisma-generation', 'typescript', 'unit-golden-contracts', 'pack-integrity', 'backend-build', 'frontend-build', 'installed-models', 'postgres-integration', 'python', 'dependency-audit', 'python-dependency-audit'] as const;
const secretPath = (name: string) => /(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/.test(name);

function safeFile(root: string, name: string): string {
  if (!name || name.includes('\\') || isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`unsafe release path: ${name}`);
  if (secretPath(name)) throw new Error(`secret-like file cannot be a release artifact: ${name}`);
  const file = resolve(root, name);
  const rel = relative(realpathSync(root), realpathSync(file));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new Error(`release path is not an in-root regular file: ${name}`);
  return file;
}
function walk(root: string, prefix = '', include: (file: string) => boolean = () => true): string[] {
  const folder = resolve(root, prefix);
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`symlink in release tree: ${name}`);
    if (!include(name)) return [];
    return entry.isDirectory() ? walk(root, name, include) : [name];
  });
}
export function inventory(root: string, names: string[]): Inventory {
  const files = [...new Set(names)].sort().map(path => { const bytes = readFileSync(safeFile(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; });
  return { schema_version: 1, files, sha256: sha(JSON.stringify(files)) };
}
export function inventoryDiff(before: Inventory, after: Inventory) {
  const prior = new Map(before.files.map(file => [file.path, file]));
  const current = new Map(after.files.map(file => [file.path, file]));
  return {
    added: after.files.filter(file => !prior.has(file.path)),
    removed: before.files.filter(file => !current.has(file.path)),
    changed: after.files.flatMap(file => {
      const old = prior.get(file.path);
      return old && (old.bytes !== file.bytes || old.sha256 !== file.sha256) ? [{ path: file.path, before: old, after: file }] : [];
    }),
  };
}
export function verifyInventory(root: string, expected: Inventory): void {
  if (expected?.schema_version !== 1 || !Array.isArray(expected.files) || !expected.files.length || sha(JSON.stringify(expected.files)) !== expected.sha256) throw new Error('invalid release inventory');
  const actual = inventory(root, expected.files.map(f => f.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('release artifact hash/size mismatch');
  const names = walk(root).filter(p => p !== 'inventory.json').sort();
  if (JSON.stringify(names) !== JSON.stringify(expected.files.map(f => f.path))) throw new Error('unlisted or missing release artifact');
}
const sourceFilter = (file: string) => file !== 'packages/perception-py/tests/_bench_results.json'
  && !file.split('/').some(part => ['node_modules', '.next', 'dist', '__pycache__', '.pytest_cache', '.git', 'runs', 'third_party_models'].includes(part) || part.endsWith('.egg-info'))
  && !/(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|pyc|tsbuildinfo|pt|pth|onnx|task|ckpt|safetensors|tflite|pkl)$/.test(file);
export function sourceInventory(root = ROOT, beforeBuild = false): Inventory {
  const trees = ['packages', 'apps/frontend/src', 'apps/frontend/scripts', 'apps/backend/src', 'apps/backend/scripts', 'apps/backend/tests', 'apps/backend/prisma', 'apps/ai-service', 'ml', 'tools', 'tests', 'infrastructure', '.github'];
  const top = readdirSync(root).filter(p => /^(package(?:-lock)?\.json|tsconfig.*\.json|vitest.*\.ts|\.dockerignore)$/.test(p));
  const appConfig = ['apps/frontend', 'apps/backend'].flatMap(dir => readdirSync(resolve(root, dir)).filter(p => /^(package\.json|.*config\.(?:ts|mjs|js|json)|Dockerfile)$/.test(p)).map(p => `${dir}/${p}`));
  const registry = 'security/pack-trust.production.json';
  const publicInputs = walk(root, 'apps/frontend/public', p => p !== 'apps/frontend/public/models' && sourceFilter(p));
  const names = [...trees.flatMap(p => walk(root, p, sourceFilter)), ...publicInputs, ...top, ...appConfig, ...(existsSync(resolve(root, registry)) ? [registry] : [])];
  const generated = ['apps/frontend/src/lib/brain/pack-trust.generated.json', 'apps/frontend/public/pack-trust.json', 'apps/frontend/src/lib/brain/runtime-assets.generated.json'];
  return inventory(root, beforeBuild ? names.filter(p => !generated.includes(p) && !p.startsWith('apps/frontend/public/runtime/')) : names);
}
export function verifyCheckReceipt(root: string, receipt: any): void {
  if (receipt?.schema_version !== 1 || receipt.status !== 'passed' || !['development', 'production'].includes(receipt.build_trust_mode)) throw new Error('missing successful release check receipt');
  if (receipt.source_sha256 !== sourceInventory(root).sha256) throw new Error('source changed after release checks');
  if (receipt.prebuild_source_sha256 !== sourceInventory(root, true).sha256) throw new Error('source changed during release builds');
  checkedFrontendConfig(receipt.frontend_public_config);
  if (REQUIRED_CHECKS.some(name => !receipt.checks?.some((c: any) => c.name === name && c.exit_code === 0))) throw new Error('required release check did not pass');
  if (!receipt.build_inventory) throw new Error('release receipt does not bind build outputs');
  const actual = inventory(root, buildFiles(root));
  if (JSON.stringify(actual) !== JSON.stringify(receipt.build_inventory)) throw new Error('build changed after release checks');
  const generated = readFileSync(resolve(root, 'apps/frontend/src/lib/brain/pack-trust.generated.json'), 'utf8');
  if (generated !== readFileSync(resolve(root, 'apps/frontend/public/pack-trust.json'), 'utf8') || JSON.parse(generated).mode !== receipt.build_trust_mode) throw new Error('frontend build trust does not match checked receipt');
}
function checkedFrontendConfig(value: any): { api_url: string | null; socket_url: string | null } {
  if (!value || Object.keys(value).sort().join(',') !== 'api_url,socket_url'
    || ['api_url', 'socket_url'].some(key => value[key] !== null && typeof value[key] !== 'string')) throw new Error('missing frontend public build configuration');
  return value;
}
export function buildFiles(root = ROOT): string[] {
  for (const file of ['apps/backend/dist/server.cjs', 'apps/frontend/.next/BUILD_ID', 'apps/frontend/.next/standalone/apps/frontend/server.js']) {
    if (!existsSync(resolve(root, file))) throw new Error(`required build output missing: ${file}`);
  }
  return [...walk(root, 'apps/backend/dist'), ...walk(root, 'apps/frontend/.next', p => !/(^|\/)cache(?:\/|$)/.test(p))];
}

/** Explain blockers without changing validation metadata, signatures, weights or approvals. */
export function productionBlockers(root: string, buildTrustMode: string): string[] {
  const blockers: string[] = [];
  if (buildTrustMode !== 'production') blockers.push('Frontend build uses development pack trust');
  const lock = validateArtifactLock(json(resolve(root, 'tests/models/installed-models.lock.json')));
  verifiedArtifacts(root, lock);
  const deployments = lock.files.filter(f => f.path.endsWith('.deployment.json'));
  if (!deployments.length) blockers.push('No locked movement model deployments');
  for (const entry of deployments) {
    const deployment = json(resolve(root, entry.path));
    const cardName = entry.path.replace('.deployment.json', '.model_card.json');
    const card = lock.files.some(f => f.path === cardName) ? json(resolve(root, cardName)) : null;
    if (deployment.production_eligible !== true || deployment.calibration?.status !== 'validated') blockers.push(`${entry.path}: model is provisional or calibration is unvalidated`);
    if (card?.production_eligible !== true || card?.metrics?.status !== 'validated') blockers.push(`${cardName}: independent validation is not approved`);
  }
  for (const entry of lock.files.filter(f => /\/reid\/.*\.json$/.test(f.path))) {
    const config = json(resolve(root, entry.path));
    if (config.license?.status !== 'commercial-use-approved') blockers.push(`${entry.path}: model weight licence is not cleared for production`);
  }
  const packFiles = walk(root, 'sport-packs');
  const manifests = packFiles.filter(p => p.endsWith('/manifest.json'));
  if (!manifests.length) blockers.push('No sport pack manifests');
  for (const path of manifests) {
    const manifest = json(resolve(root, path));
    if (manifest.signature?.algorithm !== 'ed25519') blockers.push(`${path}: requires production Ed25519 signature`);
  }
  for (const path of packFiles.filter(p => p.endsWith('/technique_criteria.json'))) {
    const data = json(resolve(root, path));
    const unapproved = (data.criteria ?? []).filter((c: any) => c.enabled !== false && (c.validation_status !== 'approved' || c.expert_citation?.status !== 'approved'));
    if (unapproved.length) blockers.push(`${path}: ${unapproved.length} active criteria lack coach approval`);
  }
  const readinessPath = resolve(root, 'infrastructure/release/readiness.json');
  const readiness = existsSync(readinessPath) ? json(readinessPath) : null;
  for (const id of ['athlete-held-out-evaluation', 'coach-validation', 'physical-device-validation', 'privacy-review', 'canary-and-rollback-review']) {
    const review = readiness?.schema_version === 1 ? readiness.reviews?.find((r: any) => r.id === id) : null;
    if (review?.status !== 'approved' || typeof review.reviewer !== 'string' || !review.reviewer.trim() || !/^[a-f0-9]{64}$/.test(review.evidence_sha256 ?? '')) {
      blockers.push(`${id}: reviewed evidence is pending`); continue;
    }
    try {
      if (sha(readFileSync(safeFile(root, review.evidence_path))) !== review.evidence_sha256) blockers.push(`${id}: evidence digest mismatch`);
    } catch { blockers.push(`${id}: evidence file is missing or unsafe`); }
  }
  return blockers.sort();
}

export function stageCandidate(root: string, out: string, receiptPath: string, packRoot = resolve(root, 'sport-packs')): Inventory {
  const receipt = json(receiptPath);
  verifyCheckReceipt(root, receipt);
  const lock = validateArtifactLock(json(resolve(root, 'tests/models/installed-models.lock.json')));
  verifiedArtifacts(root, lock);
  if (existsSync(out)) throw new Error('candidate destination already exists; use a new directory');
  const files = new Set([...sourceInventory(root).files.map(f => f.path), ...buildFiles(root), ...lock.files.map(f => f.path)]);
  const lockedPaths = new Set(lock.files.map(f => f.path));
  for (const name of files) {
    if (/\.(?:pt|pth|onnx|task|ckpt|safetensors|tflite|pkl)$/.test(name) && !lockedPaths.has(name)) throw new Error(`unlocked model binary in release outputs: ${name}`);
  }
  // Source files/build outputs are explicit; private media, .env files and signing keys are not release inputs.
  for (const name of files) safeFile(root, name);
  const packs = walk(packRoot);
  if (!packs.some(p => p.endsWith('/manifest.json'))) throw new Error('pack root must contain sport directories and manifests');
  if (!receipt.pack_inventory || JSON.stringify(inventory(packRoot, packs)) !== JSON.stringify(receipt.pack_inventory)) throw new Error('selected packs differ from release check inputs');
  mkdirSync(out, { recursive: true });
  for (const name of [...files].sort()) { const target = resolve(out, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(safeFile(root, name), target); }
  for (const name of packs) { const target = resolve(out, 'sport-packs', name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(safeFile(packRoot, name), target); }
  writeFileSync(resolve(out, 'release-checks.json'), JSON.stringify(receipt, null, 2) + '\n');
  const blockers = productionBlockers(out, receipt.build_trust_mode);
  writeFileSync(resolve(out, 'candidate.json'), JSON.stringify({ schema_version: 1, kind: 'engineering-release-candidate', production_eligible: false,
    build_trust_mode: receipt.build_trust_mode, frontend_public_config: receipt.frontend_public_config, source_sha256: receipt.source_sha256, model_artifact_set: lock.artifact_set, production_blockers: blockers,
    notice: 'Passing engineering checks does not establish athlete-held-out accuracy, coaching validity or physical-device readiness.' }, null, 2) + '\n');
  const result = inventory(out, walk(out));
  writeFileSync(resolve(out, 'inventory.json'), JSON.stringify(result, null, 2) + '\n');
  verifyInventory(out, result);
  return result;
}

export function verifyContainerReceipt(receipt: any, digest: string): void {
  if (receipt?.schema_version !== 1 || receipt.status !== 'passed' || receipt.inventory_sha256 !== digest) throw new Error('container build evidence does not match this candidate');
  if (['backend', 'frontend', 'ai-service'].some(name => !receipt.images?.some((image: any) => image.name === name && /^sha256:[a-f0-9]{64}$/.test(image.id)))) throw new Error('all three container image builds must pass');
}

export function buildContainers(root: string, out: string): void {
  const expected = json(resolve(root, 'inventory.json'));
  verifyInventory(root, expected);
  if (existsSync(out)) throw new Error('container receipt already exists; use a new path');
  const receiptRelative = relative(resolve(root), resolve(out));
  if (receiptRelative !== '..' && !receiptRelative.startsWith(`..${sep}`) && !isAbsolute(receiptRelative)) throw new Error('container receipt must be outside the immutable candidate');
  const receipt: any = { schema_version: 1, status: 'running', inventory_sha256: expected.sha256, images: [] };
  mkdirSync(dirname(out), { recursive: true });
  const save = () => writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
  save();
  try {
    const trust = json(resolve(root, 'apps/frontend/public/pack-trust.json'));
    const publicConfig = checkedFrontendConfig(json(resolve(root, 'candidate.json')).frontend_public_config);
    receipt.frontend_public_config = publicConfig;
    for (const name of ['backend', 'frontend', 'ai-service']) {
      const tag = `apexformz-${name}:candidate-${expected.sha256.slice(0, 12)}`;
      const args = ['build', '--file', `apps/${name}/Dockerfile`, '--tag', tag];
      if (name === 'frontend') {
        args.push('--build-arg', `NEXT_PUBLIC_PACK_TRUST_MODE=${trust.mode}`, '--build-arg', `NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON=${JSON.stringify(trust.registry)}`);
        if (publicConfig.api_url !== null) args.push('--build-arg', `NEXT_PUBLIC_API_URL=${publicConfig.api_url}`);
        if (publicConfig.socket_url !== null) args.push('--build-arg', `NEXT_PUBLIC_SOCKET_URL=${publicConfig.socket_url}`);
      }
      args.push('.');
      const build = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
      if (build.error || build.status !== 0) throw new Error(`${name} container build failed: ${build.error?.message ?? build.status}`);
      const inspect = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { cwd: root, encoding: 'utf8' });
      if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(inspect.stdout.trim())) throw new Error(`${name} image digest unavailable`);
      receipt.images.push({ name, tag, id: inspect.stdout.trim() }); save();
    }
    verifyInventory(root, expected);
    receipt.status = 'passed'; save();
  } catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : String(error); save(); throw error; }
}

export function promote(root: string, registry: string, containerReceipt?: string): void {
  verifyInventory(root, json(resolve(root, 'inventory.json')));
  verifyCheckReceipt(root, json(resolve(root, 'release-checks.json')));
  const candidate = json(resolve(root, 'candidate.json'));
  if (JSON.stringify(candidate.frontend_public_config) !== JSON.stringify(json(resolve(root, 'release-checks.json')).frontend_public_config)) throw new Error('candidate frontend configuration differs from checked build');
  const blockers = productionBlockers(root, candidate.build_trust_mode);
  try { verifyContainerReceipt(containerReceipt ? json(containerReceipt) : null, json(resolve(root, 'inventory.json')).sha256); }
  catch (error) { blockers.push(error instanceof Error ? error.message : String(error)); }
  const publicTrust = json(resolve(root, 'apps/frontend/public/pack-trust.json'));
  const canonical = (value: any): string => value && typeof value === 'object'
    ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  if (publicTrust.mode !== 'production' || publicTrust.registry_sha256 !== sha(canonical(json(registry)))) blockers.push('Built frontend trust differs from the supplied production registry');
  // Always run cryptographic production verification, even when eligibility is already blocked.
  const result = spawnSync(process.execPath, ['--import', 'tsx', resolve(ROOT, 'packages/sport-runtime/scripts/verify-release-packs.ts'), '--pack-root', resolve(root, 'sport-packs'), '--registry', resolve(registry)], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) blockers.push(`Production pack trust verification failed: ${(result.stderr || result.stdout || result.error?.message || 'unknown error').trim()}`);
  if (blockers.length) throw new Error(`Production promotion blocked:\n${blockers.map(b => `- ${b}`).join('\n')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const option = (key: string, fallback?: string) => { const i = args.indexOf(key); if (i < 0 && fallback) return resolve(fallback); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`required ${key}`); return resolve(args[i + 1]); };
    if (command === 'candidate') { const result = stageCandidate(ROOT, option('--out'), option('--checks'), option('--pack-root', 'sport-packs')); console.log(JSON.stringify({ status: 'passed', kind: 'candidate', production_eligible: false, files: result.files.length, sha256: result.sha256 })); }
    else if (command === 'verify') { const root = option('--root'); verifyInventory(root, json(resolve(root, 'inventory.json'))); console.log('Release inventory verified'); }
    else if (command === 'containers') { buildContainers(option('--root'), option('--out')); console.log('Candidate container images built locally; nothing was published'); }
    else if (command === 'promote') { promote(option('--root'), option('--registry'), args.includes('--containers') ? option('--containers') : undefined); console.log('Production gates passed; nothing was published or deployed'); }
    else throw new Error('usage: release_artifacts.ts candidate --out <new-dir> --checks <receipt> [--pack-root <packs>] | verify --root <candidate> | containers --root <candidate> --out <external-receipt> | promote --root <candidate> --registry <public-registry> --containers <receipt>');
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
