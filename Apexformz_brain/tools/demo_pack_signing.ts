/** Offline interoperability demonstration. The test private key exists only in process memory. */
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function main() {
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'data/audit/signing-demo-20261026'));
await fs.mkdir(out); // new evidence directory only; never replaces prior evidence
const { privateKey } = generateKeyPairSync('ed25519');
const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
const keyId = 'ephemeral-demo-test-only';
const registry = { schema_version: '1.0.0', keys: [{ key_id: keyId, algorithm: 'ed25519', public_key: Buffer.from(jwk.x!, 'base64url').toString('hex'), status: 'active', purpose: 'test' }] };
const registryPath = path.join(out, 'public-registry.json');
await fs.writeFile(registryPath, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx' });
const source = path.join(root, 'sport-packs');
const signed = path.join(out, 'signed-packs');
const sourceHashes: Record<string, string> = {};
for (const entry of await fs.readdir(source, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
  const filename = path.join(source, entry.name, 'manifest.json');
  try { sourceHashes[entry.name] = createHash('sha256').update(await fs.readFile(filename)).digest('hex'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const runNode = (script: string, args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, ['--import', 'tsx', path.join(root, script), ...args], { cwd: root, env, encoding: 'utf8' });
const signing = runNode('packages/sport-runtime/scripts/sign-release-packs.ts', ['--source', source, '--out', signed, '--registry', registryPath, '--key-id', keyId, '--private-key-env', 'APEXFORMZ_EPHEMERAL_TEST_KEY', '--trust-mode', 'test'],
  { ...process.env, APEXFORMZ_EPHEMERAL_TEST_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
if (signing.status !== 0) throw new Error(`test signing failed: ${signing.stderr || signing.error?.message}`);
const verifyArgs = ['--pack-root', signed, '--registry', registryPath];
const nodeVerification = runNode('packages/sport-runtime/scripts/verify-release-packs.ts', [...verifyArgs, '--trust-mode', 'test']);
if (nodeVerification.status !== 0) throw new Error(`Node test verification failed: ${nodeVerification.stderr}`);
const productionRejection = runNode('packages/sport-runtime/scripts/verify-release-packs.ts', verifyArgs);
if (productionRejection.status === 0 || !productionRejection.stderr.includes('test signing keys')) throw new Error('production policy failed to reject demo key');
const python = process.env.PYTHON ?? (process.platform === 'win32' ? path.join(root, '.venv/Scripts/python.exe') : 'python3');
const pythonCode = `import json,os\nfrom app.brain.packs import list_packs,load_pack,PackError\npacks=list_packs()\nassert len(packs)==${Object.keys(sourceHashes).length}\nfor p in packs: load_pack(p['id'])\ntry:\n load_pack(packs[0]['id'],trust_mode='production')\n raise AssertionError('production accepted a test key')\nexcept PackError as e:\n assert e.code=='SIGNATURE_INVALID' and 'test signing keys' in str(e)\nprint(json.dumps({'status':'verified','trust_mode':'test','packs':len(packs),'production_test_key_rejected':True}))`;
const pythonVerification = spawnSync(python, ['-c', pythonCode], { cwd: root, encoding: 'utf8', env: { ...process.env,
  PYTHONPATH: [path.join(root, 'apps/ai-service'), path.join(root, 'packages/contracts/python')].join(path.delimiter),
  SPORT_PACKS_DIR: signed, APEXFORMZ_PACK_TRUST_MODE: 'test', APEXFORMZ_PACK_TRUST_REGISTRY_PATH: registryPath, APEXFORMZ_PACK_TRUST_REGISTRY_JSON: '' } });
if (pythonVerification.status !== 0) throw new Error(`Python test verification failed: ${pythonVerification.stderr || pythonVerification.error?.message}`);
for (const [name, expected] of Object.entries(sourceHashes)) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(source, name, 'manifest.json'))).digest('hex');
  if (actual !== expected) throw new Error('source pack changed during signing demonstration');
}
const report = { schema_version: 1, status: 'passed', test_only: true, production_eligible: false, private_key_persisted: false,
  source_manifest_sha256: sourceHashes, signing: JSON.parse(signing.stdout.trim()), node_verification: JSON.parse(nodeVerification.stdout.trim()),
  python_verification: JSON.parse(pythonVerification.stdout.trim()), production_rejection: productionRejection.stderr.trim(), public_registry: registryPath };
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'passed', packs: Object.keys(sourceHashes).length, languages: ['TypeScript', 'Python'], test_only: true, private_key_persisted: false, report: path.join(out, 'report.json') }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'test signing demonstration failed'); process.exitCode = 1; });
