from .base import BaseAnalyzer
from typing import List, Dict, Any

class SquatAnalyzer(BaseAnalyzer):
    def analyze(self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        issues = []
        score_deductions = 0
        
        # 1. Hip Depth (Hip relative to Knee)
        l_hip = self.get_kp(keypoints, 'left_hip')
        l_knee = self.get_kp(keypoints, 'left_knee')
        if l_hip['score'] > 0.5 and l_knee['score'] > 0.5:
            # Mediapipe: Y increases downwards. So Depth = Hip.y - Knee.y
            # For a deep squat, Hip.y should be >= Knee.y (at least level)
            depth_error = l_knee['y'] - l_hip['y'] # positive means hip is above knee
            if depth_error > 0.1: # More than 10% vertical screen height above knee
                issues.append({
                    "joint": "hip",
                    "problem": "Hip depth insufficient",
                    "correction": "Go deeper for full range of motion. Lower your hips at least to knee level.",
                    "severity": "medium"
                })
                score_deductions += 20

        # 2. Knee Tracking (Knee stability)
        l_ankle = self.get_kp(keypoints, 'left_ankle')
        r_ankle = self.get_kp(keypoints, 'right_ankle')
        r_knee = self.get_kp(keypoints, 'right_knee')
        
        # Check for knee collapse (valgus)
        if l_knee['score'] > 0.5 and l_ankle['score'] > 0.5:
            if abs(l_knee['x'] - r_knee['x']) < 0.1: # Knees touching or too close
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
            # Check how vertical the spine is. 
            # Vector: Hip -> Shoulder. Ideally mostly vertical.
            vert_deviation = abs(l_shoulder['x'] - l_hip['x'])
            if vert_deviation > 0.15: # Leaning too far forward
                issues.append({
                    "joint": "back",
                    "problem": "Leaning too far forward",
                    "correction": "Keep your chest upright and back straight throughout the movement.",
                    "severity": "medium"
                })
                score_deductions += 15

        final_score = max(0, 100 - score_deductions)

        return {
            "score": round(final_score, 1),
            "issues": issues,
            "overall_severity": "good" if final_score >= 80 else ("warning" if final_score >= 50 else "error")
        }
