import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DynamicReferenceModel } from '@apexformz/contracts';
import { dynamicFaultProbes, replayReference } from '../../tools/evaluate_dynamic_references';

const backhand = JSON.parse(fs.readFileSync('sport-packs/squash/models/dynamic-reference/squash.dynamic.0040.json', 'utf8')) as DynamicReferenceModel;

describe('recorded backhand reference comparison regressions (source replay, not independent accuracy)', () => {
  it.each([1, .7, 1.4])('does not correct its recorded geometry at a %sx time scale', speed => {
    expect(backhand.references.length).toBeGreaterThan(0);
    for (const ref of backhand.references) {
      const { summary } = replayReference(backhand, ref, speed);
      expect(summary.assessments, ref.id).toBeGreaterThan(0);
      expect(summary.correction_features, ref.id).toEqual([]);
      // Partial source observations never become proof of the whole catalogue movement.
      if (!ref.complete_capture) expect(summary.whole_reference_matched, ref.id).toBe(false);
    }
  });

  it('localizes controlled knee-angle deviations while preserving source references', () => {
    const original = JSON.stringify(backhand);
    let exercised = 0;
    for (const ref of backhand.references) {
      const fault = dynamicFaultProbes(backhand, ref).find(p => p.name === 'controlled_knee_deviation');
      if (!fault) continue;
      exercised++;
      const { summary } = replayReference(backhand, fault.source);
      expect(summary.correction_features, ref.id).toContain(fault.feature);
    }
    expect(exercised).toBeGreaterThan(0);
    expect(JSON.stringify(backhand)).toBe(original);
  });
});
