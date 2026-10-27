import { describe, expect, it } from 'vitest';
import type { DynamicReferenceModel } from '@apexformz/contracts';
import { dynamicReferenceCoverage, referenceSupport } from './referenceCoverage';

const model = { movement_id: 'backhand', unsupported_reasons: [], features: [
  { id: 'dynamic_ref_dominant_elbow_angle', weight: 1 }, { id: 'dynamic_ref_left_knee_angle', weight: 1 },
], references: [
  { view: 'left', handedness: 'right', complete_capture: true, samples: [{ values: [140, 155] }, { values: [145, 160] }, { values: [150, 165] }] },
  { view: 'right', handedness: 'right', complete_capture: false, samples: [{ values: [null, 155] }, { values: [null, 160] }, { values: [null, 165] }] },
] } as unknown as DynamicReferenceModel;

describe('dynamic reference setup guidance', () => {
  it('distinguishes a complete capture from a visible segment without promising correctness', () => {
    const support = referenceSupport(model);
    expect(dynamicReferenceCoverage(support, 'left', 'right')).toMatchObject({ state: 'available', views: ['left', 'right'] });
    const partial = dynamicReferenceCoverage(support, 'right', 'right');
    expect(partial.state).toBe('partial');
    expect(partial.detail).toContain('prevent confirmation of a full recorded sequence');
  });
  it('tells users the actual supported views without silently changing their chosen camera or hand', () => {
    const support = referenceSupport(model);
    expect(dynamicReferenceCoverage(support, 'front', 'right')).toMatchObject({ state: 'unavailable', title: 'No recorded comparison from the front view', views: ['left', 'right'] });
    expect(dynamicReferenceCoverage(support, 'left', 'left').detail).toContain('Keep your actual hand selected');
    expect(dynamicReferenceCoverage(support, 'left', 'unknown').title).toBe('Choose your dominant hand');
    expect(support.views[0]).toMatchObject({ view: 'left', handedness: 'right' });
  });
  it('makes missing source support explicit instead of calling an unassessed movement correct', () => {
    expect(dynamicReferenceCoverage(undefined, 'front', 'right')).toMatchObject({ state: 'unavailable', title: 'Recorded comparison unavailable' });
    expect(dynamicReferenceCoverage(referenceSupport({ ...model, references: [] }), 'front', 'right').detail).toContain('cannot compare');
  });
  it('warns when a selected view cannot compare the dominant arm and offers only views with measured arm evidence', () => {
    const support = referenceSupport(model);
    expect(support.views.find(v => v.view === 'right')?.measured_features).toEqual(['dynamic_ref_left_knee_angle']);
    const limited = dynamicReferenceCoverage(support, 'right', 'right');
    expect(limited.armWarning).toContain('cannot give arm or hand corrections');
    expect(limited.armWarning).toContain('left view');
    expect(dynamicReferenceCoverage(support, 'left', 'right').armWarning).toBeUndefined();
    expect(support.views.find(v => v.view === 'right')?.view).toBe('right');
  });
  it('does not promise arm comparison from one isolated source measurement', () => {
    const sparse = structuredClone(model);
    sparse.references[0].samples[1].values[0] = null;
    sparse.references[0].samples[2].values[0] = null;
    const support = referenceSupport(sparse);
    expect(dynamicReferenceCoverage(support, 'left', 'right').armWarning).toContain('available views do not contain those measurements');
  });
});
