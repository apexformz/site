import type { Condition, FeatureValue, MissingReason } from '@apexformz/contracts';
import type { FeatureMap } from '@apexformz/features';

export interface ConditionResult {
  satisfied: boolean;
  evaluable: boolean;
  reason?: MissingReason;
  confidence: number;
}

export function evaluateCondition(cond: Condition, features: FeatureMap): ConditionResult {
  const f: FeatureValue | undefined = features.get(cond.feature);
  if (!f) return { satisfied: false, evaluable: false, reason: 'UNKNOWN_FEATURE', confidence: 0 };
  if (!f.valid || f.value === null) return { satisfied: false, evaluable: false, reason: f.reason ?? 'MISSING_JOINT', confidence: 0 };
  const v = f.value;
  let ok = false;
  switch (cond.op) {
    case 'lt': ok = v < (cond.value as number); break;
    case 'lte': ok = v <= (cond.value as number); break;
    case 'gt': ok = v > (cond.value as number); break;
    case 'gte': ok = v >= (cond.value as number); break;
    case 'abs_gt': ok = Math.abs(v) > (cond.value as number); break;
    case 'abs_lt': ok = Math.abs(v) < (cond.value as number); break;
    case 'between': {
      const [lo, hi] = cond.value as [number, number];
      ok = v >= lo && v <= hi;
      break;
    }
  }
  return { satisfied: ok, evaluable: true, confidence: f.confidence ?? 0 };
}

export interface ConditionSetResult {
  all_satisfied: boolean;
  evaluable: boolean;
  reasons: MissingReason[];
  confidence: number;
}

/** All conditions must hold (AND). An empty set is trivially satisfied. */
export function evaluateConditions(conds: Condition[], features: FeatureMap): ConditionSetResult {
  if (!conds.length) return { all_satisfied: true, evaluable: true, reasons: [], confidence: 1 };
  const results = conds.map((c) => evaluateCondition(c, features));
  const reasons = results.filter((r) => !r.evaluable).map((r) => r.reason!) as MissingReason[];
  return {
    all_satisfied: results.every((r) => r.satisfied),
    evaluable: results.every((r) => r.evaluable),
    reasons: [...new Set(reasons)],
    confidence: Math.min(...results.map((r) => r.confidence)),
  };
}
