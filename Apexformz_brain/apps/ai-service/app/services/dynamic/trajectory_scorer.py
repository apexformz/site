"""
Trajectory Scorer — Dynamic Time Warping for Movement Similarity

Compares the user's full angular trajectory across a rep against an
expert reference trajectory. DTW handles speed variations naturally:
a slow beginner kick and a fast expert kick are aligned optimally
before computing distance.

Uses dtaidistance for efficient DTW computation. Falls back gracefully
if the library is not installed or no reference trajectory exists.

This module is completely independent of the static pose analysis system.
"""

from typing import Dict, List, Any, Optional

# Graceful import — DTW is optional
try:
    from dtaidistance import dtw  # type: ignore
    DTW_AVAILABLE = True
except ImportError:
    DTW_AVAILABLE = False


# Joints to include in trajectory comparison (the most biomechanically
# meaningful joints for full-body dynamic movements)
TRAJECTORY_JOINTS = [
    "left_hip", "right_hip",
    "left_knee", "right_knee",
    "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow",
]



class TrajectoryScorer:
    """
    Records angular snapshots frame-by-frame and, on rep completion,
    compares the recorded trajectory to an expert reference using DTW.

    The result is a 0–100 'trajectory_similarity' score where 100 means
    the user's movement path through joint-angle space was identical
    to the expert's, regardless of speed.
    """

    def __init__(self, reference_trajectory: Optional[List[Dict[str, float]]] = None):
        """
        Args:
            reference_trajectory: Optional list of angle-dicts from an expert
                                  performance, e.g. [{"left_knee": 170, ...}, ...].
                                  If None, scoring is disabled gracefully.
        """
        self.reference = reference_trajectory
        self._current_rep: List[Dict[str, float]] = []
        self._last_score: Optional[float] = None

    @property
    def available(self) -> bool:
        """True if DTW library is installed AND a reference trajectory exists."""
        return DTW_AVAILABLE and self.reference is not None and len(self.reference) > 2

    def record_frame(self, angles: Dict[str, float]):
        """
        Append the current frame's angles to the in-progress rep recording.
        Only records joints that are visible (angle >= 0).
        """
        snapshot = {}
        for joint in TRAJECTORY_JOINTS:
            val = angles.get(joint, -1)
            if val >= 0:
                snapshot[joint] = val
        self._current_rep.append(snapshot)

    def score_rep(self) -> Optional[float]:
        """
        Score the completed rep against the reference trajectory using DTW.

        Returns:
            A 0–100 similarity score, or None if scoring is unavailable.
            Resets the current rep buffer after scoring.
        """
        if not self.available:
            self._reset_rep()
            return None

        if len(self._current_rep) < 3:
            self._reset_rep()
            return None

        # Build per-joint time series for user and reference
        total_distance = 0.0
        joints_compared = 0

        for joint in TRAJECTORY_JOINTS:
            user_series = [
                frame.get(joint, -1) for frame in self._current_rep
            ]
            ref_series = [
                frame.get(joint, -1) for frame in self.reference
            ]

            # Filter out frames where the joint was invisible
            user_clean = [v for v in user_series if v >= 0]
            ref_clean = [v for v in ref_series if v >= 0]

            if len(user_clean) < 3 or len(ref_clean) < 3:
                continue

            # Compute DTW distance for this joint's angle trajectory
            try:
                dist = dtw.distance_fast(user_clean, ref_clean)
            except Exception:
                try:
                    dist = dtw.distance(user_clean, ref_clean)
                except Exception:
                    continue

            # Normalize by the length of the longer sequence
            max_len = max(len(user_clean), len(ref_clean))
            normalized = dist / max_len if max_len > 0 else 0.0

            total_distance += normalized
            joints_compared += 1

        if joints_compared == 0:
            self._reset_rep()
            return None

        avg_distance = total_distance / joints_compared

        # Map distance to 0-100 score (lower distance = higher score)
        # 0 avg distance per joint = 100, >=30 avg distance per joint = 0
        score = max(0.0, min(100.0, 100.0 * (1.0 - avg_distance / 30.0)))

        self._last_score = round(score, 1)
        self._reset_rep()
        return self._last_score

    @property
    def last_score(self) -> Optional[float]:
        """The most recent trajectory similarity score."""
        return self._last_score

    def _reset_rep(self):
        """Clear the current rep recording buffer."""
        self._current_rep = []

    def reset(self):
        """Full reset for a new session."""
        self._current_rep = []
        self._last_score = None
