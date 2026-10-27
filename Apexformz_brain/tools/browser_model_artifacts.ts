/** Verify/export/restore the exact development model installation without network access. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ModelArtifactLock {
  schema_version: 1;
  artifact_set: string;
  files: { path: string; sha256: string; bytes: number }[];
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = resolve(ROOT, 'tests/models/installed-models.lock.json');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function within(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`artifact path escapes root: ${path}`);
}

function artifactPath(root: string, path: string): string {
  if (!/^apps\/frontend\/public\/models\/[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(p => p === '..' || p === '.')) {
    throw new Error(`unsafe artifact path: ${path}`);
  }
  const target = resolve(root, path);
  within(resolve(root), target);
  // Existing paths, including output parents, must resolve beneath the selected root.
  let ancestor = target;
  while (!existsSync(ancestor) && ancestor !== dirname(ancestor)) ancestor = dirname(ancestor);
  const realRoot = realpathSync(root);
  within(realRoot, realpathSync(ancestor));
  if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`artifact is not a regular file: ${path}`);
  return target;
}

export function validateArtifactLock(value: unknown): ModelArtifactLock {
  const lock = value as ModelArtifactLock;
  if (lock?.schema_version !== 1 || !lock.artifact_set || !Array.isArray(lock.files) || !lock.files.length) throw new Error('invalid model artifact lock');
  const paths = new Set<string>();
  for (const f of lock.files) {
    if (!f || typeof f.path !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || paths.has(f.path)) throw new Error('invalid or duplicate model artifact entry');
    if (!/^apps\/frontend\/public\/models\/[a-zA-Z0-9_./-]+$/.test(f.path) || f.path.split('/').some(p => p === '..' || p === '.')) throw new Error(`unsafe artifact path: ${f.path}`);
    paths.add(f.path);
  }
  return lock;
}

export function readArtifactLock(): ModelArtifactLock {
  return validateArtifactLock(JSON.parse(readFileSync(LOCK_PATH, 'utf8')));
}

/** All bytes are checked before restore writes anything. Missing/corrupt files always fail. */
export function verifiedArtifacts(root = ROOT, lock = readArtifactLock()): Map<string, Buffer> {
  validateArtifactLock(lock);
  const result = new Map<string, Buffer>();
  for (const entry of lock.files) {
    const path = artifactPath(root, entry.path);
    if (!existsSync(path)) throw new Error(`missing model artifact: ${entry.path}; restore a matching bundle with npm run models:restore -- --from <bundle>`);
    const bytes = readFileSync(path);
    if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`model artifact SHA-256/size mismatch: ${entry.path}`);
    result.set(entry.path, bytes);
  }
  return result;
}

export function exportArtifacts(out: string, root = ROOT, lock = readArtifactLock()): void {
  const files = verifiedArtifacts(root, lock);
  if (existsSync(out)) throw new Error(`bundle destination already exists: ${out}`);
  mkdirSync(out); // explicit new bundle; its parent must already exist
  for (const [path, bytes] of files) {
    const dest = resolve(out, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes, { flag: 'wx' });
  }
  writeFileSync(resolve(out, 'installed-models.lock.json'), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
}

export function restoreArtifacts(from: string, root = ROOT, replace = false, lock = readArtifactLock()): void {
  const bundleLock = validateArtifactLock(JSON.parse(readFileSync(resolve(from, 'installed-models.lock.json'), 'utf8')));
  if (JSON.stringify(bundleLock) !== JSON.stringify(lock)) throw new Error('bundle lock differs from this checkout; use the matching source revision');
  const files = verifiedArtifacts(from, lock);
  const writes: { path: string; bytes: Buffer; exists: boolean }[] = [];
  for (const [path, bytes] of files) {
    const dest = artifactPath(root, path);
    const exists = existsSync(dest);
    if (exists && hash(readFileSync(dest)) === hash(bytes)) continue;
    if (exists && !replace) throw new Error(`refusing to overwrite different artifact: ${path}; use --replace only for an intentional restore`);
    writes.push({ path: dest, bytes, exists });
  }
  for (const entry of writes) {
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, entry.bytes, { flag: entry.exists ? 'w' : 'wx' });
  }
  verifiedArtifacts(root, lock);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    const option = (key: string) => {
      const i = args.indexOf(key);
      if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`required option: ${key} <directory>`);
      return resolve(args[i + 1]);
    };
    const root = args.includes('--root') ? option('--root') : ROOT;
    if (command === 'verify') verifiedArtifacts(root);
    else if (command === 'export') exportArtifacts(option('--out'), root);
    else if (command === 'restore') restoreArtifacts(option('--from'), root, args.includes('--replace'));
    else throw new Error('usage: browser_model_artifacts.ts verify|export --out <new-dir>|restore --from <bundle> [--replace] [--root <checkout>]');
    const lock = readArtifactLock();
    console.log(JSON.stringify({ status: 'passed', command, artifact_set: lock.artifact_set, files: lock.files.length }));
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
