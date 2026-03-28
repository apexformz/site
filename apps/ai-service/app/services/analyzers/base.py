import math
import os
import json
from typing import Dict, List, Any

# Load data locally for the service
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
# Note: we go two levels up from 'app/services/analyzers/' to 'app/', then into 'data/'
DATA_FILE_PATH = os.path.join(DATA_DIR, '..', '..', 'data', 'reference_poses.json')

with open(DATA_FILE_PATH, 'r') as f:
    REFERENCE_POSES = json.load(f)

class BaseAnalyzer:
    def __init__(self, sport: str, pose_id: str):
        self.sport = sport
        self.pose_id = pose_id
        # Load blueprint from reference_poses
        sport_poses = REFERENCE_POSES.get(sport, {})
        self.blueprint = sport_poses.get(pose_id, {})
        self.ref_angles = {k: v for k, v in self.blueprint.items() if k != 'cues'}
        self.cues = self.blueprint.get('cues', {})

    def analyze(self, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        """
        Generic Blueprint Matcher: Returns structured issues based on joint deviations.
        """
        issues = []
        total_error = 0
        joints_checked = 0

        for joint, actual_angle in actual_angles.items():
            if joint not in self.ref_angles:
                continue
                
            ref_angle = self.ref_angles[joint]
            error = abs(actual_angle - ref_angle)
            total_error += error
            joints_checked += 1

            severity = "none"
            if error > 30:
                severity = "high"
            elif error > 15:
                severity = "medium"
            
            if severity != "none":
                # Find specific cue or generate generic one
                error_dir = "high" if actual_angle > ref_angle else "low"
                # Use standard joint keys for mapping or specific direction
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

        # Score calculation: 0 error = 100 score. 90 deg avg error = 0 score.
        avg_error = total_error / joints_checked if joints_checked > 0 else 0
        score = max(0, min(100, 100 - (avg_error * (100 / 90))))

        return {
            "score": round(score, 1),
            "issues": issues,
            "overall_severity": "good" if score >= 80 else ("warning" if score >= 50 else "error")
        }

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
