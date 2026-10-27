import { CORE_BODY_LANDMARKS, LANDMARK_INDEX, type MissingReason, type PoseFrame, type PoseLandmark } from '@apexformz/contracts';

export interface FramingResult {
  framing_ok: boolean;
  missing_joints: number[];
  /** Core joints outside the safe image margin. */
  out_of_frame: number[];
}

/**
 * Framing check: the core body joints must be visible and inside the image
 * with a margin. Returns ids, never invents positions.
 */
export function checkFraming(landmarks: PoseLandmark[], minVisibility = 0.5, margin = 0.02): FramingResult {
  const missing: number[] = [];
  const out: number[] = [];
  for (const name of CORE_BODY_LANDMARKS) {
    const id = LANDMARK_INDEX[name];
    const l = landmarks[id];
    if (!l) {
      missing.push(id);
      continue;
    }
    const v = l.visibility ?? l.presence ?? 1;
    if (v < minVisibility) missing.push(id);
    else if (l.x < margin || l.x > 1 - margin || l.y < margin || l.y > 1 - margin) out.push(id);
  }
  return { framing_ok: missing.length === 0 && out.length === 0, missing_joints: missing, out_of_frame: out };
}

export interface QualityGate {
  ok: boolean;
  reasons: MissingReason[];
}

/** Decide whether criterion feedback may proceed for this frame (TRD 02/14). */
export function gatePoseQuality(frame: PoseFrame): QualityGate {
  const reasons: MissingReason[] = [];
  if (frame.quality.ambiguous_people) reasons.push('AMBIGUOUS_SUBJECT');
  if (!frame.quality.framing_ok) reasons.push('FRAMING_INVALID');
  if (frame.quality.track_changed) reasons.push('TRACK_CHANGED');
  if (frame.quality.missing_joints.length) reasons.push('MISSING_JOINT');
  return { ok: reasons.length === 0, reasons };
}
