import { describe, expect, it } from 'vitest';
import type { CriterionDefinition } from '@apexformz/contracts';
import { DEFAULT_HUMAN_VARIANCE, RepetitionVarianceTracker, mergeHumanVariance, referenceMagnitude, varianceBand, zoneFor } from './variance';

type Ev = CriterionDefinition['evaluator'];

// A pack-declared profile. The shared core itself carries no numbers (see the inert-defaults test).
const PROFILE = mergeHumanVariance({
  relative: 0.05,
  measurement_floor: { deg: 5, ms: 80 },
  context_scale: { novice: 1.5, intermediate: 1.0, advanced: 0.8 },
  consistency: { enabled: true, window: 8, min_reps: 3, k_sd: 1.0, fail_fraction: 0.5 },
});

describe('core defaults are inert without a pack profile', () => {
  it('no profile means no band at all (pack tolerance keeps its soft-score meaning) and no repetition layer', () => {
    const ev: Ev = { kind: 'max_value', limit: 165, tolerance: 2 };
    expect(DEFAULT_HUMAN_VARIANCE.relative).toBe(0);
    expect(varianceBand(ev, 'deg', 'novice', DEFAULT_HUMAN_VARIANCE).band).toBe(0);
    expect(zoneFor(false, 1, 0)).toBe('improve');
    expect(DEFAULT_HUMAN_VARIANCE.consistency.enabled).toBe(false);
  });
});

describe('human variance band (pack profile)', () => {
  it('is the relative allowance of the reference magnitude combined with the measurement floor, never below the pack tolerance', () => {
    const ev: Ev = { kind: 'max_value', limit: 165, tolerance: 2 };
    const b = varianceBand(ev, 'deg', 'intermediate', PROFILE);
    expect(b.relative_component).toBeCloseTo(8.25, 6); // 5% of 165 deg
    expect(b.measurement_component).toBe(5);
    expect(b.band).toBeCloseTo(Math.hypot(8.25, 5), 6);
    const wide: Ev = { kind: 'max_value', limit: 165, tolerance: 20 };
    expect(varianceBand(wide, 'deg', 'intermediate', PROFILE).band).toBe(20);
  });

  it('uses the span for ranges and the limit for one-sided rules', () => {
    expect(referenceMagnitude({ kind: 'range', range: [80, 120] })).toBe(40);
    expect(referenceMagnitude({ kind: 'min_value', limit: 1200 })).toBe(1200);
    expect(referenceMagnitude({ kind: 'range', range: [-2, 2] })).toBe(4);
  });

  it('never scales an advanced athlete below the measurement floor or the declared tolerance', () => {
    expect(varianceBand({ kind: 'max_value', limit: 10, tolerance: 1 }, 'deg', 'advanced', PROFILE).band).toBe(5);
    expect(varianceBand({ kind: 'max_value', limit: 10, tolerance: 20 }, 'deg', 'advanced', PROFILE).band).toBe(20);
  });

  it('scales with athlete context: novices get a wider band, advanced athletes a tighter one', () => {
    const ev: Ev = { kind: 'range', range: [80, 120] };
    const n = varianceBand(ev, 'deg', 'novice', PROFILE).band;
    const i = varianceBand(ev, 'deg', 'intermediate', PROFILE).band;
    const a = varianceBand(ev, 'deg', 'advanced', PROFILE).band;
    expect(n).toBeGreaterThan(i);
    expect(a).toBeLessThan(i);
    expect(n / i).toBeCloseTo(1.5, 6);
  });

  it('a criterion can set its own relative allowance; out-of-range profile values are ignored', () => {
    const ev: Ev = { kind: 'max_value', limit: 100, human_variance_relative: 0.1 };
    const cfg = mergeHumanVariance({ relative: 0.05, measurement_floor: { deg: 0 } });
    expect(varianceBand(ev, 'deg', 'intermediate', cfg).band).toBeCloseTo(10, 6);
    expect(mergeHumanVariance({ relative: 0.9 }).relative).toBe(0);
  });

  it('a unit without a floor still gets the relative component', () => {
    const ev: Ev = { kind: 'max_value', limit: 2.0 };
    expect(varianceBand(ev, 'ratio', 'intermediate', PROFILE).band).toBeCloseTo(0.1, 9);
  });

  it('splits non-passing distances into within-variance and improve zones', () => {
    expect(zoneFor(true, 0, 5)).toBe('pass');
    expect(zoneFor(false, 3, 5)).toBe('within_variance');
    expect(zoneFor(false, 5, 5)).toBe('within_variance');
    expect(zoneFor(false, 5.1, 5)).toBe('improve');
  });
});

describe('repetition variance tracker', () => {
  const cfg = PROFILE.consistency;

  it('treats one deviating repetition inside the athlete own spread as natural variation', () => {
    const t = new RepetitionVarianceTracker(cfg);
    t.record('c', 'e1', 100, false);
    t.record('c', 'e2', 104, false);
    t.record('c', 'e3', 96, false);
    t.record('c', 'e4', 103, true);
    const r = t.isNaturalVariation('c', 103, 'e4');
    expect(r.natural).toBe(true);
    expect(r.stats!.reps).toBe(3);
    expect(r.stats!.fail_fraction).toBe(0);
  });

  it('a consistent deviation (most repetitions failing) is never excused', () => {
    const t = new RepetitionVarianceTracker(cfg);
    for (let i = 1; i <= 4; i++) t.record('c', `e${i}`, 130 + i, true);
    expect(t.isNaturalVariation('c', 134, 'e4').natural).toBe(false);
  });

  it('an outlier far from the athlete own mean is not excused even when most repetitions pass', () => {
    const t = new RepetitionVarianceTracker(cfg);
    t.record('c', 'e1', 100, false);
    t.record('c', 'e2', 101, false);
    t.record('c', 'e3', 99, false);
    t.record('c', 'e4', 140, true);
    expect(t.isNaturalVariation('c', 140, 'e4').natural).toBe(false);
  });

  it('needs a minimum number of repetitions, keeps one value per execution and bounds its window', () => {
    const t = new RepetitionVarianceTracker({ ...cfg, window: 3 });
    t.record('c', 'e1', 1, false);
    t.record('c', 'e1', 2, false); // same execution: replaced
    expect(t.stats('c')!.reps).toBe(1);
    expect(t.isNaturalVariation('c', 2, 'e1').natural).toBe(false);
    t.record('c', 'e2', 2, false);
    t.record('c', 'e3', 2, false);
    t.record('c', 'e4', 2, false);
    expect(t.stats('c')!.reps).toBe(3);
    t.reset();
    expect(t.stats('c')).toBeNull();
  });

  it('can be disabled', () => {
    const t = new RepetitionVarianceTracker({ ...cfg, enabled: false });
    t.record('c', 'e1', 1, false);
    expect(t.stats('c')).toBeNull();
  });

  it('does not let an outlier create its own variance or satisfy the minimum prior-execution count', () => {
    const t = new RepetitionVarianceTracker({ ...cfg, k_sd: 2 });
    t.record('c', 'e1', 100, false);
    t.record('c', 'e2', 100, false);
    t.record('c', 'e3', 1000, true);
    expect(t.isNaturalVariation('c', 1000, 'e3')).toMatchObject({ natural: false, stats: { reps: 2, sd: 0 } });
    t.record('c', 'e3', 100, false);
    t.record('c', 'e4', 1000, true);
    expect(t.isNaturalVariation('c', 1000, 'e4')).toMatchObject({ natural: false, stats: { reps: 3, mean: 100, sd: 0 } });
  });

  it('excludes all earlier live updates of the current static execution from its comparison baseline', () => {
    const t = new RepetitionVarianceTracker({ ...cfg, k_sd: 2 });
    for (let i = 1; i <= 3; i++) t.record('c', `e${i}`, 100, false);
    t.record('c', 'live-hold', 1000, true);
    // The next assessment must not use the previous assessment of this same hold as historical evidence.
    expect(t.isNaturalVariation('c', 900, 'live-hold')).toMatchObject({ natural: false, stats: { reps: 3, sd: 0 } });
    t.record('c', 'live-hold', 900, true);
    expect(t.isNaturalVariation('c', 900, 'live-hold')).toMatchObject({ natural: false, stats: { reps: 3, sd: 0 } });
  });
});
