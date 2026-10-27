/**
 * Node-only helpers for reading sport packs from disk. Never import this from
 * browser code; the browser receives packs through the manifest endpoint.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assertValid, type SportPackManifest } from '@apexformz/contracts';
import { computeAssetHashes, loadSportPack, signManifestHmac, type LoadOptions, type SportPackInput } from './loader';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from './dev_keys';
import { packTrustMode, validateTrustRegistry } from './trust';

const ASSET_KEYS = ['game_rules', 'court_geometry', 'equipment_catalog', 'movements', 'phase_graphs', 'technique_rubrics', 'feedback_templates', 'provenance'] as const;

export async function readPackDir(dir: string): Promise<SportPackInput> {
  const manifestText = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
  const manifest = assertValid<SportPackManifest>('sportPackManifest', JSON.parse(manifestText));
  const assets: Record<string, string> = {};
  const paths = new Set<string>();
  for (const k of ASSET_KEYS) if (typeof manifest[k] === 'string') paths.add(manifest[k]);
  for (const m of manifest.models ?? []) if (m.format === 'json') paths.add(m.path);
  for (const p of Object.keys(manifest.asset_hashes)) paths.add(p);
  for (const p of paths) assets[p] = await fs.readFile(await safePackAssetPath(dir, p), 'utf8');
  return { manifest, assets };
}

/** Pack paths may never read outside their own directory, including via a symlink. */
export async function safePackAssetPath(dir: string, relativePath: string): Promise<string> {
  if (!/^[A-Za-z0-9_./-]+$/.test(relativePath) || relativePath.startsWith('/') || relativePath.split('/').some(p => p === '..' || p === '.' || !p)) throw new Error('unsafe pack asset path');
  const root = await fs.realpath(dir);
  const full = await fs.realpath(path.resolve(dir, relativePath));
  if (!full.startsWith(root + path.sep) || !(await fs.stat(full)).isFile()) throw new Error('pack asset escapes its directory');
  return full;
}

/** Public roots are provisioned independently from packs; no pack-provided key is trusted. */
export async function packLoadOptionsFromEnv(env: Record<string, string | undefined> = process.env): Promise<LoadOptions> {
  const mode = packTrustMode(env.APEXFORMZ_PACK_TRUST_MODE, env.NODE_ENV === 'production' || env.APEXFORMZ_ENV === 'production');
  if (env.APEXFORMZ_PACK_TRUST_REGISTRY_PATH && env.APEXFORMZ_PACK_TRUST_REGISTRY_JSON) throw new Error('configure exactly one pack trust registry source');
  const raw = env.APEXFORMZ_PACK_TRUST_REGISTRY_PATH ? await fs.readFile(env.APEXFORMZ_PACK_TRUST_REGISTRY_PATH, 'utf8') : env.APEXFORMZ_PACK_TRUST_REGISTRY_JSON;
  if (mode !== 'development' && !raw) throw new Error('production/test pack trust requires an independent public-key registry');
  return { platform: 'web', trust_mode: mode, trust_registry: raw ? validateTrustRegistry(JSON.parse(raw)) : undefined,
    hmac_keys: mode === 'development' ? { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET } : undefined, allow_unsigned: false };
}

export async function readVerifiedPackDir(dir: string, options?: LoadOptions): Promise<SportPackInput> {
  const input = await readPackDir(dir);
  await loadSportPack(input, options ?? await packLoadOptionsFromEnv());
  return input;
}

/** Compute digests and sign the manifest with the dev HMAC key; writes manifest.json back. */
export async function sealPackDir(dir: string, keyId = DEV_SIGNING_KEY_ID, secret = DEV_SIGNING_SECRET): Promise<SportPackManifest> {
  const input = await readPackDir(dir);
  const manifest = input.manifest as SportPackManifest;
  manifest.asset_hashes = await computeAssetHashes(input.assets);
  const signed = await signManifestHmac(manifest, keyId, secret);
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(signed, null, 2) + '\n', 'utf8');
  return signed;
}

export async function listPackDirs(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    try {
      await fs.access(path.join(root, e.name, 'manifest.json'));
      out.push(path.join(root, e.name));
    } catch {
      // not a pack
    }
  }
  return out.sort();
}
