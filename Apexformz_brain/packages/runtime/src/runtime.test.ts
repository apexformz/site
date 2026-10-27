import { describe, expect, it } from 'vitest';
import { syntheticPoseFrame, type SyntheticPoseOptions } from '@apexformz/signal';
import { validate } from '@apexformz/contracts';
import { activeSession } from '../../../tests/helpers/packs';
import type { BrainRuntime, BrainTick } from './index';
import { EventOutbox } from './outbox';
import { SessionStateMachine } from './session_fsm';

const DT = 40;

function feed(rt: BrainRuntime, sessionId: string, frames: Array<{ o: SyntheticPoseOptions; count: number }>, start = 0, startFrame = 0): BrainTick[] {
  const ticks: BrainTick[] = [];
  let i = startFrame;
  let t = start;
  for (const seg of frames) {
    for (let k = 0; k < seg.count; k++) {
      const tick = rt.process(syntheticPoseFrame(i, t, seg.o, { session_id: sessionId }), t);
      if (tick) ticks.push(tick);
      i++;
      t += DT;
    }
  }
  return ticks;
}

const shootingStance: SyntheticPoseOptions = { right_arm_raise: 88, right_elbow_flexion: 5, left_arm_raise: 5, stance_width: 0.45 };

describe('BrainRuntime: shooting setup stance (static vertical slice)', () => {
  it('confirms the hold and evaluates criteria with provisional rubrics abstaining in strict mode', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', { strict_rubrics: true });
    const ticks = feed(rt, sessionId, [{ o: shootingStance, count: 60 }]);
    const confirmed = ticks.find((t) => t.temporal?.state === 'CONFIRMED');
    expect(confirmed).toBeDefined();
    const withAssessment = ticks.filter((t) => t.assessment);
    expect(withAssessment.length).toBeGreaterThan(0);
    const last = withAssessment.at(-1)!.assessment!;
    expect(validate('assessmentSet', last).ok).toBe(true);
    const byId = Object.fromEntries(last.criteria.map((c) => [c.criterion_id, c]));
    // Provisional rubric => UNCERTAIN with a filled measurement, never a definitive verdict
    expect(byId['shooting.setup_stance.shooting_elbow_extension'].state).toBe('UNCERTAIN');
    expect(byId['shooting.setup_stance.shooting_elbow_extension'].measurement.reason).toBe('RUBRIC_UNVALIDATED');
    expect(byId['shooting.setup_stance.shooting_elbow_extension'].measurement.value).not.toBeNull();
    // Equipment-dependent criterion abstains with a typed reason
    expect(byId['shooting.setup_stance.sight_alignment'].state).toBe('NOT_ASSESSABLE');
    expect(byId['shooting.setup_stance.sight_alignment'].measurement.reason).toBe('CAPABILITY_MISSING');
    expect(last.score).toBeNull();
    expect(ticks.every((t) => !t.feedback || t.feedback.kind !== 'technique_cue')).toBe(true);
  });

  it('issues a draft technique cue in development mode when a criterion persistently fails', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', { strict_rubrics: false, allow_draft_feedback: true });
    // Shoulders shift toward the raised (right) arm side so the arm elevation stays above the hold threshold.
    const ticks = feed(rt, sessionId, [{ o: { ...shootingStance, trunk_lean: -20 }, count: 90 }]);
    const assessments = ticks.filter((t) => t.assessment).map((t) => t.assessment!);
    const lean = assessments.at(-1)!.criteria.find((c) => c.criterion_id === 'shooting.setup_stance.trunk_lateral_lean')!;
    expect(lean.state).toBe('IMPROVE');
    expect(lean.provenance.provisional).toBe(true);
    expect(lean.feedback?.error_id).toBe('shooting.setup_stance.trunk_lean');
    const elbow = assessments.at(-1)!.criteria.find((c) => c.criterion_id === 'shooting.setup_stance.shooting_elbow_extension')!;
    expect(elbow.state).toBe('PASS');
    const cue = ticks.find((t) => t.feedback?.kind === 'technique_cue');
    expect(cue).toBeDefined();
    expect(cue!.feedback!.error_id).toBe('shooting.setup_stance.trunk_lean');
    expect(validate('feedbackAction', cue!.feedback).ok).toBe(true);
    expect(assessments.at(-1)!.score).not.toBeNull();
    const summary = rt.complete(5000);
    expect(summary.feedback_issued).toBeGreaterThan(0);
    expect(rt.sessionState).toBe('LOCAL_COMMITTED');
  });
});

describe('BrainRuntime: badminton lunge (dynamic vertical slice)', () => {
  const lunge = (knee: number, extra: SyntheticPoseOptions = {}): SyntheticPoseOptions => ({ right_knee_flexion: knee, right_arm_raise: 40, right_elbow_flexion: 20, ...extra });

  it('segments ready -> drive -> bottom -> recovery and assesses at completion', async () => {
    const { rt, sessionId } = await activeSession(['badminton', 'shooting'], 'badminton', 'badminton.lunge', { strict_rubrics: false, allow_draft_feedback: true, capabilities_available: ['body_pose', 'optional_implement'] });
    const ticks = feed(rt, sessionId, [
      { o: lunge(0), count: 15 },
      { o: lunge(50), count: 6 },
      { o: lunge(70), count: 10 },
      { o: lunge(0), count: 12 },
    ]);
    const states = new Set(ticks.map((t) => t.temporal?.state));
    expect(states.has('EXECUTING')).toBe(true);
    const done = ticks.find((t) => t.temporal?.completed);
    expect(done).toBeDefined();
    expect(done!.executed_pack).toEqual({ id: 'badminton', version: '1.0.0' });
    const final = done!.assessment!;
    const byId = Object.fromEntries(final.criteria.map((c) => [c.criterion_id, c]));
    expect(byId['badminton.lunge.lead_knee_depth'].state).toBe('PASS');
    // Causal filtering lags a synthetic step input slightly; the true bottom angle is 110 degrees.
    expect(Math.abs(byId['badminton.lunge.lead_knee_depth'].measurement.value! - 110)).toBeLessThan(4);
    expect(['PASS', 'IMPROVE']).toContain(byId['badminton.lunge.knee_foot_alignment'].state);
    expect(byId['badminton.lunge.recovery_time'].state).toBe('PASS');
    expect(byId['badminton.lunge.recovery_time'].measurement.unit).toBe('ms');
    // Racket contact is never observed from body pose (G07)
    expect(byId['badminton.lunge.racket_contact_height'].state).toBe('NOT_ASSESSABLE');
    expect(byId['badminton.lunge.racket_contact_height'].measurement.reason).toBe('CONTACT_UNOBSERVED');
    // Side-view-only criterion abstains from the front
    expect(byId['badminton.lunge.trunk_forward_lean'].state).toBe('NOT_ASSESSABLE');
    expect(byId['badminton.lunge.trunk_forward_lean'].measurement.reason).toBe('VIEW_INVALID');
    expect(final.coverage.omitted.length).toBeGreaterThan(0);
    expect(validate('assessmentSet', final).ok).toBe(true);
    const events = rt.drainOutbox(1000);
    expect(events.some((e) => e.event_type === 'movement.event')).toBe(true);
    expect(events.some((e) => e.event_type === 'assessment.set')).toBe(true);
    expect(events.every((e) => validate('eventEnvelope', e).ok)).toBe(true);
  });

  it('no cues during action phases; contact phase forbids cues', async () => {
    const { rt, sessionId } = await activeSession(['badminton'], 'badminton', 'badminton.lunge', { strict_rubrics: false, allow_draft_feedback: true });
    const ticks = feed(rt, sessionId, [{ o: lunge(0), count: 15 }, { o: lunge(50), count: 6 }, { o: lunge(70), count: 10 }]);
    const inAction = ticks.filter((t) => t.temporal?.phase_id === 'drive' || t.temporal?.phase_id === 'bottom');
    expect(inAction.length).toBeGreaterThan(0);
    expect(inAction.every((t) => !t.feedback || t.feedback.priority === 'setup' || t.feedback.priority === 'safety')).toBe(true);
    expect(inAction.every((t) => t.temporal!.cue_allowed === false)).toBe(true);
  });
});

describe('BrainRuntime: session state machine, slot and outbox', () => {
  it('enforces the TRD session transitions and idempotency', () => {
    const fsm = new SessionStateMachine();
    expect(() => fsm.transition('ACTIVE', 0, 'x')).toThrow(/cannot move/);
    fsm.transition('PERMISSIONS', 0, 'a');
    fsm.transition('CALIBRATING', 1, 'b');
    fsm.transition('READY', 2, 'c');
    fsm.transition('ACTIVE', 3, 'd');
    expect(fsm.transition('ACTIVE', 4, 'dup')).toBeNull();
    fsm.transition('DEGRADED', 5, 'e');
    fsm.transition('ACTIVE', 6, 'f');
    fsm.transition('COMPLETING', 7, 'g');
    fsm.transition('LOCAL_COMMITTED', 8, 'h');
    fsm.transition('SYNC_PENDING', 9, 'i');
    fsm.transition('SYNCED', 10, 'j');
    expect(fsm.transitions).toHaveLength(10);
  });

  it('keeps only the latest frame in the slot and counts discards', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance');
    rt.offer(syntheticPoseFrame(0, 0, shootingStance, { session_id: sessionId }), 0);
    rt.offer(syntheticPoseFrame(1, 40, shootingStance, { session_id: sessionId }), 1);
    rt.offer(syntheticPoseFrame(2, 80, shootingStance, { session_id: sessionId }), 2);
    const tick = rt.tick(3)!;
    expect(tick.frame_id).toBe(2);
    expect(rt.tick(4)).toBeNull();
    expect(rt.telemetry()!.discarded_frames).toBe(2);
  });

  it('goes DEGRADED on sustained poor visibility and revalidates', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', { degraded_after_ms: 200, revalidate_frames: 3 });
    const badQuality = { framing_ok: false, ambiguous_people: false, missing_joints: [27], person_count: 1 };
    let t = 0;
    for (let i = 0; i < 10; i++, t += DT) rt.process(syntheticPoseFrame(i, t, shootingStance, { session_id: sessionId, quality: badQuality }), t);
    expect(rt.sessionState).toBe('DEGRADED');
    for (let i = 10; i < 15; i++, t += DT) rt.process(syntheticPoseFrame(i, t, shootingStance, { session_id: sessionId }), t);
    expect(rt.sessionState).toBe('ACTIVE');
  });

  it('keeps frame-driven transitions ordered when pose inference finishes later than capture', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', {
      degraded_after_ms: 80, revalidate_frames: 2, telemetry_interval_ms: 0,
    });
    const badQuality = { framing_ok: false, ambiguous_people: false, missing_joints: [27], person_count: 1 };
    for (let i = 0; i < 5; i++) {
      const timestamp = 100 + i * DT;
      const frame = syntheticPoseFrame(i, timestamp, shootingStance, { session_id: sessionId, ...(i < 3 ? { quality: badQuality } : {}) });
      const tick = rt.process(frame, timestamp + 175)!;
      expect(tick.timestamp_ms).toBe(timestamp);
      expect(tick.telemetry?.monotonic_ms).toBe(timestamp);
    }
    const events = rt.drainOutbox(1000);
    expect(events.find(e => e.event_type === 'session.transition' && e.payload.to === 'DEGRADED')?.monotonic_ms).toBe(180);
    expect(events.find(e => e.event_type === 'session.transition' && e.payload.reason === 'revalidated')?.monotonic_ms).toBe(260);
    expect(events.every((e, i) => !i || e.monotonic_ms >= events[i - 1].monotonic_ms)).toBe(true);
    expect(rt.process(syntheticPoseFrame(6, 240, shootingStance, { session_id: sessionId }), 500)).toBeNull();
    expect(rt.drainOutbox(1000)).toEqual(events);
  });

  it('discards both queued and in-flight captures from before a camera-loss heartbeat', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance', { camera_lost_ms: 100, revalidate_frames: 1 });
    rt.offer(syntheticPoseFrame(0, 100, shootingStance, { session_id: sessionId }), 100);
    rt.heartbeat(700);
    expect(rt.sessionState).toBe('DEGRADED');
    expect(rt.tick(710)).toBeNull();
    expect(rt.process(syntheticPoseFrame(1, 650, shootingStance, { session_id: sessionId }), 720)).toBeNull();
    expect(rt.process(syntheticPoseFrame(2, 730, shootingStance, { session_id: sessionId }), 780)?.timestamp_ms).toBe(730);
    expect(rt.sessionState).toBe('ACTIVE');
    const events = rt.drainOutbox(1000);
    expect(events.every((e, i) => !i || e.monotonic_ms >= events[i - 1].monotonic_ms)).toBe(true);
    expect(rt.telemetry()!.discarded_frames).toBe(2);
  });

  it('bounded outbox evicts telemetry first', () => {
    const ob = new EventOutbox({ quota: 5, session_id: 's', sport_pack_id: 'p', sport_pack_version: '1', producer: 't' });
    for (let i = 0; i < 4; i++) ob.append('telemetry.sample', i, {});
    for (let i = 0; i < 4; i++) ob.append('assessment.set', i, {});
    expect(ob.size).toBe(5);
    expect(ob.drain().filter((e) => e.event_type === 'assessment.set')).toHaveLength(4);
    expect(ob.stats.evicted_critical).toBe(0);
    const ids = ob.drain(2).map((e) => e.event_id);
    ob.ack(ids);
    expect(ob.pending()).toBe(3);
  });

  it('resume after suspend resets temporal state', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance');
    feed(rt, sessionId, [{ o: shootingStance, count: 30 }]);
    rt.pause(2000);
    rt.resume(60000);
    const tick = rt.process(syntheticPoseFrame(100, 61000, shootingStance, { session_id: sessionId }), 61000)!;
    expect(['IDLE', 'CANDIDATE']).toContain(tick.temporal!.state);
    expect(tick.features.filter((f) => f.spec_id === 'body_motion').every((f) => !f.valid && f.reason === 'INSUFFICIENT_HISTORY')).toBe(true);
  });

  it('discards frames captured before a resume, so committed event clocks never run backwards', async () => {
    const { rt, sessionId } = await activeSession(['shooting'], 'shooting', 'shooting.setup_stance');
    feed(rt, sessionId, [{ o: shootingStance, count: 5 }]);
    rt.pause(2000);
    rt.resume(5000);
    // detection of a frame captured at 4900 (while paused) finishes after the resume
    expect(rt.process(syntheticPoseFrame(200, 4900, shootingStance, { session_id: sessionId }), 5050)).toBeNull();
    expect(rt.process(syntheticPoseFrame(201, 5100, shootingStance, { session_id: sessionId }), 5150)).not.toBeNull();
    const events = rt.drainOutbox(500).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    expect(events.every((e, i) => i === 0 || e.monotonic_ms >= events[i - 1].monotonic_ms)).toBe(true);
  });
});
