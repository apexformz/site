/**
 * Squash sport engine: end-to-end runtime behaviour on the sealed squash pack.
 *
 * These tests exercise the pack's phase graphs and criteria with deterministic synthetic
 * geometry. They prove the engine mechanics (segmentation, abstention, capability gating,
 * strict/dev modes), not the validity of any threshold: every squash cutoff is provisional
 * until fitted on the coach-provided recordings (ml/sports/squash).
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { loadSportPack } from '@apexformz/sport-runtime';
import { readPackDir } from '@apexformz/sport-runtime/node';
import type { BrainRuntime, BrainTick } from '@apexformz/runtime';
// These fixtures exercise the authored template fallback. Recorded-reference
// integration is covered separately with recorded and controlled trajectories.
import { activeTemplateSession as activeSession, DEV_KEYS, PACKS_DIR, calibration } from '../helpers/packs';

const DT = 40;
const DEV = { strict_rubrics: false, allow_draft_feedback: true };

function feed(rt: BrainRuntime, sessionId: string, segs: Array<[SyntheticPoseOptions, number]>): BrainTick[] {
  const ticks: BrainTick[] = [];
  let i = 0;
  let t = 0;
  for (const [o, n] of segs) for (let k = 0; k < n; k++, i++, t += DT) {
    const tick = rt.process(syntheticPoseFrame(i, t, o, { session_id: sessionId }), t);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

// Soft ready stance: both knees slightly flexed, racket arm (right) held up in front.
const READY: SyntheticPoseOptions = { left_knee_flexion: 20, right_knee_flexion: 20, right_elbow_flexion: 90, left_elbow_flexion: 60, right_arm_raise: 40, stance_width: 0.45 };

describe('squash sport pack', () => {
  it('loads with WSF court geometry approved and every criterion provisional', async () => {
    const bundle = await loadSportPack(await readPackDir(path.join(PACKS_DIR, 'squash')), { platform: 'web', hmac_keys: DEV_KEYS });
    expect(bundle.manifest.id).toBe('squash');
    expect(bundle.manifest.capabilities).toEqual(expect.arrayContaining(['body_pose', 'optional_implement', 'calibrated_scale']));
    expect(bundle.court_geometry.validation_status).toBe('approved');
    const byId = Object.fromEntries(bundle.court_geometry.named_landmarks.map((l) => [l.id, l]));
    expect(byId.court_length.value_m).toBe(9.75);
    expect(byId.court_width_singles.value_m).toBe(6.4);
    expect(byId.front_wall_line_height.value_m).toBe(4.57);
    expect(byId.service_line_height.value_m).toBe(1.78);
    expect(byId.tin_height_standard.value_m).toBe(0.48);
    expect(byId.short_line_from_back_wall.value_m).toBe(4.26);
    expect(byId.service_box_side.value_m).toBe(1.6);
    // Full labeled catalog (70 static + 112 dynamic) plus the pack-defined serve and return.
    const movements = bundle.movement_catalog.movements;
    expect(movements).toHaveLength(184);
    expect(movements.filter((m) => m.type === 'static')).toHaveLength(70);
    expect(movements.filter((m) => m.data_status === 'captured')).toHaveLength(178);
    expect(movements.every((m) => m.id.startsWith('squash.') && m.review_status === 'coach_review_required' && m.family_id && m.group_id)).toBe(true);
    // Legacy seed ids remain resolvable as approved aliases.
    expect(movements.find((m) => m.aliases.some((a) => a.name === 'squash.lunge' && a.status === 'approved'))?.id).toBe('squash.dynamic.0021');
    expect(bundle.technique_criteria.criteria.every((c) => c.validation_status === 'provisional')).toBe(true);
    expect(bundle.competition_rules.rule_sets[0].rules.some((r) => r.id === 'r2_game_to_11')).toBe(true);
  });

  it('segments a lunge (ready -> drive -> bottom -> recovery) and judges knee depth in dev mode', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.lunge', DEV, calibration({ nominal_view: 'front' }));
    const lunge = (flex: number): SyntheticPoseOptions => ({ ...READY, left_knee_flexion: 10, right_knee_flexion: flex, stance_width: 0.9 });
    // ready (knee angle 170) -> drive (130) -> bottom (100, inside the 80..120 seed band) -> recovery (175)
    const ticks = feed(rt, sessionId, [[lunge(10), 25], [lunge(50), 8], [lunge(80), 12], [lunge(5), 30]]);
    const states = ticks.map((x) => x.temporal?.state);
    expect(states).toContain('CONFIRMED');
    expect(states).toContain('EXECUTING');
    const phases = new Set(ticks.map((x) => x.temporal?.phase_id).filter(Boolean));
    expect(phases.has('drive')).toBe(true);
    expect(phases.has('bottom')).toBe(true);
    const criteria = ticks.flatMap((x) => x.assessment?.criteria ?? []);
    const depth = criteria.filter((c) => c.criterion_id === 'squash.dynamic.0021.lead_knee_depth' && (c.state === 'PASS' || c.state === 'IMPROVE'));
    expect(depth.length).toBeGreaterThan(0);
    expect(depth.every((c) => c.provenance.provisional === true)).toBe(true);
    expect(depth.some((c) => c.state === 'PASS')).toBe(true);
    // Contact is never observed from body pose in squash.
    const bottom = ticks.filter((x) => x.temporal?.phase_id === 'bottom');
    expect(bottom.length).toBeGreaterThan(0);
    expect(ticks.every((x) => x.executed_pack.id === 'squash')).toBe(true);
  });

  it('runs a forehand drive graph and keeps racket-dependent criteria NOT_ASSESSABLE without an implement adapter', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.forehand_drive', DEV, calibration({ nominal_view: 'back' }));
    // Racket arm (right) rises slowly to a high preparation (elbow nearly straight, arm overhead), holds,
    // then whips through (fast elbow flexion = swing), settles (estimated contact / follow-through) and returns to ready.
    const arm = (elbow: number, raise: number, knee = 40): SyntheticPoseOptions => ({ ...READY, right_arm_raise: raise, right_elbow_flexion: elbow, right_knee_flexion: knee });
    const segs: Array<[SyntheticPoseOptions, number]> = [[READY, 30]];
    for (let k = 1; k <= 14; k++) segs.push([arm(90 - 5 * k, 40 + 8 * k), 1]); // slow raise: ~125 deg/s at the elbow, below the swing trigger
    segs.push([arm(20, 152), 15]); // preparation hold: racket hand well above the shoulder
    for (let k = 1; k <= 4; k++) segs.push([arm(20 + 25 * k, 152 - 15 * k, 55), 1]); // swing: ~625 deg/s
    segs.push([arm(120, 92, 55), 12]); // settle
    segs.push([READY, 35]);
    const ticks = feed(rt, sessionId, segs);
    const states = new Set(ticks.map((x) => x.temporal?.state));
    expect(states.has('CONFIRMED')).toBe(true);
    const phases = new Set(ticks.map((x) => x.temporal?.phase_id).filter(Boolean));
    expect(phases.has('preparation')).toBe(true);
    const criteria = ticks.flatMap((x) => x.assessment?.criteria ?? []);
    expect(criteria.length).toBeGreaterThan(0);
    const racket = criteria.filter((c) => c.criterion_id === 'squash.dynamic.0031.racket_contact_height');
    expect(racket.length).toBeGreaterThan(0);
    expect(racket.every((c) => c.state === 'NOT_ASSESSABLE' || c.state === 'NOT_APPLICABLE')).toBe(true);
    expect(racket.every((c) => c.measurement.value === null)).toBe(true);
    expect(racket.every((c) => c.measurement.reason === 'CAPABILITY_MISSING' || c.measurement.reason === 'EQUIPMENT_UNOBSERVED' || c.measurement.reason === 'CONTACT_UNOBSERVED')).toBe(true);
    // No criterion ever claims a verdict without a measured value.
    for (const c of criteria) if (c.state === 'PASS' || c.state === 'IMPROVE') expect(c.measurement.value).not.toBeNull();
  });

  it('confirms the static ready position at the T and abstains with RUBRIC_UNVALIDATED in strict mode', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.ready_position_t', { strict_rubrics: true }, calibration({ nominal_view: 'back' }));
    const ticks = feed(rt, sessionId, [[READY, 50]]);
    const states = new Set(ticks.map((x) => x.temporal?.state));
    expect(states.has('CONFIRMED') || states.has('EXECUTING')).toBe(true);
    const criteria = ticks.flatMap((x) => x.assessment?.criteria ?? []);
    expect(criteria.length).toBeGreaterThan(0);
    expect(criteria.every((c) => c.state !== 'PASS' && c.state !== 'IMPROVE')).toBe(true);
    const unvalidated = criteria.filter((c) => c.measurement.reason === 'RUBRIC_UNVALIDATED');
    expect(unvalidated.length).toBeGreaterThan(0);
    // Strict mode speaks no draft technique cue.
    const cues = ticks.flatMap((x) => x.feedback ?? []).filter((f) => f.kind === 'technique_cue');
    expect(cues).toHaveLength(0);
  });

  it('evaluates the ready stance in dev mode with handedness-resolved racket-hand height', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.ready_position_t', DEV, calibration({ nominal_view: 'back', handedness: 'right' }));
    const ticks = feed(rt, sessionId, [[READY, 50]]);
    const criteria = ticks.flatMap((x) => x.assessment?.criteria ?? []);
    const knees = criteria.filter((c) => c.criterion_id === 'squash.static.0056.knee_flexion');
    expect(knees.some((c) => c.state === 'PASS')).toBe(true);
    const racket = criteria.filter((c) => c.criterion_id === 'squash.static.0056.racket_up');
    expect(racket.some((c) => c.state === 'PASS' || c.state === 'IMPROVE')).toBe(true);
  });

  it('left-handed calibration flips the dominant-side landmarks', async () => {
    const left = await activeSession(['squash'], 'squash', 'squash.ready_position_t', DEV, calibration({ nominal_view: 'back', handedness: 'left' }));
    // Racket hand (left) hanging low, right arm up: a right-hander would PASS, a left-hander should not.
    const o: SyntheticPoseOptions = { ...READY, left_elbow_flexion: 0, left_arm_raise: 0, right_elbow_flexion: 90, right_arm_raise: 60 };
    const ticks = feed(left.rt, left.sessionId, [[o, 50]]);
    const racket = ticks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.static.0056.racket_up');
    expect(racket.length).toBeGreaterThan(0);
    expect(racket.some((c) => c.state === 'IMPROVE')).toBe(true);
  });
});

describe('squash recovery time measures the time taken to recover, not the terminal dwell', () => {
  async function lungeWithBottomFrames(bottomFrames: number) {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.lunge', DEV, calibration({ nominal_view: 'front' }));
    const lunge = (flex: number): SyntheticPoseOptions => ({ ...READY, left_knee_flexion: 10, right_knee_flexion: flex, stance_width: 0.9 });
    const ticks = feed(rt, sessionId, [[lunge(10), 25], [lunge(50), 8], [lunge(80), bottomFrames], [lunge(5), 30]]);
    const rec = ticks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.dynamic.0021.recovery_time' && c.measurement.value !== null);
    expect(rec.length).toBeGreaterThan(0);
    return rec[rec.length - 1].measurement.value as number;
  }

  it('a longer stay at the bottom yields a proportionally longer recovery measurement', async () => {
    const quick = await lungeWithBottomFrames(12);
    const slow = await lungeWithBottomFrames(30);
    expect(slow - quick).toBeGreaterThan(500); // 18 extra frames at 40 ms = 720 ms
    expect(quick).toBeGreaterThan(200);
  });

  it('strict mode withholds the provisional timing verdict (RUBRIC_UNVALIDATED) instead of passing it', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.lunge', { strict_rubrics: true }, calibration({ nominal_view: 'front' }));
    const lunge = (flex: number): SyntheticPoseOptions => ({ ...READY, left_knee_flexion: 10, right_knee_flexion: flex, stance_width: 0.9 });
    const ticks = feed(rt, sessionId, [[lunge(10), 25], [lunge(50), 8], [lunge(80), 12], [lunge(5), 30]]);
    const rec = ticks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.dynamic.0021.recovery_time');
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.every((c) => c.state !== 'PASS' && c.state !== 'IMPROVE')).toBe(true);
    expect(rec.some((c) => c.measurement.reason === 'RUBRIC_UNVALIDATED')).toBe(true);
  });
});

/**
 * Human variance (squash profile in sport-packs/squash/technique_criteria.json aggregation.human_variance):
 * small deviations are natural variation (UNCERTAIN / WITHIN_NORMAL_VARIANCE, no correction), large ones IMPROVE,
 * novices get a wider band than advanced players, repetition statistics travel with the evidence and a consistent
 * fault is corrected. The lunge bottom phase needs a knee below 125 deg, so the deviations here are "too deep"
 * (knee below the 80 deg lower bound of the seed range; band = pack tolerance 15 deg, scaled by athlete context).
 */
describe('squash human variance profile', () => {
  const depthAt = async (bottomFlex: number, context: 'novice' | 'intermediate' | 'advanced' = 'intermediate') => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.lunge', DEV, calibration({ nominal_view: 'front', athlete_context: context }));
    const lunge = (flex: number): SyntheticPoseOptions => ({ ...READY, left_knee_flexion: 10, right_knee_flexion: flex, stance_width: 0.9 });
    const ticks = feed(rt, sessionId, [[lunge(10), 25], [lunge(50), 8], [lunge(bottomFlex), 12], [lunge(5), 30]]);
    const depth = ticks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.dynamic.0021.lead_knee_depth' && c.measurement.value !== null);
    expect(depth.length).toBeGreaterThan(0);
    return depth[depth.length - 1];
  };

  it('a few degrees past the limit is within normal variance: measured, not corrected', async () => {
    const c = await depthAt(110); // knee ~70 deg: 10 deg below the 80 deg bound, inside the 15 deg band
    expect(c.measurement.value).toBeLessThan(80);
    expect(c.state).toBe('UNCERTAIN');
    expect(c.measurement.reason).toBe('WITHIN_NORMAL_VARIANCE');
    expect(c.feedback).toBeNull();
    const meta = (c as unknown as { meta: { variance: { zone: string; band: number } } }).meta;
    expect(meta.variance.zone).toBe('within_variance');
    expect(meta.variance.band).toBeGreaterThanOrEqual(15);
  });

  it('a clearly excessive deviation is still corrected', async () => {
    const c = await depthAt(125); // knee ~55 deg: 25 deg past the bound, beyond the band
    expect(c.measurement.value).toBeLessThan(65);
    expect(c.state).toBe('IMPROVE');
    expect(c.feedback?.error_id).toBe('squash.cue.lead_knee_depth');
  });

  it('novices get a wider band than advanced players for the same deviation', async () => {
    const novice = await depthAt(122, 'novice'); // Inside the novice band (15 x 1.5).
    const advanced = await depthAt(122, 'advanced'); // Outside the advanced band, clamped at the declared 15 deg tolerance.
    expect(novice.state).toBe('UNCERTAIN');
    expect(novice.measurement.reason).toBe('WITHIN_NORMAL_VARIANCE');
    expect(advanced.state).toBe('IMPROVE');
  });

  it('repetition statistics travel with the evidence and a consistent fault is corrected every time', async () => {
    const rep = (bottomFlex: number): Array<[SyntheticPoseOptions, number]> => {
      const lunge = (flex: number): SyntheticPoseOptions => ({ ...READY, left_knee_flexion: 10, right_knee_flexion: flex, stance_width: 0.9 });
      return [[lunge(10), 20], [lunge(50), 6], [lunge(bottomFlex), 10], [lunge(5), 25]];
    };
    const good = await activeSession(['squash'], 'squash', 'squash.lunge', DEV, calibration({ nominal_view: 'front' }));
    const goodTicks = feed(good.rt, good.sessionId, [...rep(80), ...rep(84), ...rep(76), ...rep(82)]);
    const goodDepth = goodTicks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.dynamic.0021.lead_knee_depth' && c.measurement.value !== null);
    const lastGood = goodDepth[goodDepth.length - 1] as unknown as { state: string; meta: { repetitions: { reps: number; fail_fraction: number; sd: number } } };
    expect(lastGood.state).toBe('PASS');
    expect(lastGood.meta.repetitions.reps).toBeGreaterThanOrEqual(3);
    expect(lastGood.meta.repetitions.fail_fraction).toBe(0);
    expect(lastGood.meta.repetitions.sd).toBeGreaterThan(0);

    const bad = await activeSession(['squash'], 'squash', 'squash.lunge', DEV, calibration({ nominal_view: 'front' }));
    const badTicks = feed(bad.rt, bad.sessionId, [...rep(125), ...rep(127), ...rep(123), ...rep(125)]);
    const badDepth = badTicks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.dynamic.0021.lead_knee_depth' && c.measurement.value !== null);
    const lastBad = badDepth[badDepth.length - 1] as unknown as { state: string; meta: { repetitions: { fail_fraction: number } } };
    expect(lastBad.state).toBe('IMPROVE');
    expect(lastBad.meta.repetitions.fail_fraction).toBe(1);
  });

  it('a new large error cannot inflate its own variance after three repeatable passing executions', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.lunge', DEV, calibration({ nominal_view: 'front' }));
    const rep = (flex: number): Array<[SyntheticPoseOptions, number]> => {
      const pose = (knee: number): SyntheticPoseOptions => ({ ...READY, left_knee_flexion: 10, right_knee_flexion: knee, stance_width: 0.9 });
      return [[pose(10), 20], [pose(50), 6], [pose(flex), 10], [pose(5), 25]];
    };
    const ticks = feed(rt, sessionId, [...rep(80), ...rep(80), ...rep(80), ...rep(125)]);
    const last = ticks.flatMap((x) => x.assessment?.criteria ?? [])
      .filter((c) => c.criterion_id === 'squash.dynamic.0021.lead_knee_depth' && c.measurement.value !== null).at(-1)!;
    expect(last.measurement.value).toBeLessThan(65);
    expect(last.state).toBe('IMPROVE');
    expect(last.measurement.reason).toBeNull();
  });
});

describe('squash movement taxonomy (family -> group -> movement)', () => {
  it('places every movement in exactly one group of a same-type family, with measured evidence', async () => {
    const bundle = await loadSportPack(await readPackDir(path.join(PACKS_DIR, 'squash')), { platform: 'web', hmac_keys: DEV_KEYS });
    const tax = bundle.movement_catalog.taxonomy!;
    expect(tax).toBeDefined();
    expect(tax.levels).toEqual(['family', 'group', 'movement']);
    expect(tax.validation_status).toBe('provisional');
    const byId = new Map(bundle.movement_catalog.movements.map((m) => [m.id, m]));
    const seen = new Set<string>();
    for (const f of tax.families) {
      expect(f.groups.length).toBeGreaterThan(0);
      for (const g of f.groups) for (const mid of g.members) {
        expect(seen.has(mid)).toBe(false);
        seen.add(mid);
        const m = byId.get(mid)!;
        expect(m.type).toBe(f.type);
        expect(m.family_id).toBe(f.id);
        expect(m.group_id).toBe(g.id);
      }
    }
    expect(seen.size).toBe(byId.size);
    const measured = tax.families.filter((f) => (f.evidence as { pose_cohesion_ratio?: number } | undefined)?.pose_cohesion_ratio !== undefined);
    expect(measured.length).toBeGreaterThanOrEqual(10);
    // Forehand and backhand strokes form separate families in the data.
    const familyOf = (id: string) => byId.get(id)!.family_id;
    expect(familyOf('squash.dynamic.0031')).toBe(familyOf('squash.dynamic.0030')); // forehand drive ~ forehand swing
    expect(familyOf('squash.dynamic.0041')).toBe(familyOf('squash.dynamic.0040')); // backhand drive ~ backhand swing
    expect(familyOf('squash.dynamic.0031')).not.toBe(familyOf('squash.dynamic.0041'));
    // Hard-negative edges come from the same group and from measured pose neighbours.
    const fhDrive = byId.get('squash.dynamic.0031')!;
    expect(fhDrive.similar.some((e) => e.relation.includes('same_group'))).toBe(true);
    expect(fhDrive.similar.some((e) => e.relation.startsWith('pose_neighbour'))).toBe(true);
  });

  it('every static movement with recordings carries an expert reference posture criterion', async () => {
    const bundle = await loadSportPack(await readPackDir(path.join(PACKS_DIR, 'squash')), { platform: 'web', hmac_keys: DEV_KEYS });
    const refs = bundle.manifest.models.filter((m) => m.role === 'reference_set');
    expect(refs.length).toBeGreaterThanOrEqual(60);
    const crit = bundle.technique_criteria.criteria.find((c) => c.criterion_id === 'squash.static.0056.expert_reference')!;
    expect(crit.evaluator.kind).toBe('reference_nearest');
    expect(bundle.models?.[crit.evaluator.model_reference!]).toBeDefined();
  });

  it('withholds dominant-side reference assessment while source handedness remains unknown', async () => {
    const { rt, ctx, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0056', DEV, calibration({ nominal_view: 'front' }));
    // Explicit test fixture: the real dataset can acquire reviewed handedness later.
    const criterion = ctx.criteria.find((c) => c.evaluator.kind === 'reference_nearest')!;
    const model = ctx.pack.models![criterion.evaluator.model_reference!] as { reference_vectors: unknown[]; reference_handedness: string[] };
    model.reference_handedness = model.reference_vectors.map(() => 'unknown');
    const ticks = feed(rt, sessionId, [[READY, 50]]);
    const ref = ticks.flatMap((x) => x.assessment?.criteria ?? []).filter((c) => c.criterion_id === 'squash.static.0056.expert_reference');
    expect(ref.length).toBeGreaterThan(0);
    expect(ref.every((c) => c.measurement.reason === 'HANDEDNESS_UNKNOWN')).toBe(true);
    expect(ref.every((c) => c.measurement.value === null && c.score === null)).toBe(true);
  });

  it('runs a court-travel movement through ready -> travel -> settle', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.dynamic.0003', DEV, calibration({ nominal_view: 'front' })); // lateral movement
    const segs: Array<[SyntheticPoseOptions, number]> = [[READY, 25]];
    for (let k = 0; k <= 20; k++) segs.push([{ ...READY, offset_x: -0.25 + k * 0.025 }, 1]); // sideways travel across the image
    segs.push([{ ...READY, offset_x: 0.25 }, 40]);
    const ticks = feed(rt, sessionId, segs);
    const phases = new Set(ticks.map((x) => x.temporal?.phase_id).filter(Boolean));
    expect(phases.has('move')).toBe(true);
    expect(phases.has('settle')).toBe(true);
    const criteria = ticks.flatMap((x) => x.assessment?.criteria ?? []);
    expect(criteria.some((c) => c.criterion_id === 'squash.dynamic.0003.stay_low_moving')).toBe(true);
  });
});
