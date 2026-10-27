"""
Dynamic Analyzer — Main Orchestrator for Dynamic Movement Analysis

Receives frames, feeds them to the PhaseDetector, validates poses against
expert reference frames (extracted from training videos) using FrameMatcher,
computes kinetic chain scores, movement fluidity, and rep counting.

Scoring hierarchy:
  1. FrameMatcher (nearest-neighbor against real expert video frames) — PRIMARY
  2. Blueprint angles from reference_movements.json — FALLBACK

This module is completely independent of the static pose analysis system.
"""

import math
import collections
from typing import Dict, List, Any, Optional

from .phase_detector import PhaseDetector, compute_all_angles, _get_kp
from .kinetic_chain import KineticChainValidator
from .signal_filter import KeypointSmoother
from .trajectory_scorer import TrajectoryScorer
from .frame_matcher import FrameMatcher

# 15% leniency constant for dynamic sequences to allow human imperfection
LENIENCY_PERCENT = 0.15
MIN_LENIENCY_DEGREES = 10.0

# Smoothing window for fluidity calculation
FLUIDITY_WINDOW = 10


class DynamicAnalyzer:
    """
    Orchestrates dynamic movement analysis for a single session.
    
    Maintains state across frames including phase detection, kinetic chain
    tracking, fluidity scoring, and rep counting.
    """

    def __init__(self, movement_config: Dict[str, Any], fps_estimate: float = 15.0,
                 movement_key: Optional[str] = None):
        """
        Args:
            movement_config: The movement definition from reference_movements.json
            fps_estimate: Estimated camera frame rate
            movement_key: The movement identifier (e.g. "ap_chagi_front_kick")
                          used to look up expert reference frames.
        """
        self.config = movement_config
        self.movement_key = movement_key
        self.phases = movement_config.get("phases", [])
        self.is_cyclical = movement_config.get("is_cyclical", False)
        self.cues = movement_config.get("cues", {})
        
        # Initialize sub-modules
        self.phase_detector = PhaseDetector(self.phases, fps_estimate)
        
        chain_order = movement_config.get("kinetic_chain_order", [])
        self.chain_validator = KineticChainValidator(chain_order)
        
        # OneEuro keypoint smoother — removes jitter before angle computation
        self.smoother = KeypointSmoother(fps_estimate=fps_estimate)
        
        # DTW trajectory scorer — compares full rep against expert reference
        ref_traj = movement_config.get("reference_trajectory", None)
        self.trajectory_scorer = TrajectoryScorer(reference_trajectory=ref_traj)
        
        # FrameMatcher — nearest-neighbor against real expert video frames
        self.frame_matcher = FrameMatcher.get_instance()
        self._use_frame_matcher = (
            self.frame_matcher.available
            and movement_key is not None
            and self.frame_matcher.has_movement(movement_key)
        )
        if self._use_frame_matcher:
            print(f"[DynamicAnalyzer] Using FrameMatcher for '{movement_key}'")
        else:
            print(f"[DynamicAnalyzer] Falling back to blueprint scoring for '{movement_key}'")
        
        # Phase scores (accumulated as phases are completed)
        self.phase_scores: Dict[str, float] = {}
        self.phase_issues: Dict[str, List[Dict]] = {}
        
        # Fluidity tracking (jerk = rate of change of acceleration)
        self.velocity_history: collections.deque = collections.deque(maxlen=FLUIDITY_WINDOW)
        self.fluidity_scores: List[float] = []
        
        # Temporal smoothing for output score
        self.score_history: collections.deque = collections.deque(maxlen=5)
        
        # AQA Grade
        self.latest_aqa_grade: Optional[float] = None
        self.last_timestamp_ms: Optional[int] = None
        self.observed_fps: float = fps_estimate
        self.matcher_history: collections.deque = collections.deque(maxlen=4)
        self.frames_received = 0
        self.issue_streaks: Dict[str, int] = {}
        self.rep_scores: List[float] = []
        self.last_rep_score: Optional[float] = None
        self.last_confidence: float = 0.0
        self.joint_weights = movement_config.get("joint_weights") or None

    def _update_timing(self, timestamp_ms: Optional[int]):
        if timestamp_ms is not None and self.last_timestamp_ms is not None:
            delta_ms = timestamp_ms - self.last_timestamp_ms
            if 10 <= delta_ms <= 1000:
                instant_fps = 1000.0 / delta_ms
                self.observed_fps = max(1.0, min(60.0, self.observed_fps * 0.8 + instant_fps * 0.2))
                self.phase_detector.set_fps_estimate(self.observed_fps)
                self.smoother.set_fps_estimate(self.observed_fps)
        if timestamp_ms is not None:
            self.last_timestamp_ms = timestamp_ms

    def _readiness_issue(self, keypoints: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        required = ("left_shoulder", "right_shoulder", "left_hip", "right_hip",
                    "left_knee", "right_knee", "left_ankle", "right_ankle")
        by_name = {kp.get("name"): kp for kp in keypoints}
        missing = [name for name in required if by_name.get(name, {}).get("score", 0) < 0.35]
        if missing:
            return {
                "joint": "visibility",
                "problem": "Full-body tracking is not reliable yet",
                "correction": "Step back until both hips, knees, and ankles are fully visible.",
                "severity": "high",
                "missing_joints": missing,
            }
        return None

    def _tracking_confidence(self, keypoints: List[Dict[str, Any]]) -> float:
        """Estimate evidence quality separately from movement correctness."""
        required = ("left_shoulder", "right_shoulder", "left_hip", "right_hip",
                    "left_knee", "right_knee", "left_ankle", "right_ankle")
        by_name = {kp.get("name"): kp for kp in keypoints}
        scores = [float(by_name.get(name, {}).get("score", 0.0)) for name in required]
        return max(0.0, min(1.0, sum(scores) / len(scores)))

    def _stabilize_issues(self, issues: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Require non-visibility corrections to persist for two frames."""
        current = set()
        stable = []
        for issue in issues:
            if issue.get("joint") == "visibility" or issue.get("severity") == "high":
                stable.append(issue)
                continue
            key = f"{issue.get('phase', '')}|{issue.get('joint', '')}|{issue.get('problem', '')}"
            current.add(key)
            self.issue_streaks[key] = self.issue_streaks.get(key, 0) + 1
            if self.issue_streaks[key] >= 2:
                stable.append(issue)
        for key in list(self.issue_streaks):
            if key not in current:
                del self.issue_streaks[key]
        return stable

    def _compute_rep_score(self, trajectory_similarity: Optional[float], fluidity: float,
                           chain_score: float) -> float:
        """Combine rep-level movement quality without adding inference latency."""
        phase_values = list(self.phase_scores.values())
        phase_score = sum(phase_values) / len(phase_values) if phase_values else 0.0
        trajectory_score = float(trajectory_similarity) if trajectory_similarity is not None else phase_score
        return round(max(0.0, min(100.0, phase_score * 0.45 + trajectory_score * 0.35 +
                                 fluidity * 0.10 + chain_score * 0.10)), 1)

    def _normalize_keypoints(self, keypoints: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Remove camera translation and subject distance from live coordinates.

        Angle features are already scale-invariant, but normalized coordinates
        make smoothing, velocity and future trajectory features less sensitive
        to a user stepping closer to the camera.
        """
        by_name = {kp.get("name"): kp for kp in keypoints}
        torso = [by_name.get(name) for name in ("left_shoulder", "right_shoulder", "left_hip", "right_hip")]
        if any(not kp or kp.get("score", 0) < 0.35 for kp in torso):
            return keypoints
        center_x = sum(kp["x"] for kp in torso) / 4.0
        center_y = sum(kp["y"] for kp in torso) / 4.0
        shoulder_width = math.hypot(
            by_name["left_shoulder"]["x"] - by_name["right_shoulder"]["x"],
            by_name["left_shoulder"]["y"] - by_name["right_shoulder"]["y"],
        )
        hip_width = math.hypot(
            by_name["left_hip"]["x"] - by_name["right_hip"]["x"],
            by_name["left_hip"]["y"] - by_name["right_hip"]["y"],
        )
        scale = max((shoulder_width + hip_width) / 2.0, 1.0)
        normalized = []
        for kp in keypoints:
            item = dict(kp)
            item["x"] = (kp["x"] - center_x) / scale
            item["y"] = (kp["y"] - center_y) / scale
            if isinstance(kp.get("z"), (int, float)):
                item["z"] = kp["z"] / scale
            normalized.append(item)
        return normalized

    def _score_phase_keyframe(
        self, phase: Dict[str, Any], angles: Dict[str, float]
    ) -> Dict[str, Any]:
        """
        Score a captured keyframe against its phase blueprint.
        Uses the same 5% leniency as the static system.
        """
        ref_angles = phase.get("angles", {})
        if not ref_angles:
            return {"score": 100.0, "issues": []}

        total_error = 0.0
        joints_checked = 0
        issues = []
        phase_name = phase.get("name", "unknown")

        ignored_joints = self.config.get("ignored_joints", [])

        for joint, ref_angle in ref_angles.items():
            if joint in ignored_joints:
                continue

            actual = angles.get(joint, -1)
            if actual < 0:
                continue  # Joint not visible

            raw_error = abs(actual - ref_angle)
            
            # Apply 5% leniency (same as static system)
            angle_leniency = max(ref_angle * LENIENCY_PERCENT, MIN_LENIENCY_DEGREES)
            effective_error = max(0.0, raw_error - angle_leniency)
            
            total_error += effective_error
            joints_checked += 1

            severity = "none"
            if effective_error > 30:
                severity = "high"
            elif effective_error > 15:
                severity = "medium"

            if severity != "none":
                # Look for phase-specific cue
                error_dir = "high" if actual > ref_angle else "low"
                cue_key = f"{phase_name}_{joint}_{error_dir}"
                cue = self.cues.get(cue_key) or self.cues.get(f"{phase_name}_{joint}")

                if not cue:
                    cue = f"Adjust your {joint.replace('_', ' ')} during {phase_name.replace('_', ' ')}. Target: {ref_angle}°, Actual: {int(actual)}°."

                issues.append({
                    "joint": joint,
                    "problem": f"{joint.replace('_', ' ')} misaligned during {phase_name.replace('_', ' ')}",
                    "correction": cue,
                    "severity": severity,
                    "phase": phase_name
                })

        if joints_checked == 0:
            return {"score": 0.0, "issues": issues}

        avg_error = total_error / joints_checked
        accuracy_score = max(0, min(100, 100 - (avg_error * (100 / 90))))
        
        # Apply 5% leniency boost
        leniency_score = min(100.0, accuracy_score * 1.05)

        return {"score": round(leniency_score, 1), "issues": issues}

    def _check_vertical_orientation(self, keypoints: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """
        Check if the user is lying down horizontally.
        Returns an issue dict if horizontal, else None.
        """
        ls = _get_kp(keypoints, "left_shoulder")
        rs = _get_kp(keypoints, "right_shoulder")
        lh = _get_kp(keypoints, "left_hip")
        rh = _get_kp(keypoints, "right_hip")
        
        if ls.get('score', 0) < 0.3 or rs.get('score', 0) < 0.3 or lh.get('score', 0) < 0.3 or rh.get('score', 0) < 0.3:
            return None # Not enough confidence
            
        mid_shoulder_y = (ls['y'] + rs['y']) / 2.0
        mid_shoulder_x = (ls['x'] + rs['x']) / 2.0
        mid_hip_y = (lh['y'] + rh['y']) / 2.0
        mid_hip_x = (lh['x'] + rh['x']) / 2.0
        
        dy = abs(mid_hip_y - mid_shoulder_y)
        dx = abs(mid_hip_x - mid_shoulder_x)
        
        # If dx > dy, the torso is horizontal
        if dx > (dy * 1.2): # 1.2 factor allows for some leaning, but catches lying down
            return {
                "joint": "torso",
                "problem": "User appears to be lying down or horizontal",
                "correction": "Please stand up straight facing the camera for accurate analysis.",
                "severity": "high"
            }
        return None

    def _compute_fluidity(self, velocities: Dict[str, float]) -> float:
        """
        Compute movement fluidity as the inverse of jerk (rate of change of acceleration).
        Higher fluidity = smoother movement. Returns 0-100 scale.
        """
        self.velocity_history.append(velocities)
        
        if len(self.velocity_history) < 3:
            return 75.0  # Default before we have enough data

        # Compute acceleration (change in velocity between consecutive frames)
        v_curr = self.velocity_history[-1]
        v_prev = self.velocity_history[-2]
        v_prev2 = self.velocity_history[-3]

        total_jerk = 0.0
        joint_count = 0

        for joint in v_curr:
            if joint in v_prev and joint in v_prev2:
                accel_curr = v_curr[joint] - v_prev[joint]
                accel_prev = v_prev[joint] - v_prev2[joint]
                jerk = abs(accel_curr - accel_prev)
                total_jerk += jerk
                joint_count += 1

        if joint_count == 0:
            return 75.0

        avg_jerk = total_jerk / joint_count
        
        # Map jerk to 0-100 fluidity score
        # Low jerk (< 50 deg/frame³) = high fluidity (100)
        # High jerk (> 500 deg/frame³) = low fluidity (0)
        fluidity = max(0, min(100, 100 - (avg_jerk / 5.0)))
        
        return round(fluidity, 1)

    def analyze_frame(self, keypoints: List[Dict[str, Any]], timestamp_ms: Optional[int] = None) -> Dict[str, Any]:
        """
        Main entry point: process a single frame through the dynamic pipeline.
        
        Returns a result compatible with the existing FrameAnalysis interface
        plus additional dynamic-specific fields.
        """
        self.frames_received += 1
        self._update_timing(timestamp_ms)
        self.last_confidence = self._tracking_confidence(keypoints)
        readiness_issue = self._readiness_issue(keypoints)
        if readiness_issue:
            return {
                "score": 0.0, "joint_angles": {}, "issues": [readiness_issue],
                "overall_severity": "error", "pose_name": self.movement_key,
                "dynamic": True, "current_phase": self.phase_detector.current_phase_name,
                "phase_index": self.phase_detector.current_phase_index,
                "phase_changed": False, "phase_scores": dict(self.phase_scores),
                "rep_count": self.phase_detector.rep_count, "fluidity_score": 0.0,
                "kinetic_chain": {"score": 0, "order_expected": self.chain_validator.expected_chain, "order_actual": []},
                "total_phases": len(self.phases), "is_cyclical": self.is_cyclical,
                "trajectory_similarity": None, "rep_completed": False, "rep_trajectory": [],
                "aqa_grade": self.latest_aqa_grade,
                "diagnostics": {"observed_fps": round(self.observed_fps, 1), "frames_received": self.frames_received,
                                "readiness": "blocked", "matcher_enabled": self._use_frame_matcher},
            }

        # 0. Smooth keypoints (OneEuro filter removes webcam jitter)
        normalized_keypoints = self._normalize_keypoints(keypoints)
        smoothed_keypoints = self.smoother.smooth(normalized_keypoints)
        
        # 1. Phase detection (uses smoothed keypoints)
        phase_result = self.phase_detector.process_frame(smoothed_keypoints)
        
        # OVERRIDE STANCE TRANSITION:
        # If the PhaseDetector wants to transition from Stance (0) to Phase 1,
        # strictly gate it using the expert starting frames.
        if self._use_frame_matcher and phase_result["phase_changed"] and phase_result["phase_index"] == 1:
            start_score_result = self.frame_matcher.score_start_stance(
                self.movement_key, phase_result["angles"],
                joint_weights=self.joint_weights,
            )
            if start_score_result["score"] < 80.0:
                # Reject transition: force them to stay in Phase 0 until they match the expert stance
                self.phase_detector.current_phase_index = 0
                self.phase_detector.frames_in_current_phase = 0
                self.phase_detector.frames_since_last_transition = 0
                
                phase_result["phase_index"] = 0
                phase_result["current_phase"] = self.phases[0].get("name", "phase_0")
                phase_result["phase_changed"] = False
        
        # 2. Update kinetic chain validator
        if phase_result["angular_velocities"]:
            self.chain_validator.process_frame(
                phase_result["angular_velocities"],
                phase_result["total_frames"]
            )
        
        # 3. Score the current frame
        #    PRIMARY: FrameMatcher (real expert video frames)
        #    FALLBACK: Blueprint angles from reference_movements.json
        issues = []
        current_frame_score = None
        
        if self._use_frame_matcher:
            # FrameMatcher scoring (nearest-neighbor against expert videos)
            ignored_joints = self.config.get("ignored_joints", [])
            
            if phase_result["phase_index"] == 0:
                # Stance Phase: Lock on to the starting frames ONLY
                fm_result = self.frame_matcher.score_start_stance(
                    self.movement_key, phase_result["angles"], ignored_joints, self.joint_weights
                )
                
                # If they haven't matched the starting frame well enough, provide a hint
                if fm_result["score"] < 75.0:
                    fm_result["issues"].insert(0, {
                        "joint": "stance",
                        "problem": "Waiting for correct starting posture.",
                        "correction": "Get into the Ready Stance to begin.",
                        "severity": "medium",
                    })
            else:
                # Dynamic Phase: Match against the full pool of expert frames
                fm_result = self.frame_matcher.score_frame(
                    self.movement_key, phase_result["angles"], ignored_joints=ignored_joints,
                    joint_weights=self.joint_weights,
                )
            current_frame_score = fm_result["score"]
            self.matcher_history.append(current_frame_score)
            # Short temporal consensus avoids one bad detector frame dominating feedback.
            current_frame_score = sum(self.matcher_history) / len(self.matcher_history)
            
            # Inject phase context so the frontend can use it for the report
            current_phase_name = phase_result["current_phase"].replace("_", " ")
            for issue in fm_result["issues"]:
                if issue.get("joint") != "stance":
                    issue["phase"] = current_phase_name
                
            issues.extend(fm_result["issues"])
            # Still record phase scores for the UI phase progress display
            if phase_result["phase_changed"]:
                phase_name = self.phase_detector.current_phase.get("name", "unknown")
                self.phase_scores[phase_name] = fm_result["score"]
                self.phase_issues[phase_name] = fm_result["issues"]
        else:
            # ── Blueprint fallback scoring ──
            if phase_result["phase_changed"] and phase_result["captured_keyframe"]:
                keyframe = phase_result["captured_keyframe"]
                phase = self.phase_detector.current_phase
                
                score_result = self._score_phase_keyframe(phase, keyframe["angles"])
                phase_name = phase.get("name", "unknown")
                
                self.phase_scores[phase_name] = score_result["score"]
                self.phase_issues[phase_name] = score_result["issues"]
                issues.extend(score_result["issues"])
                current_frame_score = score_result["score"]
            else:
                current_phase = self.phase_detector.current_phase
                score_result = self._score_phase_keyframe(current_phase, phase_result["angles"])
                current_frame_score = score_result["score"]
                issues.extend(score_result["issues"])

        # Check for vertical orientation
        orientation_issue = self._check_vertical_orientation(smoothed_keypoints)
        if orientation_issue:
            current_frame_score = 0.0
            issues.append(orientation_issue)

        # 4. Record angles for DTW trajectory scoring
        self.trajectory_scorer.record_frame(phase_result["angles"])
        
        # 5. Check if a rep just completed — score the trajectory
        trajectory_similarity = self.trajectory_scorer.last_score
        prev_rep_count = getattr(self, '_prev_rep_count', 0)
        current_rep = phase_result["rep_count"]
        
        rep_completed = False
        rep_trajectory = []
        rep_score = self.last_rep_score
        if current_rep > prev_rep_count:
            rep_trajectory = list(self.trajectory_scorer._current_rep)
            trajectory_similarity = self.trajectory_scorer.score_rep()
            rep_completed = True
            
        self._prev_rep_count = current_rep
        
        # 6. Compute fluidity
        fluidity = self._compute_fluidity(phase_result["angular_velocities"])

        # Low-confidence evidence must not be presented as perfect form.
        # Apply this before the aggregate score is calculated.
        if self.last_confidence < 0.60:
            current_frame_score = min(current_frame_score, 70.0)
            issues.append({
                "joint": "confidence",
                "problem": "Tracking confidence is low",
                "correction": "Improve lighting and keep your full body inside the camera frame.",
                "severity": "medium",
            })
        
        # 7. Compute weighted overall score
        overall_score = self._compute_overall_score(current_frame_score)
        
        # 8. Temporal smoothing
        self.score_history.append(overall_score)
        smoothed_score = sum(self.score_history) / len(self.score_history)
        if self.last_confidence < 0.60:
            smoothed_score = min(smoothed_score, 70.0)
        
        # 9. Determine severity
        if smoothed_score >= 76:
            severity = "good"
        elif smoothed_score >= 45:
            severity = "warning"
        else:
            severity = "error"

        # 10. Get kinetic chain evaluation (only meaningful after multiple phases)
        chain_result = self.chain_validator.evaluate()

        if rep_completed:
            rep_score = self._compute_rep_score(trajectory_similarity, fluidity, chain_result["chain_score"])
            self.last_rep_score = rep_score
            self.rep_scores.append(rep_score)
        
        # Add chain issues if they exist
        for chain_issue in chain_result.get("issues", []):
            issues.append(chain_issue)

        # Build visible angles for the response
        visible_angles = {k: v for k, v in phase_result["angles"].items() if v >= 0}

        issues = self._stabilize_issues(issues)

        return {
            # Standard FrameAnalysis fields (compatible with existing frontend)
            "score": round(smoothed_score, 1),
            "joint_angles": visible_angles,
            "issues": issues,
            "overall_severity": severity,
            "pose_name": phase_result["current_phase"],
            
            # Dynamic-specific fields
            "dynamic": True,
            "current_phase": phase_result["current_phase"],
            "phase_index": phase_result["phase_index"],
            "phase_changed": phase_result["phase_changed"],
            "phase_scores": dict(self.phase_scores),
            "rep_count": phase_result["rep_count"],
            "fluidity_score": fluidity,
            "kinetic_chain": {
                "score": chain_result["chain_score"],
                "order_expected": chain_result["chain_order_expected"],
                "order_actual": chain_result["chain_order_actual"],
            },
            "total_phases": len(self.phases),
            "is_cyclical": self.is_cyclical,
            "trajectory_similarity": trajectory_similarity,
            "rep_completed": rep_completed,
            "rep_trajectory": rep_trajectory,
            "aqa_grade": self.latest_aqa_grade,
            "rep_score": rep_score,
            "rep_scores": list(self.rep_scores[-10:]),
            "diagnostics": {
                "observed_fps": round(self.observed_fps, 1),
                "frames_received": self.frames_received,
                "readiness": "ready",
                "matcher_enabled": self._use_frame_matcher,
                "reference_movement": self.movement_key,
                "tracking_confidence": round(self.last_confidence, 3),
                "latest_rep_score": rep_score,
            },
        }

    def _compute_overall_score(self, current_frame_score: float) -> float:
        """
        Compute overall movement score as a weighted average of phase scores.
        Falls back to current frame score if no phases have been evaluated yet.
        """
        if not self.phase_scores:
            return current_frame_score

        weighted_sum = 0.0
        total_weight = 0.0

        for i, phase in enumerate(self.phases):
            phase_name = phase.get("name", f"phase_{i}")
            weight = phase.get("weight", 1.0 / len(self.phases))
            
            if phase_name in self.phase_scores:
                weighted_sum += self.phase_scores[phase_name] * weight
                total_weight += weight

        if total_weight == 0:
            return current_frame_score

        # Blend weighted phase scores with current frame score
        phase_avg = weighted_sum / total_weight
        # 70% phase scores, 30% current real-time frame
        return phase_avg * 0.7 + current_frame_score * 0.3

    def reset(self):
        """Reset all state for a new movement sequence."""
        self.phase_detector.reset()
        self.chain_validator.reset()
        self.smoother.reset()
        self.trajectory_scorer.reset()
        self.phase_scores.clear()
        self.phase_issues.clear()
        self.velocity_history.clear()
        self.fluidity_scores.clear()
        self.score_history.clear()
        self._prev_rep_count = 0
        self.latest_aqa_grade = None
        self.last_timestamp_ms = None
        self.observed_fps = self.smoother.fps
        self.matcher_history.clear()
        self.frames_received = 0
        self.issue_streaks.clear()
        self.rep_scores.clear()
        self.last_rep_score = None
        self.last_confidence = 0.0
