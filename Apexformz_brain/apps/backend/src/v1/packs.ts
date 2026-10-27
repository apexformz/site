/**
 * Sport pack distribution helpers (TRD 13 "Distribution, offline and rollback").
 * Pure functions for ETag computation and 304 decisions; file access is
 * confined to the configured packs directory and to assets the manifest lists.
 */
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { readVerifiedPackDir } from '../../../../packages/sport-runtime/src/node';

export function strongEtag(content: string | Buffer): string {
  return `"${crypto.createHash('sha256').update(content).digest('hex')}"`;
}

/** RFC 7232 If-None-Match handling for strong ETags (supports comma lists and "*"). */
export function isNotModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(etag);
}

export function packsDir(): string {
  return process.env.SPORT_PACKS_DIR ? path.resolve(process.env.SPORT_PACKS_DIR) : path.resolve(__dirname, '../../../../sport-packs');
}

const SAFE_ID = /^[a-z][a-z0-9_]*$/;
const SAFE_ASSET = /^[A-Za-z0-9_./-]+$/;

export function safeSportId(id: string): boolean {
  return SAFE_ID.test(id);
}

export async function listPacks(dir = packsDir()): Promise<Array<{ id: string; version: string; display: unknown; status?: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: Array<{ id: string; version: string; display: unknown; status?: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !SAFE_ID.test(e.name)) continue;
    try {
      const verified = await readManifest(e.name, dir);
      if (!verified) continue;
      const m = verified.manifest as Record<string, any>;
      out.push({ id: m.id, version: m.version, display: m.display, status: m.display?.status });
    } catch {
      // not a pack
    }
  }
  return out;
}

export async function readManifest(sportId: string, dir = packsDir()): Promise<{ text: string; manifest: Record<string, unknown> } | null> {
  if (!safeSportId(sportId)) return null;
  try {
    const input = await readVerifiedPackDir(path.join(dir, sportId));
    const manifest = input.manifest as Record<string, unknown>;
    if (manifest.id !== sportId) return null;
    return { text: JSON.stringify(manifest), manifest };
  } catch {
    return null;
  }
}

/** Relative asset paths the manifest declares (the only files that may be served). */
export function listedAssets(manifest: Record<string, unknown>): Set<string> {
  const keys = ['game_rules', 'court_geometry', 'equipment_catalog', 'movements', 'phase_graphs', 'technique_rubrics', 'feedback_templates', 'provenance'];
  const out = new Set<string>();
  for (const k of keys) if (typeof manifest[k] === 'string') out.add(manifest[k] as string);
  for (const m of (manifest.models as Array<{ path?: string }> | undefined) ?? []) if (typeof m.path === 'string') out.add(m.path);
  for (const k of Object.keys((manifest.asset_hashes as Record<string, string> | undefined) ?? {})) out.add(k);
  return out;
}

export function isServableAsset(manifest: Record<string, unknown>, asset: string): boolean {
  if (!SAFE_ASSET.test(asset) || asset.includes('..') || asset.startsWith('/') || asset.startsWith('./')) return false;
  return listedAssets(manifest).has(asset);
}

export async function readAsset(sportId: string, asset: string, dir = packsDir()): Promise<string | null> {
  if (!safeSportId(sportId)) return null;
  const root = path.resolve(dir, sportId);
  const full = path.resolve(root, asset);
  if (!full.startsWith(root + path.sep)) return null;
  try {
    const input = await readVerifiedPackDir(root);
    const manifest = input.manifest as Record<string, unknown>;
    if (manifest.id !== sportId || !isServableAsset(manifest, asset)) return null;
    return input.assets[asset] ?? null;
  } catch {
    return null;
  }
}
