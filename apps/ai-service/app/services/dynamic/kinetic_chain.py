"""
Kinetic Chain Validator

Validates that body segments activate in the correct biomechanical order
during dynamic movements. For example, in a cricket cover drive or tennis serve,
the hips should fire before the shoulders, which should fire before the arms.

This module is completely independent of the static pose analysis system.
"""

from typing import Dict, List, Any, Optional, Tuple


# Map segment names to the joints that represent them
SEGMENT_JOINTS = {
    "hips": ["left_hip", "right_hip"],
    "shoulders": ["left_shoulder", "right_shoulder"],
    "arms": ["left_elbow", "right_elbow"],
}


class KineticChainValidator:
    """
    Validates kinetic chain sequencing across a movement.
    
    Tracks peak angular velocity timestamps for each body segment
    and compares the ordering against the reference kinetic chain.
    """

    def __init__(self, expected_chain: List[str]):
        """
        Args:
            expected_chain: Ordered list of segment names, e.g. ["hips", "shoulders", "arms"]
        """
        self.expected_chain = expected_chain
        # Track peak velocity frame index for each segment
        self.peak_velocities: Dict[str, float] = {}
        self.peak_velocity_frames: Dict[str, int] = {}
        self.frame_count = 0

    def process_frame(self, velocities: Dict[str, float], frame_index: int):
        """
        Update peak velocities for each segment based on current frame velocities.
        """
        self.frame_count = frame_index

        for segment, joints in SEGMENT_JOINTS.items():
            if segment not in self.expected_chain:
                continue

            # Get the maximum absolute velocity across joints in this segment
            max_vel = 0.0
            for joint in joints:
                vel = abs(velocities.get(joint, 0.0))
                if vel > max_vel:
                    max_vel = vel

            # Update peak if this is the highest we've seen
            current_peak = self.peak_velocities.get(segment, 0.0)
            if max_vel > current_peak:
                self.peak_velocities[segment] = max_vel
                self.peak_velocity_frames[segment] = frame_index

    def evaluate(self) -> Dict[str, Any]:
        """
        Evaluate the kinetic chain ordering.
        
        Returns:
            chain_score: 0-100 score for how well the chain was sequenced
            chain_order_actual: the actual order segments peaked
            chain_order_expected: the expected order
            issues: list of feedback items if order was wrong
        """
        if len(self.peak_velocity_frames) < 2:
            return {
                "chain_score": 50.0,
                "chain_order_actual": [],
                "chain_order_expected": self.expected_chain,
                "issues": [{
                    "joint": "kinetic_chain",
                    "problem": "Insufficient data to evaluate kinetic chain",
                    "correction": "Perform the movement with more energy so the system can track body segment sequencing.",
                    "severity": "low"
                }]
            }

        # Sort segments by their peak velocity frame (earlier = fired first)
        actual_order = sorted(
            [s for s in self.expected_chain if s in self.peak_velocity_frames],
            key=lambda s: self.peak_velocity_frames[s]
        )

        # Score: count pairwise ordering matches
        correct_pairs = 0
        total_pairs = 0
        issues = []

        for i in range(len(self.expected_chain) - 1):
            seg_a = self.expected_chain[i]
            seg_b = self.expected_chain[i + 1]
            
            if seg_a not in self.peak_velocity_frames or seg_b not in self.peak_velocity_frames:
                continue

            total_pairs += 1
            frame_a = self.peak_velocity_frames[seg_a]
            frame_b = self.peak_velocity_frames[seg_b]

            if frame_a <= frame_b:
                correct_pairs += 1
            else:
                # Wrong order
                issues.append({
                    "joint": "kinetic_chain",
                    "problem": f"{seg_b.capitalize()} fired before {seg_a}",
                    "correction": f"Initiate the movement from your {seg_a} first, then let the energy transfer to your {seg_b}.",
                    "severity": "medium"
                })

        if total_pairs == 0:
            chain_score = 50.0
        else:
            chain_score = (correct_pairs / total_pairs) * 100.0

        return {
            "chain_score": round(chain_score, 1),
            "chain_order_actual": actual_order,
            "chain_order_expected": self.expected_chain,
            "issues": issues
        }

    def reset(self):
        """Reset for a new movement sequence."""
        self.peak_velocities.clear()
        self.peak_velocity_frames.clear()
        self.frame_count = 0
