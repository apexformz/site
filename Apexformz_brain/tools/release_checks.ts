/** Execute real local release checks and bind their receipt to the exact tested sources/builds. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFiles, inventory, inventoryDiff, sourceInventory, REQUIRED_CHECKS } from './release_artifacts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const i = args.indexOf('--out');
if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage: release_checks.ts --out <new-receipt.json> [--production]');
const out = resolve(args[i + 1]);
const option = (flag: string, fallback: string) => { const at = args.indexOf(flag); return resolve(at < 0 ? fallback : args[at + 1]); };
const packRoot = option('--pack-root', 'sport-packs');
const registry = option('--registry', 'security/pack-trust.production.json');
if (existsSync(out)) throw new Error('check receipt already exists; preserve it and select a new path');
if (!process.env.APEXFORMZ_TEST_DATABASE_URL) throw new Error('APEXFORMZ_TEST_DATABASE_URL is required for real isolated PostgreSQL tests');
const trust = args.includes('--production') ? 'production' : 'development';
const env: NodeJS.ProcessEnv = { ...process.env, NEXT_PUBLIC_PACK_TRUST_MODE: trust, APEXFORMZ_PACK_TRUST_MODE: 'development' };
// Explicit empty defaults retain the app's local fallback and prevent an unrecorded .env file changing these values.
env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
env.NEXT_PUBLIC_SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? '';
env.SPORT_PACKS_DIR = resolve(ROOT, 'sport-packs'); // unit/golden tests retain their explicit development fixtures
if (trust === 'production') env.NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON = readFileSync(registry, 'utf8');
const python = process.env.APEXFORMZ_RELEASE_PYTHON || 'python';
env.APEXFORMZ_PYTHON = python;
const npm = (name: string, args: string[]) => ({ name, command: 'npm', args, shell: process.platform === 'win32' });
const checks = [
  npm('prisma-generation', ['run', 'db:generate', '--workspace=apps/backend']),
  npm('backend-build', ['run', 'build:backend']),
  npm('frontend-build', ['run', 'build:frontend']),
  npm('typescript', ['run', 'typecheck']),
  npm('unit-golden-contracts', ['test']),
  trust === 'production'
    ? { name: 'pack-integrity', command: process.execPath, args: ['--import', 'tsx', 'packages/sport-runtime/scripts/verify-release-packs.ts', '--pack-root', packRoot, '--registry', registry], shell: false }
    : npm('pack-integrity', ['run', 'validate:packs']),
  npm('installed-models', ['run', 'test:models']),
  { name: 'postgres-integration', command: process.execPath, args: ['tools/test_backend_postgres.mjs'], shell: false },
  { name: 'python', command: python, args: ['-m', 'pytest', 'packages/contracts/python/tests', 'packages/perception-py/tests', 'ml/tests', 'ml/ingestion', 'apps/ai-service/tests', '-q'], shell: false },
  npm('dependency-audit', ['audit', '--audit-level=high']),
  { name: 'python-dependency-audit', command: python, args: ['-m', 'pip_audit', '--no-deps', '--disable-pip', '-r', 'apps/ai-service/requirements.lock'], shell: false },
];
const receipt: any = { schema_version: 1, status: 'running', build_trust_mode: trust,
  frontend_public_config: { api_url: env.NEXT_PUBLIC_API_URL ?? null, socket_url: env.NEXT_PUBLIC_SOCKET_URL ?? null }, checks: [] };
receipt.prebuild_source_inventory = sourceInventory(ROOT, true);
receipt.prebuild_source_sha256 = receipt.prebuild_source_inventory.sha256;
const packFiles = (directory: string, prefix = ''): string[] => readdirSync(resolve(directory, prefix), { withFileTypes: true }).flatMap(entry => {
  const name = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isSymbolicLink()) throw new Error('release packs cannot contain symlinks');
  return entry.isDirectory() ? packFiles(directory, name) : [name];
});
receipt.pack_inventory = inventory(packRoot, packFiles(packRoot));
mkdirSync(dirname(out), { recursive: true });
const save = () => writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
save();
try {
  for (const check of checks) {
    console.log(`Release check: ${check.name}`);
    // Arguments are fixed; shell is needed only for the Windows npm.cmd launcher. No secrets enter argv or the receipt.
    const checkEnv = check.name === 'frontend-build' ? { ...env, SPORT_PACKS_DIR: packRoot, APEXFORMZ_PACK_TRUST_MODE: trust, APEXFORMZ_PACK_TRUST_REGISTRY_PATH: registry } : env;
    const result = spawnSync(check.command, check.args, { cwd: ROOT, env: checkEnv, shell: check.shell, stdio: 'inherit' });
    receipt.checks.push({ name: check.name, exit_code: result.status });
    save();
    if (result.error || result.status !== 0) throw new Error(`${check.name} failed${result.error ? `: ${result.error.message}` : ''}`);
    if (check.name === 'frontend-build') {
      receipt.source_inventory = sourceInventory(ROOT);
      receipt.source_sha256 = receipt.source_inventory.sha256;
      receipt.build_inventory = inventory(ROOT, buildFiles(ROOT));
      const generated = readFileSync(resolve(ROOT, 'apps/frontend/src/lib/brain/pack-trust.generated.json'), 'utf8');
      const publicTrust = readFileSync(resolve(ROOT, 'apps/frontend/public/pack-trust.json'), 'utf8');
      if (generated !== publicTrust || JSON.parse(generated).mode !== trust) throw new Error('frontend build trust metadata mismatch');
    }
  }
  receipt.final_source_inventory = sourceInventory(ROOT);
  receipt.final_prebuild_source_inventory = sourceInventory(ROOT, true);
  receipt.source_changes = inventoryDiff(receipt.source_inventory, receipt.final_source_inventory);
  receipt.prebuild_source_changes = inventoryDiff(receipt.prebuild_source_inventory, receipt.final_prebuild_source_inventory);
  save(); // Persist exact before/after entries and differences even when a gate below fails.
  const changedPaths = (changes: ReturnType<typeof inventoryDiff>) => [...changes.added, ...changes.removed, ...changes.changed].map(file => file.path).slice(0, 20).join(', ');
  if (receipt.source_sha256 !== receipt.final_source_inventory.sha256) throw new Error(`source changed during release checks: ${changedPaths(receipt.source_changes)}`);
  if (receipt.prebuild_source_sha256 !== receipt.final_prebuild_source_inventory.sha256) throw new Error(`source changed during release builds: ${changedPaths(receipt.prebuild_source_changes)}`);
  if (JSON.stringify(receipt.pack_inventory) !== JSON.stringify(inventory(packRoot, packFiles(packRoot)))) throw new Error('packs changed during release checks');
  if (JSON.stringify(receipt.build_inventory) !== JSON.stringify(inventory(ROOT, buildFiles(ROOT)))) throw new Error('build outputs changed during release checks');
  if (REQUIRED_CHECKS.some(name => !receipt.checks.some((c: any) => c.name === name && c.exit_code === 0))) throw new Error('incomplete check run');
  receipt.status = 'passed';
  save();
  console.log(`Release checks passed: ${out}`);
} catch (error) {
  receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : String(error); save();
  console.error(receipt.error); process.exitCode = 1;
}
