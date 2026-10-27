"""
Frame Matcher — Nearest-Neighbor Pose Validation Against Expert Data

Loads a pre-extracted database of expert reference frames (joint angles)
and validates the user's current pose by finding the closest expert frame.

How it works:
  1. For a given movement (e.g. "ap_chagi_front_kick"), load all expert
     reference frames — thousands of angle snapshots from 3 camera views.
  2. On each user frame, compute the Euclidean distance in joint-angle
     space between the user and every expert frame.
  3. Find the Nearest Neighbor (the closest expert frame).
  4. If the distance is below a tolerance, the pose is "Correct" (cyan).
  5. If above, identify which joints are off and return issues (red).

The FrameMatcher is used ALONGSIDE the PhaseDetector (which tracks the
movement sequence). The PhaseDetector handles time-sequence enforcement,
while the FrameMatcher handles pose quality validation.

This module is completely independent of the static pose analysis system.
"""

import os
import json
import math
from typing import Dict, List, Any, Optional, Tuple

# ── Constants ─────────────────────────────────────────────────────────

# Per-joint tolerance (degrees). If a joint differs by less than this
# from the nearest expert frame, it is considered correct.
DEFAULT_JOINT_TOLERANCE = 12.0

# Per-joint severity thresholds
SEVERITY_THRESHOLDS = {
    "medium": 12.0,   # 12-25° off = yellow/medium
    "high":   25.0,   # 25°+ off = red/high
}

# Joints ordered by biomechanical importance for scoring weight
JOINT_WEIGHTS = {
    # Taekwondo scoring prioritizes the pelvis, kicking leg and balance.
    "left_hip":       1.5,
    "right_hip":      1.5,
    "left_knee":      1.6,
    "right_knee":     1.6,
    "left_ankle":     1.4,
    "right_ankle":    1.4,
    "left_shoulder":  0.7,
    "right_shoulder": 0.7,
    "left_elbow":     0.4,
    "right_elbow":    0.4,
}

# Cue templates for common errors
CUE_TEMPLATES = {
    "left_hip":       "Adjust your left hip angle. {detail}",
    "right_hip":      "Adjust your right hip angle. {detail}",
    "left_knee":      "Correct your left knee bend. {detail}",
    "right_knee":     "Correct your right knee bend. {detail}",
    "left_shoulder":  "Fix your left shoulder position. {detail}",
    "right_shoulder": "Fix your right shoulder position. {detail}",
    "left_elbow":     "Adjust your left arm. {detail}",
    "right_elbow":    "Adjust your right arm. {detail}",
    "left_ankle":     "Correct your left foot and ankle line. {detail}",
    "right_ankle":    "Correct your right foot and ankle line. {detail}",
}


# ── FrameMatcher ──────────────────────────────────────────────────────

class FrameMatcher:
    """
    Nearest-neighbor pose validator against expert reference frames.

    Loaded once per AI-service startup. Holds all expert frames in memory
    for fast lookup (typical dataset: ~500-2000 unique frames per movement,
    each frame is 8 floats — trivial memory footprint).
    """

    _instance = None  # Singleton

    def __init__(self):
        self._database: Dict[str, List[Dict[str, float]]] = {}
        self._loaded = False

    @classmethod
    def get_instance(cls) -> "FrameMatcher":
        """Singleton accessor — loads the database once."""
        if cls._instance is None:
            cls._instance = cls()
            cls._instance._load_database()
        elif not cls._instance._loaded:
            # Retry loading if it failed previously (e.g. file was not ready)
            cls._instance._load_database()
        return cls._instance

    def _load_database(self):
        """Load the pre-extracted reference frames JSON."""
        data_path = os.path.join(
            os.path.dirname(__file__),
            "..", "..", "data", "taekwondo_reference_frames.json"
        )
        data_path = os.path.abspath(data_path)

        if not os.path.exists(data_path):
            print(f"[FrameMatcher] Reference frames not found at {data_path}")
            print("[FrameMatcher] Run extract_reference_frames.py first.")
            self._loaded = False
            return

        with open(data_path, "r") as f:
            raw = json.load(f)

        for movement_key, data in raw.items():
            frames = data.get("frames", [])
            start_frames = data.get("start_frames", [])
            self._database[movement_key] = frames
            self._database[f"{movement_key}_start_frames"] = start_frames
            print(f"[FrameMatcher] Loaded {len(frames)} reference frames and {len(start_frames)} start frames for {movement_key}")

        self._loaded = True
        total = sum(len(v) for v in self._database.values())
        print(f"[FrameMatcher] Total: {total} reference frames across {len(self._database)} movements")

    @property
    def available(self) -> bool:
        return self._loaded and len(self._database) > 0

    def has_movement(self, movement_key: str) -> bool:
        return movement_key in self._database and len(self._database[movement_key]) > 0

    def find_nearest(
        self,
        movement_key: str,
        user_angles: Dict[str, float],
        joint_weights: Dict[str, float] = None,
    ) -> Tuple[Optional[Dict[str, float]], float]:
        """
        Find the nearest expert frame to the user's current pose.

        Returns:
            (nearest_frame, distance) or (None, inf) if no match.
        """
        if not self.has_movement(movement_key):
            return None, float("inf")

        ref_frames = self._database[movement_key]
        best_frame = None
        best_dist = float("inf")

        for ref in ref_frames:
            dist = self._weighted_distance(user_angles, ref, joint_weights)
            if dist < best_dist:
                best_dist = dist
                best_frame = ref

        return best_frame, best_dist

    def find_nearest_start(
        self,
        movement_key: str,
        user_angles: Dict[str, float],
        joint_weights: Dict[str, float] = None,
    ) -> Tuple[Optional[Dict[str, float]], float]:
        """Find the nearest start frame (from front/left/right video starts)."""
        if movement_key not in self._database:
            return None, float("inf")
        
        start_frames = self._database.get(f"{movement_key}_start_frames", [])
        if not start_frames:
            # Fallback if the database doesn't have start frames extracted yet
            return self.find_nearest(movement_key, user_angles, joint_weights)

        best_frame = None
        best_dist = float("inf")

        for ref in start_frames:
            dist = self._weighted_distance(user_angles, ref, joint_weights)
            if dist < best_dist:
                best_dist = dist
                best_frame = ref

        return best_frame, best_dist

    def score_start_stance(
        self,
        movement_key: str,
        user_angles: Dict[str, float],
        ignored_joints: List[str] = None,
        joint_weights: Dict[str, float] = None,
    ) -> Dict[str, Any]:
        """
        Score a user frame ONLY against the exact starting frames.
        Used to strictly validate that the user is in the Ready Stance before starting.
        """
        nearest, dist = self.find_nearest_start(movement_key, user_angles, joint_weights)
        return self._compute_score_from_nearest(movement_key, user_angles, nearest, dist, ignored_joints, joint_weights)

    def score_frame(
        self,
        movement_key: str,
        user_angles: Dict[str, float],
        joint_tolerance: float = DEFAULT_JOINT_TOLERANCE,
        ignored_joints: List[str] = None,
        joint_weights: Dict[str, float] = None,
    ) -> Dict[str, Any]:
        """
        Score a user frame against the full expert database (Dynamic motion).
        """
        nearest, dist = self.find_nearest(movement_key, user_angles, joint_weights)
        return self._compute_score_from_nearest(movement_key, user_angles, nearest, dist, ignored_joints, joint_weights)

    def _compute_score_from_nearest(
        self,
        movement_key: str,
        user_angles: Dict[str, float],
        nearest: Optional[Dict[str, float]],
        dist: float,
        ignored_joints: List[str] = None,
        joint_weights: Dict[str, float] = None,
    ) -> Dict[str, Any]:
        """Helper to compute issues and score given a nearest frame."""
        if nearest is None:
            if self.has_movement(movement_key):
                return {
                    "score": 0.0,
                    "issues": [{
                        "joint": "visibility",
                        "problem": "Not enough joints visible for comparison",
                        "correction": "Move farther from the camera and make sure your full body is visible.",
                        "severity": "high",
                    }],
                    "nearest_frame": None,
                    "distance": dist,
                    "matched": False,
                }

            return {
                "score": 0.0,
                "issues": [{
                    "joint": "system",
                    "problem": f"No reference data for movement '{movement_key}'",
                    "correction": "This movement may not have been extracted yet.",
                    "severity": "high",
                }],
                "nearest_frame": None,
                "distance": dist,
                "matched": False,
            }

        ignored = ignored_joints or []

        # Compare each joint against the nearest expert frame
        issues = []
        total_error = 0.0
        total_weight = 0.0
        joints_checked = 0

        weights = joint_weights or JOINT_WEIGHTS
        for joint, weight in weights.items():
            if joint in ignored:
                continue
                
            user_val = user_angles.get(joint, -1)
            ref_val = nearest.get(joint, -1)

            if user_val < 0 or ref_val < 0:
                continue  # Joint not visible in user or reference

            error = abs(user_val - ref_val)
            total_error += error * weight
            total_weight += weight
            joints_checked += 1

            # Determine severity
            severity = "none"
            if error > SEVERITY_THRESHOLDS["high"]:
                severity = "high"
            elif error > SEVERITY_THRESHOLDS["medium"]:
                severity = "medium"

            if severity != "none":
                direction = "too open" if user_val > ref_val else "too closed"
                detail = f"Currently {int(user_val)}°, should be closer to {int(ref_val)}° ({direction})."
                cue = CUE_TEMPLATES.get(joint, "Adjust your {joint}. {detail}")
                cue = cue.format(detail=detail, joint=joint.replace("_", " "))

                issues.append({
                    "joint": joint,
                    "problem": f"{joint.replace('_', ' ')} is {int(error)}° off from expert form",
                    "correction": cue,
                    "severity": severity,
                    "ref_angle": ref_val,
                    "user_angle": user_val,
                })

        if joints_checked == 0:
            return {
                "score": 0.0,
                "issues": [{
                    "joint": "visibility",
                    "problem": "Not enough joints visible for comparison",
                    "correction": "Make sure your full body is visible to the camera.",
                    "severity": "high",
                }],
                "nearest_frame": nearest,
                "distance": dist,
                "matched": False,
            }

        # Compute score: weighted average error -> 0-100 scale
        weighted_avg_error = total_error / total_weight
        # 0 error = 100 score, 40° avg error = 0 score
        score = max(0.0, min(100.0, 100.0 * (1.0 - weighted_avg_error / 40.0)))

        return {
            "score": round(score, 1),
            "issues": issues,
            "nearest_frame": nearest,
            "distance": round(dist, 2),
            "matched": len(issues) == 0,
        }

    @staticmethod
    def _weighted_distance(
        user_angles: Dict[str, float],
        ref_angles: Dict[str, float],
        joint_weights: Dict[str, float] = None,
    ) -> float:
        """
        Weighted Euclidean distance in joint-angle space.
        Only considers joints visible in BOTH frames.
        """
        total = 0.0
        weight_sum = 0.0

        for joint, weight in (joint_weights or JOINT_WEIGHTS).items():
            u = user_angles.get(joint, -1)
            r = ref_angles.get(joint, -1)
            if u >= 0 and r >= 0:
                total += weight * (u - r) ** 2
                weight_sum += weight

        if weight_sum == 0:
            return float("inf")

        return math.sqrt(total / weight_sum)
