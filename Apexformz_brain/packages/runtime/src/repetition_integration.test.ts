import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame } from '@apexformz/signal';
import { activeSession } from '../../../tests/helpers/packs';

/**
 * The repetition detector is sport-agnostic: it only sees the features the pack
 * requested. A cyclic lunge should yield a period near the cycle length and a
 * monotonic repetition count, independent of phase-graph recognition.
 */
describe('runtime repetition integration', () => {
  it('reports a period and counts repetitions for a cyclic movement', async () => {
    const { rt, sessionId } = await activeSession(['badminton'], 'badminton', 'badminton.lunge', { strict_rubrics: true });
    const cycleMs = 2000;
    let last = null;
    for (let i = 0; i < 300; i++) {
      const t = i * 40;
      const phase = (t % cycleMs) / cycleMs;
      const knee = phase < 0.5 ? 70 * Math.sin(Math.PI * phase * 2) : 0; // lunge down and back within the first half
      const tick = rt.process(syntheticPoseFrame(i, t, { right_knee_flexion: Math.max(0, knee), right_arm_raise: 30 }, { session_id: sessionId }), t);
      if (tick?.repetition) last = tick.repetition;
    }
    expect(last).not.toBeNull();
    expect(last!.periodic).toBe(true);
    expect(Math.abs(last!.period_ms! - cycleMs)).toBeLessThanOrEqual(300);
    expect(last!.rep_count).toBeGreaterThanOrEqual(3);
    expect(last!.retrospective).toBe(false);
    const tel = rt.telemetry()!;
    expect(tel.stage_durations_ms['repetition_ms_ema']).toBeDefined();
  });

  it('stays silent for a still athlete', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance');
    let last = null;
    for (let i = 0; i < 120; i++) {
      const tick = rt.process(syntheticPoseFrame(i, i * 40, { right_arm_raise: 88 }, { session_id: sessionId }), i * 40);
      if (tick?.repetition) last = tick.repetition;
    }
    expect(last).not.toBeNull();
    expect(last!.periodic).toBe(false);
    expect(last!.rep_count).toBe(0);
  });
});
