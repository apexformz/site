import { describe, expect, it } from 'vitest';
import { criterionExplanation } from './criterionPresentation';
import type { CriterionEvidence } from '@apexformz/contracts';

describe('criterion explanations', () => {
  it('explains withheld rubrics even when a numeric measurement is available', () => {
    expect(criterionExplanation({ state: 'UNCERTAIN', measurement: { value: 179, unit: 'deg', reason: 'RUBRIC_UNVALIDATED' } })).toContain('coach validation');
  });
  it('distinguishes camera, phase and unobserved-contact limitations', () => {
    for (const [reason, text] of [['VIEW_INVALID', 'camera view'], ['PHASE_NOT_ACTIVE', 'movement phase'], ['CONTACT_UNOBSERVED', 'contact']] as const) {
      expect(criterionExplanation({ state: 'NOT_ASSESSABLE', measurement: { value: null, unit: 'none', reason } })).toContain(text);
    }
  });
  it('does not invent a failure when a criterion is assessed', () => {
    expect(criterionExplanation({ state: 'PASS', measurement: { value: 160, unit: 'deg', reason: null } })).toBeNull();
  });
  it('distinguishes missing reference portions from insufficient live movement evidence', () => {
    const partial = { state: 'UNCERTAIN', measurement: { value: null, unit: 'ratio', reason: 'COVERAGE_INSUFFICIENT' }, provenance: { evaluator: 'dynamic_reference' },
      meta: { dynamic_reference: { complete_capture: false, status: 'incomplete' } } } as unknown as CriterionEvidence;
    expect(criterionExplanation(partial)).toContain('unrecorded remainder');
    expect(criterionExplanation({ ...partial, measurement: { ...partial.measurement, feature_id: 'dynamic_ref_left_knee_angle' } })).toContain('body measurement was unavailable');
    const ongoing = { ...partial, measurement: { ...partial.measurement, reason: 'INSUFFICIENT_HISTORY' as const } };
    expect(criterionExplanation(ongoing)).toContain('did not reach a measured verdict');
    expect(criterionExplanation(partial)).not.toContain('full sequence');
    expect(criterionExplanation(ongoing)).not.toContain('full sequence');
  });
});
