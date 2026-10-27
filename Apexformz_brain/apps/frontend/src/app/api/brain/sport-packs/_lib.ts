import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readVerifiedPackDir } from '@apexformz/sport-runtime/node';

/**
 * Server-side sport pack access for the standalone frontend. Mirrors the
 * backend `/api/v1/sport-packs` contract: only files listed in a pack's
 * manifest are ever served, with strong ETags.
 */
const ASSET_KEYS = ['game_rules', 'court_geometry', 'equipment_catalog', 'movements', 'phase_graphs', 'technique_rubrics', 'feedback_templates', 'provenance'] as const;

export function packsDir(): string {
  return process.env.SPORT_PACKS_DIR ?? path.resolve(process.cwd(), '../../sport-packs');
}

const SAFE_ID = /^[a-z][a-z0-9_]*$/;

export async function readManifest(sport: string): Promise<{ text: string; manifest: Record<string, unknown> } | null> {
  if (!SAFE_ID.test(sport)) return null;
  try {
    const input = await readVerifiedPackDir(path.join(packsDir(), sport));
    const manifest = input.manifest as Record<string, unknown>;
    if (manifest.id !== sport) return null;
    return { text: JSON.stringify(manifest), manifest };
  } catch {
    return null;
  }
}

export function listedAssets(manifest: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const k of ASSET_KEYS) if (typeof manifest[k] === 'string') out.add(manifest[k] as string);
  for (const m of (manifest.models as Array<{ path?: string }> | undefined) ?? []) if (typeof m.path === 'string') out.add(m.path);
  return out;
}

export async function readAsset(sport: string, asset: string): Promise<string | null> {
  if (!SAFE_ID.test(sport)) return null;
  if (asset.includes('..') || asset.startsWith('/') || asset.includes('\\')) return null;
  try {
    const input = await readVerifiedPackDir(path.join(packsDir(), sport));
    const manifest = input.manifest as Record<string, unknown>;
    if (manifest.id !== sport || !listedAssets(manifest).has(asset)) return null;
    return input.assets[asset] ?? null;
  } catch {
    return null;
  }
}

export function etagFor(text: string): string {
  return `"${createHash('sha256').update(text).digest('hex')}"`;
}

export function jsonResponse(req: Request, text: string): Response {
  const etag = etagFor(text);
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'private, max-age=60' } });
}

export async function listPacks(): Promise<Array<Record<string, unknown>>> {
  try {
    const entries = await fs.readdir(packsDir(), { withFileTypes: true });
    const out: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const m = await readManifest(e.name);
      if (m) out.push({ id: m.manifest.id, version: m.manifest.version, display: m.manifest.display, capabilities: m.manifest.capabilities });
    }
    return out;
  } catch {
    return [];
  }
}
