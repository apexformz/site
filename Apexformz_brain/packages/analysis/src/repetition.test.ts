import { describe, expect, it } from 'vitest';
import type { FeatureValue } from '@apexformz/contracts';
import { RepetitionDetector } from './repetition';

function fv(id: string, value: number, unit: FeatureValue['unit'] = 'deg', t = 0): FeatureValue {
  return { spec_id: id, name: id, value, unit, valid: true, reason: null, evidence_frame_ids: [], confidence: 0.9, view_applicability: 'any', coordinate_system: 'body_relative', timestamp_ms: t };
}

function run(gen: (tMs: number) => Record<string, number>, durationMs: number, dt = 40) {
  const det = new RepetitionDetector();
  let last = null;
  for (let t = 0; t <= durationMs; t += dt) {
    const vals = gen(t);
    const map = new Map(Object.entries(vals).map(([k, v]) => [k, fv(k, v, 'deg', t)]));
    det.noteUnits(map.values());
    last = det.update(map, t);
  }
  return { det, last: last! };
}

describe('RepetitionDetector (RepNet-style, class agnostic)', () => {
  it('finds a 1 Hz period and counts repetitions on a periodic knee signal', () => {
    const { last } = run((t) => ({ knee: 140 + 35 * Math.sin((2 * Math.PI * t) / 1000), hip: 160 + 10 * Math.sin((2 * Math.PI * t) / 1000 + 0.5) }), 8000);
    expect(last.periodic).toBe(true);
    expect(Math.abs(last.period_ms! - 1000)).toBeLessThanOrEqual(140);
    expect(last.rep_count).toBeGreaterThanOrEqual(5);
    expect(last.rep_count).toBeLessThanOrEqual(9);
    expect(last.dominant_feature).toBe('knee');
    expect(last.retrospective).toBe(false);
  });

  it('reports no period for a still athlete or noise', () => {
    const still = run(() => ({ knee: 170, hip: 175 }), 6000).last;
    expect(still.periodic).toBe(false);
    expect(still.energy).toBeLessThan(0.05);
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280) * 60 - 30;
    const noise = run(() => ({ knee: 140 + rnd() }), 6000).last;
    expect(noise.periodic).toBe(false);
  });

  it('tracks a slower 2 s period and resets history on demand without losing the count', () => {
    const { det, last } = run((t) => ({ knee: 120 + 40 * Math.sin((2 * Math.PI * t) / 2000) }), 10000);
    expect(last.periodic).toBe(true);
    expect(Math.abs(last.period_ms! - 2000)).toBeLessThanOrEqual(220);
    const before = last.rep_count;
    det.reset();
    expect(det.estimate).toBeNull();
    const map = new Map([['knee', fv('knee', 150)]]);
    const after = det.update(map, 20000)!;
    expect(after.rep_count).toBe(before);
    expect(after.periodic).toBe(false);
  });
});
