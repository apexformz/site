import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { validate } from '@apexformz/contracts';
import { activeTemplateSession as activeSession } from '../../../tests/helpers/packs';
import type { BrainRuntime, BrainTick } from './index';

function feed(rt: BrainRuntime, sessionId: string, segments: Array<[SyntheticPoseOptions, number]>, first = 0): BrainTick[] {
  const ticks: BrainTick[] = [];
  let i = first;
  for (const [options, count] of segments) for (let k = 0; k < count; k++, i++) {
    const tick = rt.process(syntheticPoseFrame(i, i * 40, options, { session_id: sessionId }), i * 40);
    if (tick) ticks.push(tick);
  }
  return ticks;
}

describe('selected-drill guidance without correctness-gated entry', () => {
  it('corrects wrong ready knees after dynamic recovery without claiming the movement complete', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.dynamic.0014', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const moving: Array<[SyntheticPoseOptions, number]> = Array.from({ length: 30 }, (_, i) => [{ offset_x: Math.sin(i / 3) * 0.12 }, 1]);
    const ticks = feed(rt, sessionId, [...moving, [{}, 55]]);
    const guided = ticks.filter(t => t.guided_attempt?.phase_id === 'ready' && t.assessment);
    expect(guided.length).toBeGreaterThan(0);
    expect(guided.every(t => t.temporal?.phase_id === 'recovering' && !t.temporal.completed)).toBe(true);
    expect(guided.at(-1)!.assessment!.criteria.find(c => c.criterion_id.endsWith('.ready_knees'))?.state).toBe('IMPROVE');
    expect(guided.every(t => t.assessment!.score === null)).toBe(true);
    expect(rt.summary().executions_completed).toBe(0);
    const corrected = feed(rt, sessionId, [[{ left_knee_flexion: 35, right_knee_flexion: 35 }, 25]], 85);
    expect(corrected.some(t => t.temporal?.completed)).toBe(true);
  });
  it('corrects straight knees in an unconfirmed ready stance without inventing a repetition or score', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0001', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const ticks = feed(rt, sessionId, [[{ stance_width: 0.4 }, 110]]);
    expect(ticks.every(t => t.temporal?.state !== 'CONFIRMED')).toBe(true);
    const assessed = ticks.filter(t => t.assessment);
    expect(assessed.length).toBeGreaterThan(2);
    const knee = assessed.at(-1)!.assessment!.criteria.find(c => c.criterion_id.endsWith('.knee_flexion'))!;
    expect(knee.state).toBe('IMPROVE');
    expect(knee.provenance.provisional).toBe(true);
    expect(assessed.every(t => t.assessment!.score === null && t.assessment!.execution_id === null)).toBe(true);
    expect(assessed.every(t => validate('assessmentSet', t.assessment).ok)).toBe(true);
    expect(ticks.some(t => t.feedback?.kind === 'technique_cue')).toBe(true);
    expect(rt.summary().executions_completed).toBe(0);
  });

  it('retains reviewed-mode abstention and resets guided windows when visibility is lost', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0001', { guided_coaching: true, strict_rubrics: true });
    const ticks = feed(rt, sessionId, [[{}, 70]]);
    const assessment = ticks.find(t => t.assessment)!.assessment!;
    expect(assessment.criteria.every(c => c.state !== 'PASS' && c.state !== 'IMPROVE')).toBe(true);
    const lost = syntheticPoseFrame(70, 2800, {}, { session_id: sessionId });
    lost.quality.framing_ok = false;
    const tick = rt.process(lost, 2800)!;
    expect(tick.guided_attempt).toBeNull();
    expect(tick.assessment).toBeNull();
    const resumed = feed(rt, sessionId, [[{}, 5]], 71);
    expect(resumed[0].assessment?.criteria.every(c => c.evidence.frame_ids.every(id => id === resumed[0].frame_id))).toBe(true);
    expect(resumed[0].assessment?.criteria.every(c => c.state !== 'PASS' && c.state !== 'IMPROVE')).toBe(true);
  });

  it.each([200, 333, 500])('compares current static geometry at %ims cadence without relying on stable-motion history', async step => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0001', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const ticks: BrainTick[] = [];
    for (let i = 0; i < 30; i++) {
      // Changing position deliberately never supplies a stable hold. Its
      // visible straight knees can still be compared with the selected target.
      const tick = rt.process(syntheticPoseFrame(i, i * step, { offset_x: Math.sin(i) * .06 }, { session_id: sessionId }), i * step);
      if (tick) ticks.push(tick);
    }
    const assessed = ticks.filter(t => t.assessment);
    expect(assessed.length).toBeGreaterThan(5);
    expect(assessed.some(t => t.assessment!.criteria.some(c => c.criterion_id.endsWith('.knee_flexion') && c.state === 'IMPROVE'))).toBe(true);
    for (const tick of assessed) {
      expect(tick.assessment!.criteria.every(c => c.evidence.frame_ids.length === 1 && c.evidence.frame_ids[0] === tick.frame_id)).toBe(true);
      expect(tick.assessment!.score).toBeNull();
      expect(tick.assessment!.execution_id).toBeNull();
      expect(tick.guided_attempt).not.toBeNull();
      expect(validate('assessmentSet', tick.assessment).ok).toBe(true);
    }
    expect(rt.summary().executions_completed).toBe(0);
    expect(ticks.some(t => t.feedback?.kind === 'technique_cue')).toBe(true);
    if (step > 400) {
      expect(ticks.slice(1).every(t => t.signal.time_gap)).toBe(true);
      expect(ticks.slice(1).every(t => t.features.find(f => f.spec_id === 'body_motion')?.valid === false)).toBe(true);
    }
  });

  it('clears static snapshot evidence for identity changes and quality loss at slow cadence', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0001', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    expect(rt.process(syntheticPoseFrame(0, 0, {}, { session_id: sessionId }), 0)?.assessment).not.toBeNull();
    const changed = rt.process(syntheticPoseFrame(1, 500, {}, { session_id: sessionId, tracked_subject_id: 'other-athlete' }), 500)!;
    expect(changed.signal.track_changed).toBe(true);
    expect(changed.assessment).toBeNull();
    expect(changed.guided_attempt).toBeNull();
    const bad = syntheticPoseFrame(2, 1000, {}, { session_id: sessionId, tracked_subject_id: 'other-athlete' });
    bad.quality.ambiguous_people = true;
    const ambiguous = rt.process(bad, 1000)!;
    expect(ambiguous.assessment).toBeNull();
    expect(ambiguous.guided_attempt).toBeNull();
  });

  it('continues to reject dynamic evidence across slow-inference time gaps', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.dynamic.0014', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const ticks = Array.from({ length: 20 }, (_, i) => rt.process(syntheticPoseFrame(i, i * 500, { offset_x: Math.sin(i) * .1 }, { session_id: sessionId }), i * 500)!);
    expect(ticks.every(t => t.assessment === null && t.guided_attempt === null && t.guided_completion === null)).toBe(true);
    expect(rt.summary().executions_completed).toBe(0);
  });

  it('requires fresh repeated static faults after camera loss before speaking again', async () => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0001', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const first = rt.process(syntheticPoseFrame(0, 0, {}, { session_id: sessionId }), 0)!;
    expect(first.feedback).toBeNull();
    const returned = rt.process(syntheticPoseFrame(1, 3000, {}, { session_id: sessionId }), 3000)!;
    expect(returned.assessment).not.toBeNull();
    expect(returned.feedback).toBeNull();
    const repeated = rt.process(syntheticPoseFrame(2, 3500, {}, { session_id: sessionId }), 3500)!;
    expect(repeated.feedback?.kind).toBe('technique_cue');
    expect(repeated.assessment!.criteria.every(c => c.evidence.frame_ids.length === 1 && c.evidence.frame_ids[0] === repeated.frame_id)).toBe(true);
  });

  it.each([40, 500])('keeps quality-instruction persistence while clearing static technique evidence at %ims', async step => {
    const { rt, sessionId } = await activeSession(['squash'], 'squash', 'squash.static.0001', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const ticks: BrainTick[] = [];
    for (let i = 0; i < 30; i++) {
      const frame = syntheticPoseFrame(i, i * step, {}, { session_id: sessionId });
      frame.quality.ambiguous_people = true;
      frame.quality.person_count = 2;
      ticks.push(rt.process(frame, frame.timestamp_ms)!);
    }
    expect(ticks.every(t => t.assessment === null && t.guided_attempt === null)).toBe(true);
    expect(ticks.some(t => t.feedback?.kind === 'setup_instruction')).toBe(true);
    expect(ticks.every(t => t.feedback?.kind !== 'technique_cue')).toBe(true);
  });

  it('keeps dynamic action/contact temporal, evaluates actual phases, and does not speak during action', async () => {
    const { rt, sessionId } = await activeSession(['badminton'], 'badminton', 'badminton.lunge', { guided_coaching: true, strict_rubrics: false, allow_draft_feedback: true });
    const pose = (knee: number): SyntheticPoseOptions => ({ right_knee_flexion: knee, right_arm_raise: 40, right_elbow_flexion: 20 });
    const ticks = feed(rt, sessionId, [[pose(0), 20], [pose(50), 8], [pose(70), 25], [pose(0), 18]]);
    const action = ticks.filter(t => t.temporal?.phase_id === 'bottom' || t.temporal?.phase_id === 'drive');
    expect(action.length).toBeGreaterThan(0);
    expect(action.every(t => t.guided_attempt === null)).toBe(true);
    expect(action.some(t => t.assessment !== null)).toBe(true);
    expect(action.every(t => t.feedback?.kind !== 'technique_cue')).toBe(true);
    expect(ticks.some(t => t.temporal?.completed)).toBe(true);
  });
});
