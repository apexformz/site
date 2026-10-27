import { describe, expect, it } from 'vitest';
import { SESSION_REVIEW_MAX_CRITERIA } from '@apexformz/contracts';
import { parseTechniqueReview } from './techniqueReview';

const observation = () => ({ timestamp_ms: 100, state: 'IMPROVE', value: 165, unit: 'deg', reason: null,
  correction: 'Bend your lead knee more.', rationale: 'Lower into the shot.', body_areas: ['left knee'], provisional: true, source: 'live' });
const review = () => ({ version: 1, session_id: 's1', movement_id: 'squash.dynamic.0040', assessments_observed: 1, nonempty_assessments: 1, phases: ['swing'], criteria: [{
  criterion_id: 'squash.dynamic.0040.lunge', name: 'Lead knee bend', phase_id: 'swing', observations: 1, state_counts: { IMPROVE: 1 },
  first_measured: observation(), latest_measured: observation(), latest_correction: observation(), latest_unassessed: null,
}] });

describe('session technique review validation', () => {
  it('retains actionable evidence while stripping unrecognized nested fields', () => {
    const source = review();
    const safe = parseTechniqueReview({ ...source, landmarks: [1], criteria: [{ ...source.criteria[0], image: 'raw', latest_correction: { ...observation(), landmarks: [1] } }] }, 's1', source.movement_id);
    expect(safe.criteria[0].latest_correction).toMatchObject({ correction: 'Bend your lead knee more.', body_areas: ['left knee'] });
    expect(JSON.stringify(safe)).not.toMatch(/landmarks|image|raw/);
  });
  it('rejects another session, movement, unbounded arrays and impossible counts', () => {
    for (const source of [
      { ...review(), session_id: 'foreign' }, { ...review(), movement_id: 'foreign' },
      { ...review(), criteria: Array(SESSION_REVIEW_MAX_CRITERIA + 1).fill(review().criteria[0]) },
      { ...review(), nonempty_assessments: 2 },
      { ...review(), criteria: [{ ...review().criteria[0], observations: 0 }] },
      { ...review(), criteria: [review().criteria[0], review().criteria[0]] },
    ]) expect(() => parseTechniqueReview(source, 's1', 'squash.dynamic.0040')).toThrow(/review/);
  });
  it('rejects malformed verdicts rather than storing a fabricated correction', () => {
    for (const change of [{ state: 'PASS' }, { value: Infinity }, { timestamp_ms: -1 }, { body_areas: Array(13).fill('knee') }, { unit: 'wrong' }]) {
      const source = review();
      expect(() => parseTechniqueReview({ ...source, criteria: [{ ...source.criteria[0], latest_correction: { ...observation(), ...change } }] }, 's1')).toThrow(/review/);
    }
  });
});
