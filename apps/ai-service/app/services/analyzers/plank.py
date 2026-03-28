from .base import BaseAnalyzer
from typing import List, Dict, Any

class PlankAnalyzer(BaseAnalyzer):
    def analyze(self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        issues = []
        score_deductions = 0
        
        # 1. Body Alignment (Shoulder -> Hip -> Ankle)
        l_shoulder = self.get_kp(keypoints, 'left_shoulder')
        l_hip = self.get_kp(keypoints, 'left_hip')
        l_ankle = self.get_kp(keypoints, 'left_ankle')
        
        alignment_angle = self.calculate_angle(l_shoulder, l_hip, l_ankle)
        
        if alignment_angle > 0:
            # For a perfect plank, this should be 180 deg
            deviation = abs(180 - alignment_angle)
            if deviation > 20:
                # Check if hips are high or low based on Y coordinates
                # In mediapipe, Y increases downwards
                # If Hip.y < mid(Shoulder.y, Ankle.y), hips are HIGH (above the line)
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

        # 2. Shoulder Stacking (Shoulder over Elbow)
        l_elbow = self.get_kp(keypoints, 'left_elbow')
        if l_shoulder['score'] > 0.5 and l_elbow['score'] > 0.5:
            horiz_dist = abs(l_shoulder['x'] - l_elbow['x'])
            if horiz_dist > 0.1: # Threshold for not being stacked
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
            if neck_angle < 150: # Neck is dropping or looking too far up
                issues.append({
                    "joint": "neck",
                    "problem": "Neck not neutral",
                    "correction": "Keep your neck neutral and avoid dropping your head.",
                    "severity": "low"
                })
                score_deductions += 10

        final_score = max(0, 100 - (score_deductions))
        
        return {
            "score": round(final_score, 1),
            "issues": issues,
            "overall_severity": "good" if final_score >= 80 else ("warning" if final_score >= 50 else "error")
        }
