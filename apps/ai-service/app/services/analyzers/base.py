import math
import os
import json
from typing import Dict, List, Any, Set

# Load data locally for the service
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
# Note: we go two levels up from 'app/services/analyzers/' to 'app/', then into 'data/'
DATA_FILE_PATH = os.path.join(DATA_DIR, '..', '..', 'data', 'reference_poses.json')

with open(DATA_FILE_PATH, 'r') as f:
    REFERENCE_POSES = json.load(f)

# Define which keypoints are REQUIRED to be visible for each joint angle.
# If ANY of the 3 keypoints needed to compute a joint angle are missing,
# that joint is considered "not visible."
JOINT_KEYPOINTS = {
    "left_elbow": ["left_shoulder", "left_elbow", "left_wrist"],
    "right_elbow": ["right_shoulder", "right_elbow", "right_wrist"],
    "left_shoulder": ["left_hip", "left_shoulder", "left_elbow"],
    "right_shoulder": ["right_hip", "right_shoulder", "right_elbow"],
    "left_hip": ["left_shoulder", "left_hip", "left_knee"],
    "right_hip": ["right_shoulder", "right_hip", "right_knee"],
    "left_knee": ["left_hip", "left_knee", "left_ankle"],
    "right_knee": ["right_hip", "right_knee", "right_ankle"],
}

# Minimum visibility score to consider a keypoint "detected"
MIN_VISIBILITY = 0.3

# Minimum ratio of visible required joints before we trust the score.
# Below this, the score is heavily penalized.
MIN_VISIBILITY_RATIO = 0.5


class BaseAnalyzer:
    def __init__(self, sport: str, pose_id: str):
        self.sport = sport
        self.pose_id = pose_id
        # Load blueprint from reference_poses
        sport_poses = REFERENCE_POSES.get(sport, {})
        self.blueprint = sport_poses.get(pose_id, {})
        self.ref_angles = {k: v for k, v in self.blueprint.items() if k != 'cues'}
        self.cues = self.blueprint.get('cues', {})

    def get_keypoint_visibility(self, keypoints: List[Dict[str, Any]]) -> Dict[str, float]:
        """Returns a map of keypoint name -> visibility score."""
        visibility = {}
        for kp in keypoints:
            name = kp.get('name', '')
            score = kp.get('score', 0)
            visibility[name] = score
        return visibility

    def check_required_joints_visible(
        self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        Checks which of the reference joints are visible in the current frame.
        Returns:
          - visible_joints: set of joint names that have valid angles
          - missing_joints: set of joint names that are in the reference but NOT visible
          - visibility_ratio: fraction of required joints that are visible
          - missing_body_regions: human-readable names of missing body parts
        """
        visibility = self.get_keypoint_visibility(keypoints)

        required_joints = set(self.ref_angles.keys())
        visible_joints: Set[str] = set()
        missing_joints: Set[str] = set()

        for joint in required_joints:
            if joint in actual_angles and actual_angles[joint] >= 0:
                # The angle was successfully computed
                visible_joints.add(joint)
            else:
                # Check WHY it's missing: which keypoints are below threshold?
                needed_kps = JOINT_KEYPOINTS.get(joint, [])
                all_visible = all(
                    visibility.get(kp_name, 0) >= MIN_VISIBILITY
                    for kp_name in needed_kps
                )
                if all_visible and joint in actual_angles:
                    visible_joints.add(joint)
                else:
                    missing_joints.add(joint)

        total_required = len(required_joints) if required_joints else 1
        visibility_ratio = len(visible_joints) / total_required

        # Determine which body regions are missing for user-friendly feedback
        missing_regions = set()
        for joint in missing_joints:
            if "hip" in joint:
                missing_regions.add("hips")
            elif "knee" in joint:
                missing_regions.add("knees")
            elif "ankle" in joint:
                missing_regions.add("ankles/feet")
            elif "shoulder" in joint:
                missing_regions.add("shoulders")
            elif "elbow" in joint:
                missing_regions.add("arms")

        return {
            "visible_joints": visible_joints,
            "missing_joints": missing_joints,
            "visibility_ratio": visibility_ratio,
            "missing_regions": missing_regions,
        }

    def get_mirrored_blueprint(self, blueprint: Dict[str, float]) -> Dict[str, float]:
        mirrored = {}
        for joint, angle in blueprint.items():
            if joint.startswith("left_"):
                mirrored["right_" + joint[5:]] = angle
            elif joint.startswith("right_"):
                mirrored["left_" + joint[6:]] = angle
            else:
                mirrored[joint] = angle
        return mirrored

    def _score_blueprint(self, ref_angles: Dict[str, float], actual_angles: Dict[str, float], visibility_ratio: float, missing_regions: Set[str]) -> Dict[str, Any]:
        issues = []
        total_error = 0
        joints_checked = 0
        
        # INCREASED LENIENCY: Webcams cause 2D projection artifacts.
        # We allow 10% leniency, or a flat 15 degree buffer for every joint.
        LENIENCY_PERCENT = 0.10
        MIN_LENIENCY_DEG = 15.0

        for joint, actual_angle in actual_angles.items():
            if joint not in ref_angles:
                continue
            if actual_angle < 0:
                continue

            ref_angle = ref_angles[joint]
            raw_error = abs(actual_angle - ref_angle)
            
            angle_leniency = max(ref_angle * LENIENCY_PERCENT, MIN_LENIENCY_DEG)
            effective_error = max(0.0, raw_error - angle_leniency)
            
            total_error += effective_error
            joints_checked += 1

            severity = "none"
            if effective_error > 30:
                severity = "high"
            elif effective_error > 15:
                severity = "medium"

            if severity != "none":
                error_dir = "high" if actual_angle > ref_angle else "low"
                specific_key = f"{joint}_{error_dir}"

                problem = f"{joint.replace('_', ' ')} is out of alignment"
                msg = self.cues.get(specific_key) or self.cues.get(joint)

                if not msg:
                    msg = f"Adjust your {joint.replace('_', ' ')}. Target: {ref_angle}°, Actual: {int(actual_angle)}°."

                issues.append({
                    "joint": joint,
                    "problem": problem.capitalize(),
                    "correction": msg,
                    "severity": severity
                })

        avg_error = total_error / joints_checked if joints_checked > 0 else 90
        accuracy_score = max(0, min(100, 100 - (avg_error * (100 / 90))))
        leniency_score = min(100.0, accuracy_score * 1.05)
        visibility_cap = visibility_ratio * 100
        final_score = min(leniency_score, visibility_cap)

        if joints_checked == 0:
            final_score = 0
            issues.append({
                "joint": "body_visibility",
                "problem": "No matching joints detected",
                "correction": f"Make sure your full body is visible.",
                "severity": "high"
            })

        return {
            "score": round(final_score, 1),
            "issues": issues,
            "overall_severity": "good" if final_score >= 76 else ("warning" if final_score >= 45 else "error")
        }

    def analyze(self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        vis_info = self.check_required_joints_visible(keypoints, actual_angles)
        visibility_ratio = vis_info["visibility_ratio"]
        missing_joints = vis_info["missing_joints"]
        missing_regions = vis_info["missing_regions"]

        # If completely missing, return early
        if visibility_ratio < MIN_VISIBILITY_RATIO:
            missing_str = ", ".join(sorted(missing_regions)) if missing_regions else "key body parts"
            issues = [{
                "joint": "body_visibility",
                "problem": f"Cannot detect your {missing_str}",
                "correction": f"Please ensure your full body is visible in the camera frame for '{self.pose_id.replace('_', ' ')}'. Step back or adjust camera angle.",
                "severity": "high"
            }]
            if "hips" in missing_regions or "knees" in missing_regions or "ankles/feet" in missing_regions:
                issues.append({
                    "joint": "camera_position",
                    "problem": "Lower body not detected",
                    "correction": "Position your camera further back or tilt it down to include your legs and feet in the frame.",
                    "severity": "high"
                })
            penalty_score = max(0, visibility_ratio * 40)
            return {
                "score": round(penalty_score, 1),
                "issues": issues,
                "overall_severity": "error"
            }

        # Calculate standard score
        std_result = self._score_blueprint(self.ref_angles, actual_angles, visibility_ratio, missing_regions)
        
        # Calculate mirrored score (solves asymmetry false positives for all poses)
        mirrored_angles = self.get_mirrored_blueprint(self.ref_angles)
        mirrored_result = self._score_blueprint(mirrored_angles, actual_angles, visibility_ratio, missing_regions)

        # Pick whichever orientation matches the user's pose better!
        best_result = std_result if std_result['score'] >= mirrored_result['score'] else mirrored_result

        # Add partial visibility warnings if necessary
        if missing_joints:
            missing_str = ", ".join(sorted(missing_regions)) if missing_regions else "some joints"
            best_result['issues'].insert(0, {
                "joint": "partial_visibility",
                "problem": f"Partially hidden: {missing_str}",
                "correction": f"Some joints are obscured. Try to keep your full body visible for the best analysis.",
                "severity": "medium"
            })

        return best_result

    @staticmethod
    def calculate_angle(p1, p2, p3):
        """Angle at p2."""
        if not p1 or not p2 or not p3 or p1.get('score', 0) < 0.3 or p2.get('score', 0) < 0.3 or p3.get('score', 0) < 0.3:
            return -1.0
        radians = math.atan2(p3['y'] - p2['y'], p3['x'] - p2['x']) - \
                  math.atan2(p1['y'] - p2['y'], p1['x'] - p2['x'])
        angle = abs(radians * 180.0 / math.pi)
        if angle > 180.0: angle = 360 - angle
        return angle

    @staticmethod
    def get_kp(keypoints: List[Dict[str, Any]], name: str) -> Dict[str, Any]:
        for kp in keypoints:
            if kp['name'] == name:
                return kp
        return {"x": 0, "y": 0, "score": 0, "name": name}
