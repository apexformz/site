import type { PoseFrame } from '@apexformz/contracts';

export interface SourceOrientationReview {
  stream_id: string;
  source_pose_sha256: string;
  source_media_sha256: string;
  rotation_degrees: 0 | 180;
  review_evidence: string;
  review_evidence_sha256: string;
}

/** A capture-level correction only. It never relabels anatomical sides or repairs individual bad poses. */
export function rotateRecordedPose180(frame: PoseFrame): PoseFrame {
  return {
    ...frame,
    normalized_landmarks: frame.normalized_landmarks.map(lm => ({ ...lm, x: 1 - lm.x, y: 1 - lm.y })),
    ...(frame.world_landmarks ? { world_landmarks: frame.world_landmarks.map(lm => ({ ...lm, x: -lm.x, y: -lm.y })) } : {}),
  };
}

export function sourceOrientationReview(source: Pick<SourceOrientationReview, 'stream_id' | 'source_pose_sha256' | 'source_media_sha256'>, reviews: SourceOrientationReview[]): SourceOrientationReview | undefined {
  const review = reviews.find(r => r.stream_id === source.stream_id);
  if (review && (review.source_media_sha256 !== source.source_media_sha256 || review.source_pose_sha256 !== source.source_pose_sha256 || ![0, 180].includes(review.rotation_degrees))) throw new Error(`Orientation provenance mismatch: ${source.stream_id}`);
  return review;
}

/** A squat/forward bend may lower the head; feet above the pelvis at the same time contradict an upright squash capture. */
export function recordedBodyOrientationIssue(frame: PoseFrame): 'INVERTED_BODY_GEOMETRY' | 'ORIENTATION_AMBIGUOUS' | null {
  const get = (id: number) => {
    const lm = frame.normalized_landmarks.find(p => p.id === id);
    return lm && Number.isFinite(lm.y) && (lm.visibility ?? lm.presence ?? 1) >= .5 && !frame.quality.missing_joints.includes(id) ? lm.y : null;
  };
  const head = get(0), hips = [get(23), get(24)], shoulders = [get(11), get(12)], ankles = [get(27), get(28)];
  if (head === null || [...hips, ...shoulders].some(v => v === null)) return null;
  const pelvis = (hips[0]! + hips[1]!) / 2;
  if (!(head > pelvis + .02 && (shoulders[0]! + shoulders[1]!) / 2 > pelvis + .02)) return null;
  const x = (id: number) => frame.normalized_landmarks.find(p => p.id === id)!.x;
  const horizontal = Math.abs((x(11) + x(12) - x(23) - x(24)) / 2) * frame.image_size[0];
  const downward = ((shoulders[0]! + shoulders[1]!) / 2 - pelvis) * frame.image_size[1];
  // Nearly vertical upside-down torsos also occur when the detector swaps upper/lower
  // body joints while hallucinating feet below them. Exclude this ambiguous squash
  // source evidence; do not turn it into a directional template or flip it locally.
  if (downward > horizontal * 2 && head > (shoulders[0]! + shoulders[1]!) / 2) {
    return ankles.every(v => v !== null) && Math.max(...ankles as number[]) < pelvis - .02 ? 'INVERTED_BODY_GEOMETRY' : 'ORIENTATION_AMBIGUOUS';
  }
  // A visibly bent torso is acceptable when both feet establish upright body orientation.
  // Missing feet cannot disambiguate a bend from an upside-down detector hypothesis.
  if (ankles.some(v => v === null)) return 'ORIENTATION_AMBIGUOUS';
  if (Math.max(...ankles as number[]) < pelvis - .02) return 'INVERTED_BODY_GEOMETRY';
  return Math.min(...ankles as number[]) > pelvis + .02 ? null : 'ORIENTATION_AMBIGUOUS';
}

export const hasInvertedBodyEvidence = (frame: PoseFrame): boolean => recordedBodyOrientationIssue(frame) === 'INVERTED_BODY_GEOMETRY';
