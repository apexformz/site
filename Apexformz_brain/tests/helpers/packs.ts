/**
 * Test helpers: load sealed sport packs from disk and build runtimes.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Calibration, SessionStartRequest } from '@apexformz/contracts';
import { readPackDir } from '@apexformz/sport-runtime/node';
import { DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET, loadSportPack } from '@apexformz/sport-runtime';
import { BrainRuntime, type BrainRuntimeConfig } from '@apexformz/runtime';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKS_DIR = path.resolve(here, '../../sport-packs');
export const DEV_KEYS = { [DEV_SIGNING_KEY_ID]: DEV_SIGNING_SECRET };

export async function runtimeWithPacks(packs: string[], config: Partial<BrainRuntimeConfig> = {}, clock?: () => number): Promise<BrainRuntime> {
  const rt = new BrainRuntime({ hmac_keys: DEV_KEYS, ...config }, clock);
  for (const p of packs) {
    const bundle = await rt.installPack(await readPackDir(path.join(PACKS_DIR, p)));
    rt.activatePack(bundle.manifest.id, bundle.manifest.version);
  }
  return rt;
}

export function calibration(overrides: Partial<Calibration> = {}): Calibration {
  return {
    full_body_framing: true,
    camera_tilt_deg: 0,
    nominal_view: 'front',
    handedness: 'right',
    handedness_assumed: false,
    floor_orientation_available: false,
    scale_known: false,
    scale_marker_m: null,
    athlete_context: 'intermediate',
    ...overrides,
  };
}

export function startRequest(sessionId: string, sport: string, movement: string, cal: Calibration = calibration()): SessionStartRequest {
  return { session_id: sessionId, athlete_id: 'athlete-1', sport_pack_id: sport, sport_pack_version: '1.0.0', movement_id: movement, calibration: cal, pinned_models: [] };
}

/** Bring a runtime to ACTIVE for the given sport/movement. */
export async function activeSession(packs: string[], sport: string, movement: string, config: Partial<BrainRuntimeConfig> = {}, cal = calibration()) {
  const rt = await runtimeWithPacks(packs, config);
  rt.calibrate(cal, 0);
  const sessionId = `sess-${sport}-${movement}`;
  const ctx = rt.start(startRequest(sessionId, sport, movement, cal), 0);
  return { rt, ctx, sessionId };
}

/** Explicit fixture for the template-only fallback. Reference integration has its own tests. */
export async function activeTemplateSession(packs: string[], sport: string, movement: string, config: Partial<BrainRuntimeConfig> = {}, cal = calibration()) {
  const rt = new BrainRuntime({ hmac_keys: DEV_KEYS, ...config });
  for (const id of packs) {
    const bundle = await loadSportPack(await readPackDir(path.join(PACKS_DIR, id)), { platform: 'web', hmac_keys: DEV_KEYS });
    const referenceIds = new Set(bundle.technique_criteria.criteria.filter(c => c.evaluator.kind === 'dynamic_reference').map(c => c.criterion_id));
    bundle.technique_criteria.criteria = bundle.technique_criteria.criteria.filter(c => !referenceIds.has(c.criterion_id));
    for (const m of bundle.movement_catalog.movements) m.criteria = m.criteria.filter(c => !referenceIds.has(c));
    rt.installBundle(bundle);
    rt.activatePack(bundle.manifest.id, bundle.manifest.version);
  }
  rt.calibrate(cal, 0);
  const sessionId = `template-${sport}-${movement}`;
  const ctx = rt.start(startRequest(sessionId, sport, movement, cal), 0);
  return { rt, ctx, sessionId };
}
