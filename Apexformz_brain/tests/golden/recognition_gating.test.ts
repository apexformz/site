/**
 * Recognition-gated coaching (squash pack): technique cues pause while a validated recognizer confidently places
 * the athlete in a different taxonomy family from the selected drill. Off by default; provisional recognition never
 * gates coaching.
 */
import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import type { BrainRuntime, BrainTick, RecognitionContext } from '@apexformz/runtime';
import { activeSession, calibration } from '../helpers/packs';
import squashCatalog from '../../sport-packs/squash/movement_catalog.json';

const DT = 40;
const DEV = { strict_rubrics: false, allow_draft_feedback: true };
// Nearly straight knees (176 deg) at the T: beyond the variance band of the knee criterion, so a draft technique cue is due in dev mode.
const STRAIGHT: SyntheticPoseOptions = { left_knee_flexion: 4, right_knee_flexion: 4, right_elbow_flexion: 90, left_elbow_flexion: 60, right_arm_raise: 40, stance_width: 0.45 };

function run(rt: BrainRuntime, sessionId: string, note?: (t: number) => RecognitionContext | null): BrainTick[] {
  const ticks: BrainTick[] = [];
  for (let i = 0; i < 220; i++) {
    const t = i * DT;
    const r = note?.(t);
    if (r) rt.noteRecognition(r);
    const tick = rt.process(syntheticPoseFrame(i, t, STRAIGHT, { session_id: sessionId }), t);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

const otherFamily = (t: number, validated = true, probability = 0.95): RecognitionContext => ({
  timestamp_ms: t, level: 'family', family_id: 'squash.family.dynamic.forehand_strokes', group_id: null, movement_id: null, probability, validated,
});

describe('recognition-gated coaching', () => {
  it('without gating, technique cues are issued as before', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0056', DEV, calibration({ nominal_view: 'front' }));
    const cues = run(rt, sessionId, otherFamily).filter((x) => x.feedback?.kind === 'technique_cue');
    expect(cues.length).toBeGreaterThan(0);
  });

  it('pauses technique cues and explains why when a validated recognizer reports another family', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0056', { ...DEV, recognition_gating: { enabled: true } }, calibration({ nominal_view: 'front' }));
    const ticks = run(rt, sessionId, otherFamily);
    expect(ticks.filter((x) => x.feedback?.kind === 'technique_cue')).toHaveLength(0);
    const instructions = ticks.filter((x) => x.feedback && x.feedback.kind !== 'technique_cue' && x.feedback.kind !== 'positive_reinforcement');
    expect(instructions.length).toBeGreaterThan(0);
    // Measurements continue: the knee criterion is still evaluated.
    expect(ticks.flatMap((x) => x.assessment?.criteria ?? []).some((c) => c.criterion_id === 'squash.static.0056.knee_flexion' && c.measurement.value !== null)).toBe(true);
  });

  it('ignores provisional, stale, low-confidence or same-family recognition', async () => {
    const cfg = { ...DEV, recognition_gating: { enabled: true } };
    const cases: Array<(t: number) => RecognitionContext | null> = [
      (t) => otherFamily(t, false), // provisional
      (t) => otherFamily(t, true, 0.5), // not confident
      () => otherFamily(0), // stale after the first frames
      (t) => ({ ...otherFamily(t), family_id: squashCatalog.movements.find((m) => m.id === 'squash.static.0056')!.family_id }), // current family of the unchanged exact drill
    ];
    for (const note of cases) {
      const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0056', cfg, calibration({ nominal_view: 'front' }));
      const cues = run(rt, sessionId, note).filter((x) => x.feedback?.kind === 'technique_cue');
      expect(cues.length).toBeGreaterThan(0);
    }
  });
});
