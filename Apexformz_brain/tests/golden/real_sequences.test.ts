/**
 * Real-video golden sequences (TRD 00 integration tests: "golden pose sequences").
 *
 * Any `tests/golden/data/real/*.jsonl` file holding one contract PoseFrame per line
 * (produced by `apexformz_perception.pose.extract` from real clips) is run through
 * the signal pipeline, the generic feature engine and the repetition detector.
 * Assertions are sport-agnostic: contract validity, no NaNs, time monotonicity,
 * normalization validity, and that a kicking clip shows motion energy.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, type FeatureSpec, type PoseFrame } from '@apexformz/contracts';
import { SignalPipeline } from '@apexformz/signal';
import { FeatureEngine } from '@apexformz/features';
import { RepetitionDetector } from '@apexformz/analysis';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, 'data', 'real');
const files = existsSync(DATA) ? readdirSync(DATA).filter((f) => f.endsWith('.jsonl')) : [];

const specs: FeatureSpec[] = [
  { id: 'left_knee', kind: 'angle_at', params: { a: 'left_hip', b: 'left_knee', c: 'left_ankle' }, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any', unit: 'deg' },
  { id: 'right_knee', kind: 'angle_at', params: { a: 'right_hip', b: 'right_knee', c: 'right_ankle' }, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any', unit: 'deg' },
  { id: 'left_hip', kind: 'angle_at', params: { a: 'left_shoulder', b: 'left_hip', c: 'left_knee' }, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any', unit: 'deg' },
  { id: 'right_hip', kind: 'angle_at', params: { a: 'right_shoulder', b: 'right_hip', c: 'right_knee' }, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any', unit: 'deg' },
  { id: 'right_knee_vel', kind: 'angular_velocity', params: { of: 'right_knee', window_ms: 150 }, version: '1.0.0', coordinate_system: 'body_relative', view_applicability: 'any' },
];

describe.skipIf(files.length === 0)('real pose sequences', () => {
  for (const file of files) {
    it(`${file} runs through signal, features and repetition without invalid numbers`, () => {
      const frames = readFileSync(path.join(DATA, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PoseFrame);
      expect(frames.length).toBeGreaterThan(10);
      const pipeline = new SignalPipeline({ view: 'front' });
      const engine = new FeatureEngine(specs);
      const rep = new RepetitionDetector();
      let valid = 0;
      let normalized = 0;
      let dropped = 0;
      let lastTs = -1;
      let maxEnergy = 0;
      for (const f of frames) {
        expect(validate('poseFrame', f).ok).toBe(true);
        expect(f.timestamp_ms).toBeGreaterThan(lastTs);
        lastTs = f.timestamp_ms;
        const r = pipeline.process(f);
        if (r.dropped) {
          dropped++;
          continue;
        }
        if (r.time_gap || r.track_changed) {
          engine.reset();
          rep.reset();
        }
        valid++;
        if (r.frame!.normalization_valid) normalized++;
        for (const l of r.frame!.body) {
          expect(Number.isFinite(l.x)).toBe(true);
          expect(Number.isFinite(l.y)).toBe(true);
        }
        const feats = engine.compute(pipeline.window, { view: 'front', handedness: 'right' });
        for (const v of feats.values()) {
          if (v.valid) expect(Number.isFinite(v.value)).toBe(true);
          else expect(v.value).toBeNull();
        }
        rep.noteUnits(feats.values());
        const est = rep.update(feats, f.timestamp_ms);
        if (est) maxEnergy = Math.max(maxEnergy, est.energy);
      }
      expect(dropped).toBe(0);
      expect(normalized / Math.max(1, valid)).toBeGreaterThan(0.6);
      // Real athletic clips are not still.
      expect(maxEnergy).toBeGreaterThan(0.05);
    });
  }
});
