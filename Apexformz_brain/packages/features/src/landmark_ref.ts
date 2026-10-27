import { LANDMARK_INDEX, type Handedness } from '@apexformz/contracts';

export interface ResolvedRef {
  id: number | null;
  reason?: 'UNKNOWN_FEATURE' | 'HANDEDNESS_UNKNOWN';
  assumed?: boolean;
}

/**
 * Resolve a landmark reference. Supports concrete names (left_knee) and side
 * tokens (dominant_knee, nondominant_knee) resolved from calibration
 * handedness. Unknown handedness is a typed failure, never a silent default.
 */
export function resolveLandmarkRef(ref: string, handedness: Handedness, assumed = false): ResolvedRef {
  if (ref in LANDMARK_INDEX) return { id: LANDMARK_INDEX[ref] };
  const m = /^(dominant|nondominant|non_dominant)_(.+)$/.exec(ref);
  if (!m) return { id: null, reason: 'UNKNOWN_FEATURE' };
  if (handedness === 'unknown') return { id: null, reason: 'HANDEDNESS_UNKNOWN' };
  const dominantSide = handedness;
  const otherSide = handedness === 'left' ? 'right' : 'left';
  const side = m[1] === 'dominant' ? dominantSide : otherSide;
  const name = `${side}_${m[2]}`;
  if (!(name in LANDMARK_INDEX)) return { id: null, reason: 'UNKNOWN_FEATURE' };
  return { id: LANDMARK_INDEX[name], assumed };
}
