"""
Phase Detector — Finite State Machine for Dynamic Movement Analysis

Tracks which phase the user is currently in by monitoring joint angular
velocities and angle thresholds. Maintains a rolling frame buffer for
temporal analysis.

This module is completely independent of the static pose analysis system.
"""

import math
import collections
from typing import Dict, List, Any, Optional, Tuple

from .pyomeca_adapter import PyomecaStreamAdapter


# Rolling buffer size for velocity computation
VELOCITY_BUFFER_SIZE = 5
# Minimum seconds between phase transitions to prevent rapid flickering.
MIN_SECONDS_BETWEEN_TRANSITIONS = 0.20


def _compute_angle(p1: Dict, p2: Dict, p3: Dict) -> float:
    """Angle at p2 (vertex). Returns -1 if any point has low confidence."""
    if not p1 or not p2 or not p3:
        return -1.0
    if p1.get('score', 0) < 0.3 or p2.get('score', 0) < 0.3 or p3.get('score', 0) < 0.3:
        return -1.0
    radians = math.atan2(p3['y'] - p2['y'], p3['x'] - p2['x']) - \
              math.atan2(p1['y'] - p2['y'], p1['x'] - p2['x'])
    angle = abs(radians * 180.0 / math.pi)
    if angle > 180.0:
        angle = 360 - angle
    return angle


def _get_kp(keypoints: List[Dict], name: str) -> Dict:
    """Get a keypoint by name from the keypoints list."""
    for kp in keypoints:
        if kp.get('name') == name:
            return kp
    return {"x": 0, "y": 0, "score": 0, "name": name}


# Joint triplets for angle computation (same as static system)
JOINT_TRIPLETS = {
    "left_elbow": ("left_shoulder", "left_elbow", "left_wrist"),
    "right_elbow": ("right_shoulder", "right_elbow", "right_wrist"),
    "left_shoulder": ("left_hip", "left_shoulder", "left_elbow"),
    "right_shoulder": ("right_hip", "right_shoulder", "right_elbow"),
    "left_hip": ("left_shoulder", "left_hip", "left_knee"),
    "right_hip": ("right_shoulder", "right_hip", "right_knee"),
    "left_knee": ("left_hip", "left_knee", "left_ankle"),
    "right_knee": ("right_hip", "right_knee", "right_ankle"),
}


def compute_all_angles(keypoints: List[Dict]) -> Dict[str, float]:
    """Compute all 8 joint angles from keypoints. Returns -1 for invisible joints."""
    angles = {}
    for joint, (p1_name, p2_name, p3_name) in JOINT_TRIPLETS.items():
        p1 = _get_kp(keypoints, p1_name)
        p2 = _get_kp(keypoints, p2_name)
        p3 = _get_kp(keypoints, p3_name)
        angles[joint] = _compute_angle(p1, p2, p3)
    return angles


class PhaseDetector:
    """
    Finite State Machine that tracks movement phases.
    
    Monitors joint angles across frames, computes angular velocities,
    and fires phase transitions based on the triggers defined in
    reference_movements.json.
    """

    def __init__(self, phases: List[Dict[str, Any]], fps_estimate: float = 15.0):
        self.phases = phases
        self.fps_estimate = max(fps_estimate, 1.0)
        self.dt = 1.0 / self.fps_estimate  # seconds per frame

        # State
        self.current_phase_index = 0
        self.frames_in_current_phase = 0
        self.frames_since_last_transition = 0
        self.total_frames = 0
        self.rep_count = 0
        self.last_rep_frame = 0
        self.trigger_hold_frames = 0
        self.trigger_hold_target = -1

        # Rolling angle history for velocity computation
        self.angle_history: collections.deque = collections.deque(maxlen=VELOCITY_BUFFER_SIZE)
        
        # Pyomeca Adapter for scientific biomechanics and filtering
        self.pyomeca_adapter = PyomecaStreamAdapter(fps_estimate=fps_estimate, window_size=15)
        
        # Store the keyframe captured at each phase transition
        self.phase_keyframes: Dict[int, Dict[str, Any]] = {}
        
        # Phase transition timestamps (frame indices)
        self.phase_timestamps: Dict[int, int] = {0: 0}

    @property
    def current_phase(self) -> Dict[str, Any]:
        return self.phases[self.current_phase_index]

    @property
    def current_phase_name(self) -> str:
        return self.current_phase.get("name", f"phase_{self.current_phase_index}")

    def set_fps_estimate(self, fps_estimate: float):
        """Use measured stream timing while retaining the configured fallback."""
        self.fps_estimate = max(float(fps_estimate), 1.0)
        self.dt = 1.0 / self.fps_estimate
        self.pyomeca_adapter.fps = self.fps_estimate

    @property
    def min_frames_between_transitions(self) -> int:
        return max(2, round(self.fps_estimate * MIN_SECONDS_BETWEEN_TRANSITIONS))

    def compute_angular_velocities(self) -> Dict[str, float]:
        """
        Fallback velocity computation if Pyomeca does not return velocities.
        """
        if len(self.angle_history) < 2:
            return {}
        
        velocities = {}
        latest = self.angle_history[-1]
        previous = self.angle_history[-2]
        
        for joint in latest:
            curr = latest[joint]
            prev = previous[joint]
            if curr >= 0 and prev >= 0:
                # Velocity in degrees per time unit
                velocities[joint] = (curr - prev) / self.dt
            else:
                velocities[joint] = 0.0
        
        return velocities

    def _check_trigger(self, trigger: Any, angles: Dict[str, float], velocities: Dict[str, float]) -> bool:
        """
        Check if a phase trigger condition is met.
        
        Trigger types:
          - "initial": always true (first phase)
          - dict with "metric": "angular_velocity" — check velocity threshold
          - dict with "metric": "angle_above" — check if angle exceeds threshold
          - dict with "metric": "angle_below" — check if angle is below threshold
        """
        if trigger == "initial":
            return True

        if not isinstance(trigger, dict):
            return False

        joint = trigger.get("joint", "")
        metric = trigger.get("metric", "")
        threshold = trigger.get("threshold", 0)

        if metric == "angular_velocity":
            velocity = velocities.get(joint, 0.0)
            direction = trigger.get("direction", "positive")
            if direction == "positive":
                return velocity > threshold
            else:
                return velocity < threshold

        elif metric == "angle_above":
            angle = angles.get(joint, -1)
            return angle >= 0 and angle > threshold

        elif metric == "angle_below":
            angle = angles.get(joint, -1)
            return angle >= 0 and angle < threshold

        return False

    def process_frame(self, keypoints: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Process a single frame. Returns phase state info including:
        - current_phase: name of active phase
        - phase_index: numeric index
        - phase_changed: whether a transition just occurred
        - captured_keyframe: the keyframe if a transition happened
        - angular_velocities: current velocities
        - rep_count: number of completed cycles
        """
        self.total_frames += 1
        self.frames_in_current_phase += 1
        self.frames_since_last_transition += 1

        # 1. Use Pyomeca adapter for angles and velocities
        angles, velocities = self.pyomeca_adapter.process_frame(keypoints)
        
        # 2. Append to history and fallback on velocity if pyomeca returned empty
        self.angle_history.append(angles)
        if not velocities:
            velocities = self.compute_angular_velocities()

        # Check if we should transition to the next phase
        phase_changed = False
        captured_keyframe = None

        if self.frames_since_last_transition >= self.min_frames_between_transitions:
            # Look ahead logic:
            # - Phase 0 (Stance) MUST go to Phase 1 (no skipping the start of movement)
            # - Other phases can skip 1 phase (lookahead=2) if the user is sloppy or frames drop
            # - Never allow a lookahead to wrap around to 0 (unless we are on the very last phase)
            if self.current_phase_index == 0:
                max_lookahead = 1
            else:
                max_lookahead = max(1, min(2, len(self.phases) - 1 - self.current_phase_index))
                
            # If we are at the last phase, we must be able to wrap to 0
            if self.current_phase_index == len(self.phases) - 1:
                max_lookahead = 1
            
            for lookahead in range(1, max_lookahead + 1):
                next_phase_index = (self.current_phase_index + lookahead) % len(self.phases)
                next_phase = self.phases[next_phase_index]
                trigger = next_phase.get("trigger", "initial")

                if self._check_trigger(trigger, angles, velocities):
                    if trigger == "initial":
                        # Instant transition for phase 0
                        self.trigger_hold_frames = 2
                    elif self.trigger_hold_target == next_phase_index:
                        self.trigger_hold_frames += 1
                    else:
                        self.trigger_hold_target = next_phase_index
                        self.trigger_hold_frames = 1
                        
                    hold_target = max(2, round(self.fps_estimate * 0.12))
                    if self.trigger_hold_frames >= hold_target:
                        # Phase transition!
                        phase_changed = True
                        
                        # If we wrapped around, that's a completed rep
                        if next_phase_index < self.current_phase_index and self.total_frames > len(self.phases):
                            frames_since_last = self.total_frames - self.last_rep_frame
                            # Require at least half a second, independent of FPS.
                            if frames_since_last >= max(10, round(self.fps_estimate * 0.5)):
                                self.rep_count += 1
                                self.last_rep_frame = self.total_frames

                        self.current_phase_index = next_phase_index
                        self.frames_in_current_phase = 0
                        self.frames_since_last_transition = 0
                        self.trigger_hold_frames = 0
                        self.trigger_hold_target = -1
                        
                        # Capture the keyframe at this transition
                        captured_keyframe = {
                            "angles": angles,
                            "keypoints": keypoints,
                            "frame_index": self.total_frames,
                            "velocities": velocities,
                        }
                        self.phase_keyframes[next_phase_index] = captured_keyframe
                        self.phase_timestamps[next_phase_index] = self.total_frames
                        break  # Stop checking further phases once we transition
                else:
                    if self.trigger_hold_target == next_phase_index:
                        self.trigger_hold_frames = 0
                        self.trigger_hold_target = -1

        return {
            "current_phase": self.current_phase_name,
            "phase_index": self.current_phase_index,
            "phase_changed": phase_changed,
            "captured_keyframe": captured_keyframe,
            "angles": angles,
            "angular_velocities": velocities,
            "frames_in_phase": self.frames_in_current_phase,
            "rep_count": self.rep_count,
            "total_frames": self.total_frames,
        }

    def reset(self):
        """Reset the detector for a new movement sequence."""
        self.current_phase_index = 0
        self.frames_in_current_phase = 0
        self.frames_since_last_transition = 0
        self.total_frames = 0
        self.rep_count = 0
        self.last_rep_frame = 0
        self.trigger_hold_frames = 0
        self.trigger_hold_target = -1
        self.angle_history.clear()
        self.phase_keyframes.clear()
        self.phase_timestamps = {0: 0}
        self.pyomeca_adapter.reset()
