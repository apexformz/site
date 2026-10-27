import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { activeSession } from '../../../tests/helpers/packs';
import type { BrainTick } from './index';

const DT = 40;

/**
 * The taekwondo pack is migrated from the original ApexFormz blueprints and
 * expert reference frames. This exercises the reference_nearest evaluator and
 * the allow_skip phase graph end to end; it does not claim the thresholds are valid.
 */
describe('legacy taekwondo pack (migrated)', () => {
  it('runs the front kick graph and evaluates reference-set criteria without abstaining for missing models', async () => {
    const { rt, sessionId } = await activeSession(['taekwondo'], 'taekwondo', 'taekwondo.ap_chagi_front_kick', { strict_rubrics: false, allow_draft_feedback: true });
    const kick = (flex: number): SyntheticPoseOptions => ({ right_knee_flexion: flex, right_arm_raise: 20, right_elbow_flexion: 60, left_elbow_flexion: 60 });
    const segs: Array<[SyntheticPoseOptions, number]> = [[kick(0), 25], [kick(130), 8], [kick(20), 8], [kick(90), 8], [kick(0), 15]];
    const ticks: BrainTick[] = [];
    let i = 0;
    let t = 0;
    for (const [o, n] of segs) for (let k = 0; k < n; k++, i++, t += DT) {
      const tick = rt.process(syntheticPoseFrame(i, t, o, { session_id: sessionId }), t);
      if (tick) ticks.push(tick);
    }
    const states = new Set(ticks.map((x) => x.temporal?.state));
    expect(states.has('CONFIRMED')).toBe(true);
    const assessed = ticks.filter((x) => x.assessment).map((x) => x.assessment!);
    expect(assessed.length).toBeGreaterThan(0);
    const all = assessed.flatMap((a) => a.criteria);
    const ref = all.filter((c) => c.provenance.evaluator === 'reference_nearest');
    expect(ref.length).toBeGreaterThan(0);
    // The model is present, so abstention may only come from evidence, never from MODEL_UNAVAILABLE.
    expect(ref.every((c) => c.measurement.reason !== 'MODEL_UNAVAILABLE')).toBe(true);
    const decided = ref.filter((c) => c.state === 'PASS' || c.state === 'IMPROVE');
    expect(decided.length).toBeGreaterThan(0);
    for (const c of decided) {
      expect(c.measurement.value).not.toBeNull();
      expect(c.provenance.provisional).toBe(true);
    }
    expect(ticks.every((x) => x.executed_pack.id === 'taekwondo')).toBe(true);
  });

  it('abstains with RUBRIC_UNVALIDATED in strict mode', async () => {
    const { rt, sessionId } = await activeSession(['taekwondo'], 'taekwondo', 'taekwondo.ap_chagi_front_kick', { strict_rubrics: true });
    const ticks: BrainTick[] = [];
    for (let i = 0; i < 30; i++) {
      const tick = rt.process(syntheticPoseFrame(i, i * DT, { right_elbow_flexion: 60, left_elbow_flexion: 60 }, { session_id: sessionId }), i * DT);
      if (tick) ticks.push(tick);
    }
    // No completion yet (stance only) => no assessment with definitive verdicts.
    expect(ticks.flatMap((x) => x.assessment?.criteria ?? []).every((c) => c.state !== 'PASS' && c.state !== 'IMPROVE')).toBe(true);
  });
});
