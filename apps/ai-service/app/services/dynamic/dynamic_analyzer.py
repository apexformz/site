"""
Dynamic Analyzer — Main Orchestrator for Dynamic Movement Analysis

Receives frames, feeds them to the PhaseDetector, evaluates phase-specific
blueprints with 5% leniency, computes kinetic chain scores, movement fluidity,
and rep counting.

This module is completely independent of the static pose analysis system.
"""

import math
import collections
from typing import Dict, List, Any, Optional

from .phase_detector import PhaseDetector, compute_all_angles
from .kinetic_chain import KineticChainValidator

# 5% leniency constant (matching the static system)
LENIENCY_PERCENT = 0.05
MIN_LENIENCY_DEGREES = 5.0

# Smoothing window for fluidity calculation
FLUIDITY_WINDOW = 10


class DynamicAnalyzer:
    """
    Orchestrates dynamic movement analysis for a single session.
    
    Maintains state across frames including phase detection, kinetic chain
    tracking, fluidity scoring, and rep counting.
    """

    def __init__(self, movement_config: Dict[str, Any], fps_estimate: float = 15.0):
        """
        Args:
            movement_config: The movement definition from reference_movements.json
            fps_estimate: Estimated camera frame rate
        """
        self.config = movement_config
        self.phases = movement_config.get("phases", [])
        self.is_cyclical = movement_config.get("is_cyclical", False)
        self.cues = movement_config.get("cues", {})
        
        # Initialize sub-modules
        self.phase_detector = PhaseDetector(self.phases, fps_estimate)
        
        chain_order = movement_config.get("kinetic_chain_order", [])
        self.chain_validator = KineticChainValidator(chain_order)
        
        # Phase scores (accumulated as phases are completed)
        self.phase_scores: Dict[str, float] = {}
        self.phase_issues: Dict[str, List[Dict]] = {}
        
        # Fluidity tracking (jerk = rate of change of acceleration)
        self.velocity_history: collections.deque = collections.deque(maxlen=FLUIDITY_WINDOW)
        self.fluidity_scores: List[float] = []
        
        # Temporal smoothing for output score
        self.score_history: collections.deque = collections.deque(maxlen=5)

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

        for joint, ref_angle in ref_angles.items():
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

    def analyze_frame(self, keypoints: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        Main entry point: process a single frame through the dynamic pipeline.
        
        Returns a result compatible with the existing FrameAnalysis interface
        plus additional dynamic-specific fields.
        """
        # 1. Phase detection
        phase_result = self.phase_detector.process_frame(keypoints)
        
        # 2. Update kinetic chain validator
        if phase_result["angular_velocities"]:
            self.chain_validator.process_frame(
                phase_result["angular_velocities"],
                phase_result["total_frames"]
            )
        
        # 3. If a phase transition happened, score the captured keyframe
        issues = []
        current_frame_score = None
        
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
            # Between transitions: score current frame against current phase blueprint
            current_phase = self.phase_detector.current_phase
            score_result = self._score_phase_keyframe(current_phase, phase_result["angles"])
            current_frame_score = score_result["score"]
            
            # Propagate issues to UI for red lines and feedback
            issues.extend(score_result["issues"])

        # 4. Compute fluidity
        fluidity = self._compute_fluidity(phase_result["angular_velocities"])
        
        # 5. Compute weighted overall score
        overall_score = self._compute_overall_score(current_frame_score)
        
        # 6. Temporal smoothing
        self.score_history.append(overall_score)
        smoothed_score = sum(self.score_history) / len(self.score_history)
        
        # 7. Determine severity
        if smoothed_score >= 76:
            severity = "good"
        elif smoothed_score >= 45:
            severity = "warning"
        else:
            severity = "error"

        # 8. Get kinetic chain evaluation (only meaningful after multiple phases)
        chain_result = self.chain_validator.evaluate()
        
        # Add chain issues if they exist
        for chain_issue in chain_result.get("issues", []):
            issues.append(chain_issue)

        # Build visible angles for the response
        visible_angles = {k: v for k, v in phase_result["angles"].items() if v >= 0}

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
        self.phase_scores.clear()
        self.phase_issues.clear()
        self.velocity_history.clear()
        self.fluidity_scores.clear()
        self.score_history.clear()
