/** Offline Ed25519 signer. Writes a NEW isolated output; never changes source packs or prints private material. */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SportPackManifest } from '@apexformz/contracts';
import { computeAssetHashes, loadSportPack } from '../src/loader';
import { listPackDirs, readPackDir } from '../src/node';
import { manifestSigningPayload, packTrustMode, trustedSigningKey, validateTrustRegistry, type PackTrustMode, type PackTrustRegistry } from '../src/trust';

export async function signReleasePacks(options: { source: string; out: string; keyId: string; privateKeyPem: string; registry: PackTrustRegistry; mode?: PackTrustMode }) {
  const mode = options.mode ?? 'production';
  if (mode === 'development') throw new Error('release signing requires production or test trust mode');
  const entry = trustedSigningKey(options.registry, options.keyId, mode);
  const privateKey = createPrivateKey(options.privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('private key must be Ed25519 PKCS#8 PEM');
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (!publicJwk.x || Buffer.from(publicJwk.x, 'base64url').toString('hex') !== entry.public_key) throw new Error('private key does not match the selected trusted public key');
  const source = await fs.realpath(options.source);
  const out = path.resolve(options.out);
  const outputParent = await fs.realpath(path.dirname(out));
  if (out === source || out.startsWith(source + path.sep) || outputParent === source || outputParent.startsWith(source + path.sep)) throw new Error('release output must be outside source packs');
  try { await fs.access(out); throw new Error('release output already exists'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const dirs = await listPackDirs(source);
  if (!dirs.length) throw new Error('no sport packs found');
  const prepared = [];
  for (const dir of dirs) {
    const input = await readPackDir(dir);
    const manifest = input.manifest as SportPackManifest;
    if (manifest.id !== path.basename(dir)) throw new Error('pack directory must match manifest id');
    manifest.asset_hashes = await computeAssetHashes(input.assets);
    const value = sign(null, Buffer.from(manifestSigningPayload(manifest, options.keyId), 'utf8'), privateKey).toString('hex');
    const signed = { ...manifest, signature: { algorithm: 'ed25519' as const, key_id: options.keyId, value } };
    await loadSportPack({ manifest: signed, assets: input.assets }, { platform: 'web', trust_mode: mode, trust_registry: options.registry });
    prepared.push({ manifest: signed, assets: input.assets });
  }
  await fs.mkdir(out);
  for (const input of prepared) {
    const packDir = path.join(out, input.manifest.id);
    await fs.mkdir(packDir);
    for (const [rel, text] of Object.entries(input.assets)) {
      const dest = path.join(packDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, text, { flag: 'wx' });
    }
    await fs.writeFile(path.join(packDir, 'manifest.json'), JSON.stringify(input.manifest, null, 2) + '\n', { flag: 'wx' });
  }
  return { status: 'verified', trust_mode: mode, production_signing: mode === 'production', key_id: entry.key_id,
    key_purpose: entry.purpose, packs: prepared.map(p => ({ id: p.manifest.id, version: p.manifest.version })), output: out,
    coaching_validation_changed: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const option = (name: string, required = true) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) { if (required) throw new Error(`required: ${name}`); return undefined; } return args[i + 1]; };
    const keyFile = option('--private-key-file', false); const keyEnv = option('--private-key-env', false);
    if (Boolean(keyFile) === Boolean(keyEnv)) throw new Error('supply exactly one private-key-file or private-key-env (environment variable name)');
    const privateKeyPem = keyFile ? await fs.readFile(keyFile, 'utf8') : process.env[keyEnv!];
    if (!privateKeyPem) throw new Error('private signing key is unavailable');
    const registry = validateTrustRegistry(JSON.parse(await fs.readFile(option('--registry')!, 'utf8')));
    const result = await signReleasePacks({ source: option('--source')!, out: option('--out')!, keyId: option('--key-id')!, privateKeyPem, registry, mode: packTrustMode(option('--trust-mode', false), true) });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error instanceof Error ? error.message : 'release signing failed'); process.exitCode = 1; }
}
