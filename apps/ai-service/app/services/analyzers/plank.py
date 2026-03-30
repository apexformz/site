from .base import BaseAnalyzer, MIN_VISIBILITY
from typing import List, Dict, Any

class PlankAnalyzer(BaseAnalyzer):
    # These keypoints MUST be visible for a valid plank analysis
    REQUIRED_KEYPOINTS = [
        "left_shoulder", "right_shoulder", "left_hip", "right_hip",
        "left_ankle", "right_ankle", "left_elbow", "right_elbow"
    ]

    def analyze(self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        # Step 0: Visibility validation using base class
        vis_info = self.check_required_joints_visible(keypoints, actual_angles)
        visibility_ratio = vis_info["visibility_ratio"]
        missing_regions = vis_info["missing_regions"]

        # Additional plank-specific keypoint check
        kp_visibility = self.get_keypoint_visibility(keypoints)
        missing_critical = []
        for kp_name in self.REQUIRED_KEYPOINTS:
            if kp_visibility.get(kp_name, 0) < MIN_VISIBILITY:
                missing_critical.append(kp_name.replace("_", " "))

        issues = []

        # If critical keypoints for plank are missing, fail early
        if len(missing_critical) >= 4 or visibility_ratio < 0.5:
            missing_str = ", ".join(sorted(missing_regions)) if missing_regions else "full body"
            issues.append({
                "joint": "body_visibility",
                "problem": f"Cannot detect your {missing_str}",
                "correction": "For plank analysis, your full body from shoulders to ankles must be visible. Use a side-angle camera position.",
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
                "correction": "Adjust your camera to capture your full body from a side angle.",
                "severity": "medium"
            })

        score_deductions = 0

        # 1. Body Alignment (Shoulder -> Hip -> Ankle)
        l_shoulder = self.get_kp(keypoints, 'left_shoulder')
        l_hip = self.get_kp(keypoints, 'left_hip')
        l_ankle = self.get_kp(keypoints, 'left_ankle')

        alignment_angle = self.calculate_angle(l_shoulder, l_hip, l_ankle)

        if alignment_angle > 0:
            deviation = abs(180 - alignment_angle)
            if deviation > 20:
                mid_y = (l_shoulder['y'] + l_ankle['y']) / 2
                if l_hip['y'] < mid_y - 0.05:
                    issues.append({
                        "joint": "hip",
                        "problem": "Hips too high",
                        "correction": "Lower your hips to align with your shoulders and create a straight line.",
                        "severity": "high"
                    })
                else:
                    issues.append({
                        "joint": "hip",
                        "problem": "Hips sagging",
                        "correction": "Engage your core and lift your hips slightly to prevent lower back strain.",
                        "severity": "high"
                    })
                score_deductions += deviation
        else:
            # Can't compute alignment = can't assess plank
            issues.append({
                "joint": "alignment",
                "problem": "Body alignment cannot be assessed",
                "correction": "Ensure your shoulder, hip, and ankle are all visible from a side angle.",
                "severity": "high"
            })
            score_deductions += 40

        # 2. Shoulder Stacking (Shoulder over Elbow)
        l_elbow = self.get_kp(keypoints, 'left_elbow')
        if l_shoulder['score'] > 0.5 and l_elbow['score'] > 0.5:
            horiz_dist = abs(l_shoulder['x'] - l_elbow['x'])
            if horiz_dist > 0.1:
                issues.append({
                    "joint": "shoulder",
                    "problem": "Shoulders not stacked",
                    "correction": "Move your shoulders directly above your elbows for better stability.",
                    "severity": "medium"
                })
                score_deductions += 15

        # 3. Neck Alignment (Ear to Shoulder vs Spine)
        l_ear = self.get_kp(keypoints, 'left_ear')
        if l_ear['score'] > 0.5 and l_shoulder['score'] > 0.5 and l_hip['score'] > 0.5:
            neck_angle = self.calculate_angle(l_ear, l_shoulder, l_hip)
            if neck_angle > 0 and neck_angle < 150:
                issues.append({
                    "joint": "neck",
                    "problem": "Neck not neutral",
                    "correction": "Keep your neck neutral and avoid dropping your head.",
                    "severity": "low"
                })
                score_deductions += 10

        # Apply visibility cap
        raw_score = max(0, 100 - score_deductions)
        visibility_cap = visibility_ratio * 100
        final_score = min(raw_score, visibility_cap)

        return {
            "score": round(final_score, 1),
            "issues": issues,
            "overall_severity": "good" if final_score >= 80 else ("warning" if final_score >= 50 else "error")
        }
