import { describe, expect, it, vi } from 'vitest';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { activeTemplateSession as activeSession, calibration } from '../../../tests/helpers/packs';
import type { BrainTick } from './types';

async function replay(movement: string, pose: (i: number) => SyntheticPoseOptions, step = 200, mutate?: (frame: ReturnType<typeof syntheticPoseFrame>, i: number) => void, frameCount = 34) {
  const { rt, sessionId } = await activeSession(['squash'], 'squash', movement,
    { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true }, calibration({ athlete_context: 'unknown' }));
  const ticks: BrainTick[] = [];
  for (let i = 0; i < frameCount; i++) {
    const frame = syntheticPoseFrame(i, i * step, pose(i), { session_id: sessionId });
    mutate?.(frame, i);
    const tick = rt.process(frame, frame.timestamp_ms);
    if (tick) ticks.push(tick);
  }
  return { ticks, summary: rt.summary() };
}
const slowElbow = (i: number) => i < 7 ? 0 : i < 17 ? (i - 7) * 8 : 72;
const completed = (ticks: BrainTick[]) => ticks.find(t => t.guided_completion?.source === 'motion_bout' && t.assessment);

describe('selected dynamic motion interval coaching', () => {
  it('assesses an imperfect slow backhand without requiring high hand preparation or fast swing recognition', async () => {
    const { ticks, summary } = await replay('squash.dynamic.0040', i => ({ right_elbow_flexion: slowElbow(i) }));
    const end = completed(ticks)!;
    expect(end).toBeDefined();
    expect(ticks.some(t => t.guided_attempt?.source === 'motion_bout')).toBe(true);
    expect(end.assessment!.criteria.find(c => c.criterion_id.endsWith('.lunge_into_shot'))?.state).toBe('IMPROVE');
    expect(end.assessment!.criteria.every(c => !['equipment_dependent', 'phase_duration', 'ordering'].includes(c.provenance.evaluator))).toBe(true);
    expect(end.assessment!.score).toBeNull();
    expect(end.assessment!.execution_id).toBeNull();
    expect(end.feedback?.kind).toBe('technique_cue');
    expect(ticks.filter(t => t.guided_attempt?.source === 'motion_bout').every(t => t.feedback?.kind !== 'technique_cue')).toBe(true);
    expect(summary.executions_completed).toBe(0);
  });

  it('distinguishes adequate knee depth from the same slow attempt with straight knees', async () => {
    const { ticks } = await replay('squash.dynamic.0040', i => ({ right_elbow_flexion: slowElbow(i), left_knee_flexion: 55, right_knee_flexion: 55 }));
    const end = completed(ticks)!;
    expect(end.assessment!.criteria.find(c => c.criterion_id.endsWith('.lunge_into_shot'))?.state).toBe('PASS');
  });

  it.each(['squash.dynamic.0048', 'squash.dynamic.0038', 'squash.dynamic.0101'])('coaches the stroke portion of compound %s without counting unobserved recovery', async movement => {
    for (const bend of [0, 55]) {
      const { ticks, summary } = await replay(movement, i => ({ right_elbow_flexion: slowElbow(i), left_knee_flexion: bend, right_knee_flexion: bend }));
      const end = completed(ticks)!;
      expect(end).toBeDefined();
      expect(end.assessment!.criteria.find(c => c.criterion_id.endsWith('.lunge_into_shot'))?.state).toBe(bend ? 'PASS' : 'IMPROVE');
      expect(summary.executions_completed).toBe(0);
      expect(ticks.every(t => !t.temporal?.completed)).toBe(true);
    }
  });

  it('shows a supported peak balance error during the swing and speaks it only after settling', async () => {
    const { ticks } = await replay('squash.dynamic.0048', i => ({ right_elbow_flexion: slowElbow(i), left_knee_flexion: 55, right_knee_flexion: 55, trunk_lean: 40 }));
    const live = ticks.filter(t => t.guided_attempt?.source === 'motion_bout' && t.assessment?.criteria.some(c => c.criterion_id.endsWith('.balance') && c.state === 'IMPROVE'));
    expect(live.length).toBeGreaterThan(1);
    expect(live.every(t => t.feedback?.kind !== 'technique_cue')).toBe(true);
    const spoken = ticks.find(t => t.feedback?.criterion_id?.endsWith('.balance'))!;
    expect(spoken).toBeDefined();
    expect(spoken.guided_attempt).toBeNull();
    expect(spoken.feedback!.text).toContain('For your next attempt:');
    expect(spoken.feedback!.evidence_frame_ids.every(id => id < spoken.frame_id)).toBe(true);
  });

  it('keeps queued audio silent when arm confidence drops during motion despite a globally good pose', async () => {
    const { ticks } = await replay('squash.dynamic.0048', i => ({
      right_elbow_flexion: slowElbow(i), left_knee_flexion: 55, right_knee_flexion: 55, trunk_lean: 40,
      offset_x: i < 20 ? Math.sin(i / 2) * .12 : 0,
      visibility_overrides: i >= 13 && i < 20 ? { right_wrist: .3 } : {},
    }), 200, frame => { frame.quality.missing_joints = []; });
    const unknown = ticks.filter(t => t.frame_id >= 13 && t.frame_id < 20);
    expect(unknown.every(t => t.quality.ok && t.temporal?.cue_allowed)).toBe(true);
    expect(unknown.every(t => t.feedback === null && t.suppressed_reason === 'motion_not_settled')).toBe(true);
    const recovered = ticks.find(t => t.feedback?.criterion_id?.endsWith('.balance'))!;
    expect(recovered.frame_id).toBeGreaterThan(20);
    expect(recovered.assessment).toBeNull();
    expect(recovered.feedback!.text).toContain('For your next attempt:');
    expect(recovered.feedback!.evidence_frame_ids.every(id => id <= 12)).toBe(true);
  });

  it.each([33, 100, 200, 333])('releases supported deferred feedback after continuous stillness at %ims camera cadence', async step => {
    const { ticks } = await replay('squash.dynamic.0048', i => ({
      right_elbow_flexion: slowElbow(Math.floor(i * step / 200)), left_knee_flexion: 55, right_knee_flexion: 55, trunk_lean: 40,
    }), step, undefined, Math.ceil(6800 / step));
    const cue = ticks.find(t => t.feedback?.criterion_id?.endsWith('.balance'));
    expect(cue).toBeDefined();
    expect(cue!.feedback!.text).toContain('For your next attempt:');
    expect(cue!.guided_attempt).toBeNull();
  });

  it('does not let a corrected resting pose erase the preceding motion error', async () => {
    const { ticks } = await replay('squash.dynamic.0040', i => ({ right_elbow_flexion: slowElbow(i), left_knee_flexion: i > 19 ? 55 : 0, right_knee_flexion: i > 19 ? 55 : 0 }));
    const end = completed(ticks)!;
    const criterion = end.assessment!.criteria.find(c => c.criterion_id.endsWith('.lunge_into_shot'))!;
    expect(criterion.state).toBe('IMPROVE');
    const meta = criterion as typeof criterion & { meta: { observed_end_ms: number } };
    expect(meta.meta.observed_end_ms).toBeLessThan(end.timestamp_ms);
    expect(Math.max(...criterion.evidence.frame_ids)).toBeLessThan(end.frame_id);
  });

  it('observes a shoulder-driven arm sweep without requiring elbow extension', async () => {
    const { ticks } = await replay('squash.dynamic.0040', i => ({ right_arm_raise: i < 7 ? 0 : i < 17 ? (i - 7) * 7 : 63, right_elbow_flexion: 10 }));
    expect(ticks.some(t => t.guided_attempt?.source === 'motion_bout')).toBe(true);
    expect(completed(ticks)).toBeDefined();
  });

  it('does not label a held pose or whole-body translation as an arm-motion attempt', async () => {
    for (const pose of [() => ({}), (i: number) => ({ offset_x: Math.sin(i / 4) * 0.1 })]) {
      const { ticks } = await replay('squash.dynamic.0040', pose);
      expect(ticks.every(t => t.guided_attempt?.source !== 'motion_bout' && t.guided_completion?.source !== 'motion_bout')).toBe(true);
    }
  });

  it('can assess an observed shallow lunge turning point without asserting contact', async () => {
    const { ticks, summary } = await replay('squash.dynamic.0020', i => ({ right_knee_flexion: i < 7 ? 0 : i < 17 ? (i - 7) * 3 : 27 }));
    const end = completed(ticks)!;
    expect(end).toBeDefined();
    expect(end.assessment!.criteria.find(c => c.criterion_id.endsWith('.lead_knee_depth'))?.state).toBe('IMPROVE');
    expect(end.assessment!.criteria.every(c => c.provenance.evaluator !== 'equipment_dependent')).toBe(true);
    expect(summary.executions_completed).toBe(0);
  });

  it.each([200, 333])('grades the observed recovery endpoint at %ims cadence without requiring correct ready knees first', async step => {
    const { ticks, summary } = await replay('squash.dynamic.0014', i => ({ offset_x: i < 10 ? Math.sin(i / 2) * .12 : 0 }), step);
    const ready = ticks.filter(t => t.guided_attempt?.phase_id === 'ready' && t.assessment);
    expect(ready.length).toBeGreaterThan(0);
    expect(ready.some(t => t.assessment!.criteria.some(c => c.criterion_id.endsWith('.ready_knees') && c.state === 'IMPROVE'))).toBe(true);
    expect(ready.every(t => t.assessment!.criteria.every(c => c.provenance.evaluator !== 'phase_duration'))).toBe(true);
    expect(summary.executions_completed).toBe(0);
    const corrected = await replay('squash.dynamic.0014', i => ({ offset_x: i < 10 ? Math.sin(i / 2) * .12 : 0, left_knee_flexion: 35, right_knee_flexion: 35 }), step);
    expect(corrected.ticks.some(t => t.assessment?.criteria.some(c => c.criterion_id.endsWith('.ready_knees') && c.state === 'PASS'))).toBe(true);
  });

  it.each(['identity', 'quality', 'gap'])('does not bridge %s loss into a completed motion interval', async kind => {
    const { ticks } = await replay('squash.dynamic.0040', i => ({ right_elbow_flexion: i < 12 ? slowElbow(i) : 32 }), kind === 'gap' ? 500 : 200,
      (frame, i) => {
        if (kind === 'identity' && i >= 12) frame.tracked_subject_id = 'another-athlete';
        if (kind === 'quality' && i === 12) frame.quality.ambiguous_people = true;
      });
    expect(completed(ticks)).toBeUndefined();
  });

  it('clears prior motion evidence when a subsequent bout starts or ends under a recognized action', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.dynamic.0020',
      { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true }, calibration({ athlete_context: 'unknown' }));
    // First perform a shallow, unrecognized attempt, then a deeper sequence.
    // The second downward bout starts while the canonical graph is in drive.
    const knees = [...Array(7).fill(0), ...Array.from({ length: 10 }, (_, i) => i * 3), ...Array(12).fill(27),
      ...Array(10).fill(0), ...Array(6).fill(35), 45, 55, 65, ...Array(3).fill(65), ...Array(12).fill(0)];
    const session = (rt as unknown as { session: { motionEvaluator: { acc: { frames(phase: string): number[] } } } }).session;
    const rows = knees.map((knee, i) => {
      const tick = rt.process(syntheticPoseFrame(i, i * 200, { right_knee_flexion: knee }, { session_id: sessionId }), i * 200)!;
      return { tick, motionFrames: [...session.motionEvaluator.acc.frames('bottom')] };
    });
    expect(rows[28].tick.guided_completion?.source).toBe('motion_bout');
    expect(rows[28].motionFrames.length).toBeGreaterThan(3);
    expect(rows[46].tick.temporal?.phase_id).toBe('drive');
    expect(rows[46].tick.guided_attempt).toBeNull();
    expect(rows[46].motionFrames).toEqual([]);
    expect(rows[52].tick.temporal?.phase_id).toBe('recovery');
    expect(rows[52].tick.assessment!.criteria.every(c => c.evidence.frame_ids.every(id => id >= 47))).toBe(true);
  });

  it('gives an authored candidate fresh ownership when an inferred attempt of the same phase abstains', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.dynamic.0040',
      { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true }, calibration({ athlete_context: 'unknown' }));
    const session = (rt as unknown as { session: { guidedAttempt: BrainTick['guided_attempt']; motionObserver: { observe(...args: unknown[]): unknown } } }).session;
    // Only the optional motion observer abstains; the real pose pipeline still
    // computes the velocity that supplies the ordinary authored swing candidate.
    vi.spyOn(session.motionObserver, 'observe').mockReturnValue(null);
    let handoff: BrainTick | null = null;
    for (let i = 0; i < 40; i++) {
      session.guidedAttempt = { phase_id: 'swing', since_ms: 0, cue_allowed: false, source: 'motion_bout' };
      const elbow = i < 20 ? 0 : i < 24 ? (i - 19) * 30 : 120;
      const tick = rt.process(syntheticPoseFrame(i, i * 40, { right_elbow_flexion: elbow }, { session_id: sessionId }), i * 40)!;
      if (tick.guided_attempt?.phase_id === 'swing') { handoff = tick; break; }
    }
    expect(handoff).not.toBeNull();
    expect(handoff!.guided_attempt?.source).toBeUndefined();
    expect(handoff!.guided_attempt?.since_ms).toBe(handoff!.timestamp_ms);
  });
});
