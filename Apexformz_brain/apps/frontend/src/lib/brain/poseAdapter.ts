import { MEDIAPIPE_POSE_33, type PoseFrame } from '@apexformz/contracts';
import type { PoseKeypoints } from '@smartcoach/types';

/**
 * Convert a Brain PoseFrame (image_normalized coordinates) into the legacy
 * pixel-space `PoseKeypoints` shape consumed by PoseSkeleton. Display dimensions
 * may differ from detector input dimensions after adaptive capture resizing.
 */
export function poseFrameToLegacyKeypoints(frame: PoseFrame, displaySize: [number, number] = frame.image_size): PoseKeypoints | null {
  if (!frame.normalized_landmarks.length) return null;
  const [W, H] = displaySize;
  return {
    keypoints: frame.normalized_landmarks.map((l) => ({
      x: l.x * W,
      y: l.y * H,
      z: l.z !== undefined ? l.z * W : undefined,
      score: l.visibility ?? l.presence ?? 1,
      name: MEDIAPIPE_POSE_33[l.id] ?? `point_${l.id}`,
    })),
    score: frame.quality.detection_confidence ?? 0.8,
    timestamp_ms: frame.timestamp_ms,
  };
}
