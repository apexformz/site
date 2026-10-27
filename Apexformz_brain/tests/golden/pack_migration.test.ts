/**
 * Sport-pack content migration (TRD 05 "Updating sport content requires migration tests for old
 * session scoring and rule-version pinning"; TRD 11 "aggregate scores across sessions only for
 * comparable versions or recompute with an archived version").
 *
 * Two versions of one pack live side by side in a registry. A session pinned to the archived
 * version reproduces exactly the assessments it produced before the new version existed, and a
 * session on the new version carries the new rubric version in its provenance.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import type { SportPackManifest } from '@apexformz/contracts';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { computeAssetHashes, signManifestHmac, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';
import type { BrainRuntime, BrainTick } from '@apexformz/runtime';
import { calibration, PACKS_DIR, runtimeWithPacks, startRequest } from '../helpers/packs';

const DT = 40;
const DEV = { strict_rubrics: false, allow_draft_feedback: true };

function lungeFrames(rt: BrainRuntime, sessionId: string): BrainTick[] {
  const lunge = (flex: number): SyntheticPoseOptions => ({ right_knee_flexion: flex, left_knee_flexion: 10, right_elbow_flexion: 60, left_elbow_flexion: 60, stance_width: 0.9 });
  const segs: Array<[SyntheticPoseOptions, number]> = [[lunge(10), 25], [lunge(50), 8], [lunge(80), 12], [lunge(5), 30]];
  const ticks: BrainTick[] = [];
  let i = 0;
  let t = 0;
  for (const [o, n] of segs) for (let k = 0; k < n; k++, i++, t += DT) {
    const tick = rt.process(syntheticPoseFrame(i, t, o, { session_id: sessionId }), t);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

/** Deterministic digest of what a session concluded: criterion states, values and rubric provenance. */
function verdicts(ticks: BrainTick[]) {
  return ticks
    .filter((x) => x.assessment)
    .map((x) => x.assessment!.criteria.map((c) => ({ id: c.criterion_id, state: c.state, value: c.measurement.value, rubric: c.provenance.rubric, pack: c.provenance.sport_pack })));
}

async function buildNextVersion() {
  const input = await readPackDir(path.join(PACKS_DIR, 'badminton'));
  const manifest = { ...(input.manifest as SportPackManifest), version: '1.1.0' };
  const assets = { ...input.assets };
  const rubric = JSON.parse(assets[manifest.technique_rubrics]);
  rubric.rubric_version = '1.1.0';
  // Content change: tighten every range evaluator so the archived and the new rubric can disagree.
  for (const c of rubric.criteria) if (c.evaluator.kind === 'range' && Array.isArray(c.evaluator.range)) c.evaluator.range = [c.evaluator.range[0], c.evaluator.range[0] + 1e-6];
  assets[manifest.technique_rubrics] = JSON.stringify(rubric);
  const prov = JSON.parse(assets[manifest.provenance]);
  prov.version = '1.1.0';
  prov.open_items = [...(prov.open_items ?? []), 'TODO_REQUIRES_VALIDATION: migration-test variant, not for release'];
  assets[manifest.provenance] = JSON.stringify(prov);
  manifest.asset_hashes = await computeAssetHashes(assets);
  const signed = await signManifestHmac(manifest, DEV_SIGNING_KEY_ID, DEV_SIGNING_SECRET);
  return { manifest: signed, assets };
}

describe('sport pack version migration', () => {
  it('a session pinned to the archived version reproduces its assessments after a newer version is installed', async () => {
    const cal = calibration({ nominal_view: 'front' });

    // Baseline: only 1.0.0 exists.
    const before = await runtimeWithPacks(['badminton'], DEV);
    before.calibrate(cal, 0);
    before.start(startRequest('s-before', 'badminton', 'badminton.lunge', cal), 0);
    const baseline = verdicts(lungeFrames(before, 's-before'));
    expect(baseline.length).toBeGreaterThan(0);
    expect(baseline.flat().some((v) => v.state === 'PASS' || v.state === 'IMPROVE')).toBe(true);

    // Migration: 1.1.0 installed and made the default for new sessions.
    const after = await runtimeWithPacks(['badminton'], DEV);
    const next = await after.installPack(await buildNextVersion());
    after.activatePack(next.manifest.id, next.manifest.version);
    after.calibrate(cal, 0);

    // Old session scoring: explicit pin to 1.0.0 must recompute identically.
    after.start(startRequest('s-archived', 'badminton', 'badminton.lunge', cal), 0);
    const archived = lungeFrames(after, 's-archived');
    expect(archived.every((x) => x.executed_pack.version === '1.0.0')).toBe(true);
    expect(verdicts(archived)).toEqual(baseline);
    after.complete(archived[archived.length - 1].timestamp_ms + DT);

    // New session on the new version (fresh runtime, both versions installed): provenance carries the new rubric
    // and the content change is visible.
    const upgraded = await runtimeWithPacks(['badminton'], DEV);
    const next2 = await upgraded.installPack(await buildNextVersion());
    upgraded.activatePack(next2.manifest.id, next2.manifest.version);
    upgraded.calibrate(cal, 0);
    upgraded.start({ ...startRequest('s-next', 'badminton', 'badminton.lunge', cal), sport_pack_version: '1.1.0' }, 0);
    const fresh = lungeFrames(upgraded, 's-next');
    const freshVerdicts = verdicts(fresh);
    expect(fresh.every((x) => x.executed_pack.version === '1.1.0')).toBe(true);
    expect(freshVerdicts.flat().every((v) => v.rubric === '1.1.0' && v.pack === '1.1.0')).toBe(true);
    expect(freshVerdicts).not.toEqual(baseline);
  });

  it('refuses to start a session on a version that is not installed', async () => {
    const rt = await runtimeWithPacks(['badminton'], DEV);
    const cal = calibration();
    rt.calibrate(cal, 0);
    expect(() => rt.start({ ...startRequest('s-missing', 'badminton', 'badminton.lunge', cal), sport_pack_version: '9.9.9' }, 0)).toThrowError();
  });
});
