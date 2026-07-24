from .base import BaseAnalyzer, MIN_VISIBILITY
from typing import List, Dict, Any

class SquatAnalyzer(BaseAnalyzer):
    # These keypoints MUST be visible for a valid squat analysis
    REQUIRED_KEYPOINTS = [
        "left_hip", "right_hip", "left_knee", "right_knee",
        "left_ankle", "right_ankle", "left_shoulder", "right_shoulder"
    ]

    def analyze(self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        # Step 0: Visibility validation using base class
        vis_info = self.check_required_joints_visible(keypoints, actual_angles)
        visibility_ratio = vis_info["visibility_ratio"]
        missing_regions = vis_info["missing_regions"]

        # Additional squat-specific keypoint check
        kp_visibility = self.get_keypoint_visibility(keypoints)
        missing_critical = []
        for kp_name in self.REQUIRED_KEYPOINTS:
            if kp_visibility.get(kp_name, 0) < MIN_VISIBILITY:
                missing_critical.append(kp_name.replace("_", " "))

        issues = []

        # If critical keypoints for squats are missing, fail early
        if len(missing_critical) >= 4 or visibility_ratio < 0.5:
            missing_str = ", ".join(sorted(missing_regions)) if missing_regions else "lower body"
            issues.append({
                "joint": "body_visibility",
                "problem": f"Cannot detect your {missing_str}",
                "correction": "For squat analysis, your full body must be visible — especially hips, knees, and ankles. Step back from the camera.",
                "severity": "high"
            })
            if "hips" in missing_regions or "knees" in missing_regions or "ankles/feet" in missing_regions:
                issues.append({
                    "joint": "camera_position",
                    "problem": "Lower body not in frame",
                    "correction": "Position your camera further back or tilt it down to capture your legs and feet.",
                    "severity": "high"
                })
            return {
                "score": round(max(0, visibility_ratio * 30), 1),
                "issues": issues,
                "overall_severity": "error"
            }

        # Add partial visibility warning if some joints are missing
        if vis_info["missing_joints"]:
            issues.append({
                "joint": "partial_visibility",
                "problem": f"Some joints partially hidden: {', '.join(sorted(missing_regions))}",
                "correction": "Adjust your position so all joints are clearly visible for accurate feedback.",
                "severity": "medium"
            })

        score_deductions = 0

        # 1. Hip Depth (Hip relative to Knee)
        l_hip = self.get_kp(keypoints, 'left_hip')
        l_knee = self.get_kp(keypoints, 'left_knee')
        if l_hip['score'] > 0.5 and l_knee['score'] > 0.5:
            depth_error = l_knee['y'] - l_hip['y']
            if depth_error > 0.105: # 5% leniency allowance (0.10 -> 0.105)
                issues.append({
                    "joint": "hip",
                    "problem": "Hip depth insufficient",
                    "correction": "Go deeper for full range of motion. Lower your hips at least to knee level.",
                    "severity": "medium"
                })
                score_deductions += 20
        else:
            # Can't see hips/knees = can't assess depth
            issues.append({
                "joint": "hip",
                "problem": "Hip depth cannot be assessed",
                "correction": "Ensure your hips and knees are visible to the camera.",
                "severity": "medium"
            })
            score_deductions += 15

        # 2. Knee Tracking (Knee stability)
        l_ankle = self.get_kp(keypoints, 'left_ankle')
        r_ankle = self.get_kp(keypoints, 'right_ankle')
        r_knee = self.get_kp(keypoints, 'right_knee')

        if l_knee['score'] > 0.5 and r_knee['score'] > 0.5 and l_ankle['score'] > 0.5:
            if abs(l_knee['x'] - r_knee['x']) < 0.095: # 5% leniency allowance (0.10 -> 0.095)
                issues.append({
                    "joint": "knee",
                    "problem": "Knees collapsing inward",
                    "correction": "Press your knees outward to stay tracked over your toes.",
                    "severity": "high"
                })
                score_deductions += 30

        # 3. Torso Angle (Back Angle)
        l_shoulder = self.get_kp(keypoints, 'left_shoulder')
        if l_shoulder['score'] > 0.5 and l_hip['score'] > 0.5:
            vert_deviation = abs(l_shoulder['x'] - l_hip['x'])
            if vert_deviation > 0.1575: # 5% leniency allowance (0.15 -> 0.1575)
                issues.append({
                    "joint": "back",
                    "problem": "Leaning too far forward",
                    "correction": "Keep your chest upright and back straight throughout the movement.",
                    "severity": "medium"
                })
                score_deductions += 15

        # 4. Also run the base angle comparison with 5% leniency
        for joint, actual_angle in actual_angles.items():
            if joint not in self.ref_angles:
                continue
            if actual_angle < 0:
                continue
            ref_angle = self.ref_angles[joint]
            raw_error = abs(actual_angle - ref_angle)
            effective_error = max(0.0, raw_error - (ref_angle * 0.05))
            if effective_error > 30:
                score_deductions += 5  # Small additional penalty from blueprint mismatch

        # Apply visibility cap with 5% score leniency boost
        raw_score = max(0, 100 - score_deductions)
        leniency_score = min(100.0, raw_score * 1.05)
        visibility_cap = visibility_ratio * 100
        final_score = min(leniency_score, visibility_cap)

        return {
            "score": round(final_score, 1),
            "issues": issues,
            "overall_severity": "good" if final_score >= 76 else ("warning" if final_score >= 45 else "error")
        }
