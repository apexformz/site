import { LANDMARK_INDEX, MIRROR_PAIRS, type PoseFrame, type PoseLandmark } from '@apexformz/contracts';
import type { FilteredLandmark, Vec3 } from './types';

/**
 * Coordinate registry (TRD 03). Every downstream feature declares one of these
 * systems; conversions are explicit and happen exactly once.
 */
export const COORDINATE_REGISTRY = {
  image_normalized: { units: 'normalized [0,1]', origin: 'top-left', axes: '+x right, +y down', view_dependent: true },
  image_pixel: { units: 'px', origin: 'top-left', axes: '+x right, +y down', view_dependent: true },
  estimated_world: { units: 'm (model-estimated, uncalibrated)', origin: 'hips', axes: 'model-specific', view_dependent: false },
  calibrated_world: { units: 'm', origin: 'documented calibration', axes: 'documented calibration', view_dependent: false },
  body_relative: { units: 'torso lengths', origin: 'hip midpoint', axes: '+x image-right, +y down, z model depth', view_dependent: true },
} as const;

const EPS = 1e-9;

/**
 * Reflect a mirrored frame exactly once so that downstream semantics are
 * consistent regardless of selfie-view capture: x -> 1 - x and the left/right
 * landmark identities are swapped. The original frame is not modified.
 */
export function canonicalizeMirror(frame: PoseFrame): { landmarks: PoseLandmark[]; applied: boolean } {
  if (!frame.mirror) return { landmarks: frame.normalized_landmarks, applied: false };
  const byId = new Map(frame.normalized_landmarks.map((l) => [l.id, l]));
  const swap = new Map<number, number>();
  for (const [l, r] of MIRROR_PAIRS) {
    swap.set(l, r);
    swap.set(r, l);
  }
  const out: PoseLandmark[] = [];
  for (const lm of frame.normalized_landmarks) {
    const sourceId = swap.get(lm.id) ?? lm.id;
    const src = byId.get(sourceId) ?? lm;
    out.push({ ...src, id: lm.id, x: 1 - src.x });
  }
  return { landmarks: out, applied: true };
}

/** Convert contract landmarks into validated FilteredLandmarks in image_normalized coordinates. */
export function toFilteredImageLandmarks(landmarks: PoseLandmark[], minVisibility: number): FilteredLandmark[] {
  return landmarks.map((lm) => {
    const conf = lm.visibility ?? lm.presence ?? 1;
    const finite = Number.isFinite(lm.x) && Number.isFinite(lm.y) && (lm.z === undefined || Number.isFinite(lm.z));
    const valid = finite && conf >= minVisibility;
    return {
      id: lm.id,
      x: finite ? lm.x : 0,
      y: finite ? lm.y : 0,
      z: lm.z !== undefined && Number.isFinite(lm.z) ? lm.z : null,
      valid,
      confidence: finite ? conf : 0,
      predicted: false,
      reason: valid ? undefined : finite ? 'LOW_CONFIDENCE' : 'MISSING_JOINT',
    };
  });
}

function mid(a: FilteredLandmark, b: FilteredLandmark): Vec3 {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: a.z !== null && b.z !== null ? (a.z + b.z) / 2 : null,
  };
}

export interface NormalizationResult {
  body: FilteredLandmark[];
  root_image: Vec3 | null;
  scale_px: number | null;
  valid: boolean;
  reason?: 'MISSING_JOINT' | 'DEGENERATE_GEOMETRY' | 'NORMALIZATION_INVALID';
}

/**
 * Root + scale normalization into the body_relative frame.
 *
 * root  = hip midpoint; scale = torso length (shoulder midpoint to hip midpoint) in pixels.
 * Coordinates are aspect-corrected first (x*W, y*H) so angles are metric-consistent.
 * Missing root or degenerate torso => NORMALIZATION_INVALID; nothing is invented.
 */
export function normalizeBodyRelative(image: FilteredLandmark[], imageSize: [number, number]): NormalizationResult {
  const [W, H] = imageSize;
  const byId = new Map(image.map((l) => [l.id, l]));
  const ls = byId.get(LANDMARK_INDEX['left_shoulder']);
  const rs = byId.get(LANDMARK_INDEX['right_shoulder']);
  const lh = byId.get(LANDMARK_INDEX['left_hip']);
  const rh = byId.get(LANDMARK_INDEX['right_hip']);
  const invalid = (reason: NormalizationResult['reason']): NormalizationResult => ({
    body: image.map((l) => ({ ...l, valid: false, reason: 'NORMALIZATION_INVALID' })),
    root_image: null,
    scale_px: null,
    valid: false,
    reason,
  });
  if (!ls || !rs || !lh || !rh || !ls.valid || !rs.valid || !lh.valid || !rh.valid) return invalid('MISSING_JOINT');

  const shoulderMid = mid(ls, rs);
  const hipMid = mid(lh, rh);
  const dx = (shoulderMid.x - hipMid.x) * W;
  const dy = (shoulderMid.y - hipMid.y) * H;
  const scalePx = Math.hypot(dx, dy);
  if (!(scalePx > EPS) || !Number.isFinite(scalePx) || !(W > 0) || !(H > 0)) return invalid('DEGENERATE_GEOMETRY');

  const body: FilteredLandmark[] = image.map((l) => ({
    ...l,
    x: ((l.x - hipMid.x) * W) / scalePx,
    y: ((l.y - hipMid.y) * H) / scalePx,
    z: l.z !== null && hipMid.z !== null ? ((l.z - hipMid.z) * W) / scalePx : l.z !== null ? (l.z * W) / scalePx : null,
  }));
  return { body, root_image: hipMid, scale_px: scalePx, valid: true };
}
