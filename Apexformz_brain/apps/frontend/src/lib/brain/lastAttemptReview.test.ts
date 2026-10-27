import { describe, expect, it } from 'vitest';
import type { AssessmentSet } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import { updateLastAttemptReview, visibleLastAttemptReview } from './lastAttemptReview';

const context = { live: true, sessionId: 'session', movementId: 'swing' };
const assessment = { session_id: 'session', event_id: 'review', movement_id: 'swing', phase_id: 'action', timestamp_ms: 1000, retrospective: false,
  criteria: [{ meta: { assessment_source: 'guided_attempt_completed' }, state: 'IMPROVE' }] } as unknown as AssessmentSet;
const completed = { timestamp_ms: 1000, quality: { ok: true, reasons: [] }, signal: { track_changed: false, time_gap: false }, assessment,
  guided_completion: { phase_id: 'action', since_ms: 100, ended_ms: 1000, cue_allowed: true } } as unknown as BrainTick;

describe('last dynamic attempt review', () => {
  it('retains an ended reference comparison without claiming heuristic phase completion', () => {
    const reference = { ...assessment, phase_id: null, criteria: [{ provenance: { evaluator: 'dynamic_reference' }, meta: { assessment_source: 'dynamic_reference_completed' }, state: 'IMPROVE' }] } as unknown as AssessmentSet;
    const ended = { ...completed, guided_completion: null, assessment: reference };
    expect(updateLastAttemptReview(null, ended, context, 1000)).toBe(reference);
    expect(visibleLastAttemptReview(reference, null, ended, context, 1800)).toBe(reference);
    expect(visibleLastAttemptReview(reference, null, { ...ended, signal: { ...ended.signal, time_gap: true } }, context, 1800)).toBeNull();
  });
  it('keeps a completed assessment readable during the next action without duplicating the live card', () => {
    const review = updateLastAttemptReview(null, completed, context, 1000);
    expect(review).toBe(assessment);
    expect(visibleLastAttemptReview(review, assessment, completed, context, 1000)).toBeNull();
    const next = { ...completed, timestamp_ms: 1750, assessment: null, guided_completion: null, guided_attempt: { phase_id: 'action', since_ms: 1600, cue_allowed: false } };
    expect(updateLastAttemptReview(review, next, context, 1750)).toBe(review);
    expect(visibleLastAttemptReview(review, null, next, context, 1750)).toBe(review);
    expect(visibleLastAttemptReview(review, { ...assessment, timestamp_ms: 1750 }, next, context, 1750)).toBe(review);
  });
  it('expires from the original assessment timestamp and cannot resurrect a cached tick', () => {
    expect(updateLastAttemptReview(assessment, completed, context, 8999)).toBe(assessment);
    expect(updateLastAttemptReview(assessment, completed, context, 9000)).toBeNull();
    expect(visibleLastAttemptReview(assessment, null, completed, context, 9000)).toBeNull();
    expect(updateLastAttemptReview(null, completed, context, 10000)).toBeNull();
  });
  it('clears on quality/identity loss, camera stop, session or movement change', () => {
    expect(updateLastAttemptReview(assessment, { ...completed, quality: { ok: false, reasons: ['FRAMING_INVALID'] } }, context, 1200)).toBeNull();
    expect(updateLastAttemptReview(assessment, { ...completed, signal: { ...completed.signal, track_changed: true } }, context, 1200)).toBeNull();
    for (const signal of [{ ...completed.signal, time_gap: true }, { ...completed.signal, dropped: true }]) {
      const interrupted = { ...completed, signal };
      expect(updateLastAttemptReview(assessment, interrupted, context, 1200)).toBeNull();
      expect(visibleLastAttemptReview(assessment, null, interrupted, context, 1200)).toBeNull();
    }
    expect(updateLastAttemptReview(assessment, completed, { ...context, live: false }, 1200)).toBeNull();
    expect(updateLastAttemptReview(assessment, completed, { ...context, sessionId: 'other' }, 1200)).toBeNull();
    expect(updateLastAttemptReview(assessment, completed, { ...context, movementId: 'other' }, 1200)).toBeNull();
  });
  it('does not retain an unfinished guided posture as a completed attempt', () => {
    expect(updateLastAttemptReview(null, { ...completed, guided_completion: null }, context, 1000)).toBeNull();
    expect(updateLastAttemptReview(null, { ...completed, assessment: { ...assessment, criteria: [] } }, context, 1000)).toBeNull();
  });
});
