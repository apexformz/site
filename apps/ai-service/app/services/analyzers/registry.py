from typing import Dict, List, Any, Type
import collections
from .base import BaseAnalyzer
from .plank import PlankAnalyzer
from .squat import SquatAnalyzer

# Global session buffer for temporal smoothing (moving average)
# In a production environment, this should move to Redis or a session-aware cache.
SESSION_BUFFERS = {}
WINDOW_SIZE = 5

class AnalyzerRegistry:
    # Map pose_ids to specialized analyzer classes
    _MAPPING: Dict[str, Type[BaseAnalyzer]] = {
        "plank_pose": PlankAnalyzer,
        "squats": SquatAnalyzer
    }

    @classmethod
    def get_analyzer(cls, sport: str, pose_id: str) -> BaseAnalyzer:
        """
        Returns the specialized analyzer if it exists, otherwise Default BaseAnalyzer.
        """
        analyzer_class = cls._MAPPING.get(pose_id, BaseAnalyzer)
        return analyzer_class(sport, pose_id)

    @classmethod
    def analyze_with_smoothing(cls, sport: str, pose_id: str, keypoints: List[Dict[str, Any]], actual_angles: Dict[str, float]) -> Dict[str, Any]:
        """
        Dispatches to the correct analyzer and applies temporal smoothing.
        """
        analyzer = cls.get_analyzer(sport, pose_id)
        raw_result = analyzer.analyze(keypoints, actual_angles)

        # 1. Initialize buffer for this session (pose_id + sport combination)
        session_key = f"{sport}_{pose_id}"
        if session_key not in SESSION_BUFFERS:
            SESSION_BUFFERS[session_key] = collections.deque(maxlen=WINDOW_SIZE)
        
        SESSION_BUFFERS[session_key].append(raw_result)
        
        # 2. Apply Temporal Smoothing (Moving Average on Score)
        history = list(SESSION_BUFFERS[session_key])
        avg_score = sum(h['score'] for h in history) / len(history)

        # 3. Consolidate Issues (Simple: return most frequent or most severe issues)
        # For simplicity, we return the issues from the LATEST frame if the average score is low,
        # but only if those issues have appeared in the recent history to avoid flickering.
        latest_issues = raw_result['issues']
        
        # Determine overall severity based on smoothed score
        overall_severity = "good"
        if avg_score < 50:
            overall_severity = "error"
        elif avg_score < 80:
            overall_severity = "warning"

        return {
            "score": round(avg_score, 1),
            "overall_severity": overall_severity,
            "issues": latest_issues, # In future, cross-frame issue filtering logic goes here
            "raw_frame_result": raw_result
        }
