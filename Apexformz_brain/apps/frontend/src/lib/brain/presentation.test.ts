import { describe, expect, it } from 'vitest';
import type { AssessmentSet, FeedbackAction } from '@apexformz/contracts';
import type { BrainTick } from '@apexformz/runtime';
import { currentAssessment, currentFeedback } from './presentation';

const tick = {
  timestamp_ms: 1000, signal: { dropped: false, track_changed: false, time_gap: false },
  quality: { ok: true, reasons: [] }, temporal: { movement_id: 'squash.static.0001', cue_allowed: false, phase_id: null, execution_id: null },
  guided_attempt: { phase_id: 'hold', since_ms: 500, cue_allowed: true },
} as unknown as BrainTick;
const assessment = {
  movement_id: 'squash.static.0001', execution_id: null, phase_id: 'hold', timestamp_ms: 900,
  criteria: [{ meta: { assessment_source: 'guided_attempt', assumed_phase: true } }],
} as unknown as AssessmentSet;
const feedback = {
  kind: 'technique_cue', priority: 'primary', movement_id: 'squash.static.0001', timestamp_ms: 900, expires_ms: 2000,
} as FeedbackAction;

describe('guided attempt presentation', () => {
  it('shows reference measurements independent of heuristic phase and speaks only at a currently observed reference pause', () => {
    const reference = { ...assessment, phase_id: null, criteria: [{ provenance: { evaluator: 'dynamic_reference' }, meta: { dynamic_reference: { attempt_id: 'attempt1' } } }] } as unknown as AssessmentSet;
    const active = { ...tick, dynamic_reference: { status: 'active', current: true, cue_allowed: false, attempt_id: 'attempt1', progress: .4, reference_id: 'recording', reason: null, complete_capture: true } } as BrainTick;
    expect(currentAssessment(reference, active, 0)).toBe(reference);
    expect(currentFeedback(feedback, active, true, 1000)).toBeNull();
    const ended = { ...active, dynamic_reference: { ...active.dynamic_reference!, status: 'complete' as const, current: false, cue_allowed: true } };
    expect(currentFeedback(feedback, ended, true, 1000)).toBe(feedback);
    expect(currentAssessment(reference, { ...active, dynamic_reference: { ...active.dynamic_reference!, attempt_id: 'attempt2' } }, 0)).toBeNull();
    expect(currentFeedback(feedback, { ...ended, signal: { ...tick.signal, time_gap: true } }, true, 1000)).toBeNull();
    expect(currentFeedback({ ...feedback, movement_id: 'other' }, ended, true, 1000)).toBeNull();
  });
  it('shows observed posture evidence and its cue before a correct hold is confirmed', () => {
    expect(currentAssessment(assessment, tick, 0)).toBe(assessment);
    expect(currentFeedback(feedback, tick, true, 1000)).toBe(feedback);
  });
  it('expires a live verdict with its body colors instead of leaving a stale technique card', () => {
    expect(currentAssessment(assessment, { ...tick, timestamp_ms: 3000 }, 0)).toBeNull();
  });
  it('accepts only new current-frame static measurements after a cadence gap', () => {
    const fresh = { ...assessment, timestamp_ms: 1000, criteria: [{ meta: { current_observation: true, assessment_source: 'guided_attempt' }, evidence: { frame_ids: [10] } }] } as unknown as AssessmentSet;
    const freshTick = { ...tick, frame_id: 10, assessment: fresh, signal: { ...tick.signal, time_gap: true } };
    expect(currentAssessment(fresh, freshTick, 1000)).toBe(fresh);
    expect(currentAssessment(assessment, freshTick, 0)).toBeNull();
    expect(currentAssessment(fresh, { ...freshTick, frame_id: 11 }, 0)).toBeNull();
    expect(currentAssessment(fresh, { ...freshTick, signal: { ...freshTick.signal, track_changed: true } }, 0)).toBeNull();
    expect(currentFeedback({ ...feedback, timestamp_ms: 1000 }, freshTick, true, 1000)).not.toBeNull();
    expect(currentFeedback(feedback, freshTick, true, 1000)).toBeNull();
  });
  it('lets a spoken static correction finish through cadence gaps only while fresh measurements still support it', () => {
    const fresh = { ...assessment, timestamp_ms: 1500, criteria: [{ criterion_id: 'knee', state: 'IMPROVE', meta: { current_observation: true, assessment_source: 'guided_attempt' }, evidence: { frame_ids: [11] } }] } as unknown as AssessmentSet;
    const ongoing = { ...feedback, criterion_id: 'knee', expires_ms: 4000 };
    const freshTick = { ...tick, frame_id: 11, timestamp_ms: 1500, assessment: fresh, guided_attempt: { phase_id: 'hold', since_ms: 1500, cue_allowed: true }, signal: { ...tick.signal, time_gap: true } };
    expect(currentFeedback(ongoing, freshTick, true, 1500)).toBe(ongoing);
    expect(currentFeedback(ongoing, freshTick, true, 4000)).toBeNull();
    expect(currentFeedback(ongoing, { ...freshTick, assessment: { ...fresh, criteria: [{ ...fresh.criteria[0], state: 'PASS' }] } }, true, 1500)).toBeNull();
    expect(currentFeedback(ongoing, { ...freshTick, signal: { ...freshTick.signal, track_changed: true } }, true, 1500)).toBeNull();
    expect(currentFeedback({ ...ongoing, movement_id: 'another-target' }, freshTick, true, 1500)).toBeNull();
    expect(currentFeedback(ongoing, { ...freshTick, assessment: null }, true, 1500)).toBeNull();
  });
  it('clears guidance on movement, tracking, phase or fresh-attempt boundaries', () => {
    expect(currentAssessment(assessment, { ...tick, guided_attempt: null }, 0)).toBeNull();
    expect(currentAssessment(assessment, { ...tick, guided_attempt: { phase_id: 'recovery', since_ms: 500, cue_allowed: true } }, 0)).toBeNull();
    expect(currentAssessment(assessment, { ...tick, guided_attempt: { phase_id: 'hold', since_ms: 950, cue_allowed: true } }, 0)).toBeNull();
    expect(currentFeedback(feedback, { ...tick, guided_attempt: null }, true, 1000)).toBeNull();
    expect(currentFeedback(feedback, { ...tick, guided_attempt: { phase_id: 'hold', since_ms: 950, cue_allowed: true } }, true, 1000)).toBeNull();
    expect(currentFeedback(feedback, { ...tick, signal: { ...tick.signal, track_changed: true } }, true, 1000)).toBeNull();
  });
  it('shows candidate action evidence while suppressing voice cues during action', () => {
    // The real segmenter may still be in a cueable setup phase; candidate action overrides it.
    const action = { ...tick, temporal: { ...tick.temporal!, cue_allowed: true }, guided_attempt: { phase_id: 'action', since_ms: 500, cue_allowed: false } };
    expect(currentAssessment({ ...assessment, phase_id: 'action' }, action, 0)).not.toBeNull();
    expect(currentFeedback(feedback, action, true, 1000)).toBeNull();
    expect(currentAssessment({ ...assessment, criteria: [], phase_id: 'setup' }, action, 0)).toBeNull();
  });
  it('never carries another target cue into a guided attempt', () => {
    expect(currentFeedback({ ...feedback, movement_id: 'squash.dynamic.0001' }, tick, true, 1000)).toBeNull();
    expect(currentAssessment({ ...assessment, movement_id: 'squash.dynamic.0001' }, tick, 0)).toBeNull();
  });
  it('briefly reviews completed candidate evidence only while its safe endpoint marker remains current', () => {
    const ended = { ...assessment, phase_id: 'action', criteria: [{ meta: { assessment_source: 'guided_attempt_completed' } }] } as unknown as AssessmentSet;
    const safe = { ...tick, guided_attempt: null, guided_completion: { phase_id: 'action', since_ms: 500, ended_ms: 900, cue_allowed: true } };
    expect(currentAssessment(ended, safe, 0)).toBe(ended);
    expect(currentFeedback(feedback, safe, true, 1000)).toBe(feedback);
    expect(currentAssessment(ended, { ...safe, guided_completion: null }, 0)).toBeNull();
    expect(currentAssessment(ended, { ...safe, timestamp_ms: 5000 }, 0)).toBe(ended);
    expect(currentAssessment(ended, { ...safe, timestamp_ms: 9900 }, 0)).toBeNull();
    expect(currentAssessment(ended, { ...safe, guided_attempt: { phase_id: 'next_action', since_ms: 950, cue_allowed: false } }, 0)).toBeNull();
    expect(currentFeedback(feedback, { ...safe, guided_attempt: { phase_id: 'next_action', since_ms: 950, cue_allowed: false } }, true, 1000)).toBeNull();
    expect(currentAssessment(ended, { ...safe, quality: { ok: false, reasons: [] } }, 0)).toBeNull();
  });
});
