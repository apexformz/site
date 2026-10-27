import { describe, expect, it } from 'vitest';
import type { AssessmentSet, CriterionEvidence, FeedbackAction } from '@apexformz/contracts';
import { projectDraftReferenceFeedback, summarizeTechnique } from './techniqueSummary';

const waiting = { title: 'Tracking live · waiting for assessment', description: 'Poses are arriving but fresh measurements are not available.' };
const criterion = (state: CriterionEvidence['state'], reason: string | null = null) => ({
  state, measurement: { reason }, provenance: { provisional: true, validation_status: 'provisional' },
  feedback: state === 'IMPROVE' ? { cue: 'Bend your knees more.' } : null,
}) as unknown as CriterionEvidence;
const assessment = (...criteria: CriterionEvidence[]) => ({ score: null, criteria }) as AssessmentSet;

describe('visible technique summary', () => {
  it('shows a correction despite withheld aggregate score or absent movement recognition', () => {
    expect(summarizeTechnique(assessment(criterion('IMPROVE'), criterion('PASS'), criterion('UNCERTAIN')), waiting)).toMatchObject({
      state: 'adjust', title: '1 correction to make', detail: 'Bend your knees more.', passed: 1, corrections: 1, unassessed: 1, provisional: true,
    });
  });
  it('distinguishes poses received without assessment from measurements that cannot give a verdict', () => {
    expect(summarizeTechnique(null, waiting)).toMatchObject({ state: 'waiting', title: waiting.title });
    expect(summarizeTechnique(assessment(criterion('UNCERTAIN', 'VIEW_INVALID')), waiting)).toMatchObject({ state: 'unassessed', detail: expect.stringContaining('selected camera view') });
  });
  it('never turns provisional or partial passes into a whole-body correct label', () => {
    expect(summarizeTechnique(assessment(criterion('PASS'), criterion('NOT_ASSESSABLE')), waiting)).toMatchObject({ state: 'in_range', title: '1 check in range', unassessed: 1, provisional: true });
    expect(summarizeTechnique(assessment(criterion('PASS')), waiting).detail).toContain('draft target');
    expect(summarizeTechnique(assessment(criterion('PASS')), waiting, 'dynamic').detail).toBe('The observed checks meet the draft limits for this part of your attempt.');
    expect(summarizeTechnique(assessment(criterion('PASS'), criterion('NOT_ASSESSABLE')), waiting, 'dynamic').detail).toContain('full body visible through the movement');
  });
  it('speaks the current directional draft reference cue while preserving policy identity and expiry', () => {
    const ref = { ...criterion('IMPROVE'), criterion_id: 'reference', timestamp_ms: 1000, provenance: { evaluator: 'reference_nearest', provisional: true }, meta: { reference_deviations: [{ feature_id: 'dominant_elbow_angle', observed: 170, reference: 50, unit: 'deg', weighted_squared_contribution: 14400, outside_reference_band: true }] } } as unknown as CriterionEvidence;
    const current = { ...assessment(ref), movement_id: 'ready', timestamp_ms: 1000 };
    const cue = { kind: 'technique_cue', event_id: 'same-event', movement_id: 'ready', criterion_id: 'reference', timestamp_ms: 900, expires_ms: 4000, text: 'Match the reference.', provenance: { review_status: 'draft' }, evidence_frame_ids: [9] } as unknown as FeedbackAction;
    expect(projectDraftReferenceFeedback(cue, current)).toEqual({ ...cue, text: 'Bend your dominant elbow more toward the recorded position.' });
    const approved = { ...cue, provenance: { ...cue.provenance, review_status: 'approved' as const } };
    expect(projectDraftReferenceFeedback(approved, current)).toBe(approved);
    expect(projectDraftReferenceFeedback(cue, { ...current, criteria: [{ ...ref, timestamp_ms: 800 }] })).toBe(cue);
    expect(projectDraftReferenceFeedback(cue, { ...current, criteria: [{ ...ref, state: 'PASS' }] })).toBe(cue);
    expect(projectDraftReferenceFeedback(cue, { ...current, movement_id: 'another' })).toBe(cue);
  });
  it('uses the same measured dynamic correction for current voice and review, and never rewrites a deferred cue from newer evidence', () => {
    const c = { ...criterion('IMPROVE'), criterion_id: 'dynamic-reference', timestamp_ms: 1000, provenance: { evaluator: 'dynamic_reference', provisional: true },
      feedback: { cue: 'Move your racket hand toward the recorded path during the middle of the movement.' },
      meta: { reference_deviations: [{ feature_id: 'dynamic_ref_dominant_wrist_x', observed: 1, reference: -.5, unit: 'normalized', weighted_squared_contribution: 2.25, outside_reference_band: true }] } } as unknown as CriterionEvidence;
    const current = { ...assessment(c), movement_id: 'backhand', timestamp_ms: 1000 };
    const cue = { kind: 'technique_cue', movement_id: 'backhand', criterion_id: 'dynamic-reference', timestamp_ms: 1000, text: 'Follow the reference.', provenance: { review_status: 'draft' } } as unknown as FeedbackAction;
    expect(projectDraftReferenceFeedback(cue, current)?.text).toBe(c.feedback!.cue);
    const deferred = { ...cue, timestamp_ms: 1800, text: `For your next attempt: ${c.feedback!.cue}` };
    expect(projectDraftReferenceFeedback(deferred, current)).toBe(deferred);
    expect(summarizeTechnique(current, waiting, 'dynamic').detail).toBe(c.feedback!.cue);
    expect(summarizeTechnique({ ...current, criteria: [{ ...c, state: 'PASS' }] }, waiting, 'dynamic').detail).toContain('selected recording');
  });
});
