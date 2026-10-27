import type { Aggregate, CriterionDefinition } from '@apexformz/contracts';
import type { FeatureSample } from './accumulator';

export interface Verdict {
  pass: boolean;
  /** 1 inside the acceptable region, decaying linearly to 0 over `tolerance` outside it. */
  score: number;
  distance: number;
}

type Evaluator = CriterionDefinition['evaluator'];

export function aggregateSamples(samples: FeatureSample[], aggregate: Aggregate): number {
  const vals = samples.map((s) => s.value);
  switch (aggregate) {
    case 'latest':
    case 'phase_end':
      return vals[vals.length - 1];
    case 'window_min':
    case 'phase_min':
      return Math.min(...vals);
    case 'window_max':
    case 'phase_max':
      return Math.max(...vals);
    case 'window_mean':
    case 'phase_mean':
    default:
      return vals.reduce((a, b) => a + b, 0) / vals.length;
  }
}

function decay(distance: number, tolerance: number | undefined): number {
  if (distance <= 0) return 1;
  const tol = tolerance && tolerance > 0 ? tolerance : Math.max(Math.abs(distance), 1e-9);
  return Math.max(0, 1 - distance / tol);
}

/** Deterministic rule evaluation. Thresholds come from the pack; nothing here is sport-specific. */
export function scoreAgainst(ev: Evaluator, value: number): Verdict {
  switch (ev.kind) {
    case 'range': {
      const [lo, hi] = ev.range as [number, number];
      const d = value < lo ? lo - value : value > hi ? value - hi : 0;
      return { pass: d === 0, score: decay(d, ev.tolerance), distance: d };
    }
    case 'max_abs': {
      const d = Math.max(0, Math.abs(value) - (ev.limit as number));
      return { pass: d === 0, score: decay(d, ev.tolerance), distance: d };
    }
    case 'max_value':
    case 'stability':
    case 'phase_duration': {
      const d = Math.max(0, value - (ev.limit as number));
      return { pass: d === 0, score: decay(d, ev.tolerance), distance: d };
    }
    case 'min_value': {
      const d = Math.max(0, (ev.limit as number) - value);
      return { pass: d === 0, score: decay(d, ev.tolerance), distance: d };
    }
    case 'ordering': {
      const need = ev.limit ?? 1;
      const d = Math.max(0, need - value);
      return { pass: d === 0, score: Math.max(0, Math.min(1, value)), distance: d };
    }
    default:
      return { pass: false, score: 0, distance: Infinity };
  }
}
