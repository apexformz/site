import { describe, expect, it } from 'vitest';
import type { PoseFrame } from '@apexformz/contracts';
import fixture from './__fixtures__/world_bodyframe_parity.json';
import { mirrorSample, worldBodyframeSample } from './movement_detector';

/** Training (Python) and browser (TS) must compute the identical camera-independent body frame. */
describe('world_bodyframe_v1 parity with the training pipeline', () => {
  for (const [i, c] of fixture.cases.entries()) {
    it(`matches ml/datasets/jsonl_dataset.py (case ${i}, mirror=${c.frame.mirror})`, () => {
      const s = worldBodyframeSample(c.frame as unknown as PoseFrame, 0.5)!;
      expect(s).not.toBeNull();
      expect(s.mask).toEqual(c.expected.valid);
      s.values.forEach((v, k) => {
        if (!c.expected.valid[k]) { expect(v).toBeNull(); return; }
        expect(v!.x).toBeCloseTo(c.expected.body[k][0] as number, 4);
        expect(v!.y).toBeCloseTo(c.expected.body[k][1] as number, 4);
        expect(v!.z).toBeCloseTo(c.expected.body[k][2] as number, 4);
      });
    });
  }

  it('is invariant to camera yaw: rotating the world about the vertical axis leaves the body frame unchanged', () => {
    const base = fixture.cases[0].frame as unknown as PoseFrame;
    const a = worldBodyframeSample(base, 0.5)!;
    const th = 1.1;
    const rotated: PoseFrame = { ...base, world_landmarks: base.world_landmarks!.map((p) => ({ ...p, x: Math.cos(th) * p.x - Math.sin(th) * (p.z ?? 0), z: Math.sin(th) * p.x + Math.cos(th) * (p.z ?? 0) })) };
    const b = worldBodyframeSample(rotated, 0.5)!;
    a.values.forEach((v, k) => { if (v) { expect(b.values[k]!.x).toBeCloseTo(v.x, 6); expect(b.values[k]!.z ?? 0).toBeCloseTo(v.z ?? 0, 6); } });
  });

  it('abstains without world landmarks (e.g. ONNX pose backends) instead of guessing', () => {
    const base = fixture.cases[0].frame as unknown as PoseFrame;
    expect(worldBodyframeSample({ ...base, world_landmarks: undefined }, 0.5)).toBeNull();
  });

  it('mirroring a sample twice is the identity, and mirroring swaps left and right with x negated', () => {
    const s = worldBodyframeSample(fixture.cases[0].frame as unknown as PoseFrame, 0.5)!;
    const m = mirrorSample(s);
    const lh = 23, rh = 24;
    expect(m.values[lh]!.x).toBeCloseTo(-s.values[rh]!.x, 9);
    expect(m.mask[lh]).toBe(s.mask[rh]);
    expect(mirrorSample(m)).toEqual(s);
  });
});

