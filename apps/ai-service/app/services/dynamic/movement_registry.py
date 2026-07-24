"""
Movement Registry — Routes to Dynamic or Static Analysis

Contains the is_dynamic() classification function and manages
DynamicAnalyzer instances per session. This is the single entry point
for the dynamic pipeline, parallel to the existing static registry.

This module is completely independent of the static pose analysis system.
"""

import os
import json
from typing import Dict, List, Any, Optional

from .dynamic_analyzer import DynamicAnalyzer

# Load reference movements
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
MOVEMENTS_FILE = os.path.join(DATA_DIR, '..', '..', 'data', 'reference_movements.json')

with open(MOVEMENTS_FILE, 'r') as f:
    REFERENCE_MOVEMENTS = json.load(f)

# Build a flat lookup of all dynamic movements: {sport: {pose_id: config}}
DYNAMIC_LOOKUP: Dict[str, Dict[str, Dict]] = {}
for sport, movements in REFERENCE_MOVEMENTS.items():
    DYNAMIC_LOOKUP[sport] = {}
    for movement_name, config in movements.items():
        if config.get("type") == "dynamic":
            DYNAMIC_LOOKUP[sport][movement_name] = config

# Session-based analyzer instances (keyed by session_key)
# In production, this should use Redis or a session-aware cache
SESSION_ANALYZERS: Dict[str, DynamicAnalyzer] = {}


def is_dynamic(sport: str, pose_name: Optional[str] = None) -> bool:
    """
    Determine if a sport/pose combination should use the dynamic pipeline.
    
    Returns True if:
    1. The specific pose_name exists in reference_movements.json as type "dynamic"
    2. OR the sport has ANY dynamic movements and no pose_name was specified
    """
    if sport not in DYNAMIC_LOOKUP:
        return False
    
    sport_movements = DYNAMIC_LOOKUP[sport]
    
    if pose_name and pose_name != "undefined":
        return pose_name in sport_movements
    
    # If no specific pose, check if the sport has any dynamic movements
    return len(sport_movements) > 0


def get_dynamic_movements(sport: str) -> List[str]:
    """
    Get all available dynamic movement names for a sport.
    """
    if sport not in DYNAMIC_LOOKUP:
        return []
    return list(DYNAMIC_LOOKUP[sport].keys())


def get_or_create_analyzer(session_key: str, sport: str, pose_name: str) -> Optional[DynamicAnalyzer]:
    """
    Get an existing DynamicAnalyzer for this session, or create a new one.
    """
    if session_key in SESSION_ANALYZERS:
        return SESSION_ANALYZERS[session_key]
    
    # Look up the movement config
    if sport not in DYNAMIC_LOOKUP or pose_name not in DYNAMIC_LOOKUP[sport]:
        # Try to find the first dynamic movement for this sport
        if sport in DYNAMIC_LOOKUP and DYNAMIC_LOOKUP[sport]:
            pose_name = list(DYNAMIC_LOOKUP[sport].keys())[0]
        else:
            return None
    
    config = DYNAMIC_LOOKUP[sport][pose_name]
    analyzer = DynamicAnalyzer(config)
    SESSION_ANALYZERS[session_key] = analyzer
    return analyzer


def analyze_dynamic_frame(
    session_key: str,
    sport: str,
    pose_name: str,
    keypoints: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """
    Main entry point for dynamic frame analysis.
    
    Args:
        session_key: Unique session identifier for temporal state management
        sport: Sport name
        pose_name: Movement name within the sport
        keypoints: Current frame keypoints
    
    Returns:
        Analysis result compatible with FrameAnalysis + dynamic extensions
    """
    analyzer = get_or_create_analyzer(session_key, sport, pose_name)
    
    if analyzer is None:
        # Fallback: return a basic result indicating no dynamic config found
        return {
            "score": 0,
            "joint_angles": {},
            "issues": [{
                "joint": "configuration",
                "problem": f"No dynamic movement configuration found for {sport}/{pose_name}",
                "correction": "This movement may only support static analysis.",
                "severity": "high"
            }],
            "overall_severity": "error",
            "pose_name": pose_name,
            "dynamic": True,
            "current_phase": "unknown",
            "phase_index": 0,
            "phase_changed": False,
            "phase_scores": {},
            "rep_count": 0,
            "fluidity_score": 0,
            "kinetic_chain": {"score": 0, "order_expected": [], "order_actual": []},
            "total_phases": 0,
            "is_cyclical": False,
        }
    
    return analyzer.analyze_frame(keypoints)


def cleanup_session(session_key: str):
    """Remove a session's analyzer to free memory."""
    if session_key in SESSION_ANALYZERS:
        del SESSION_ANALYZERS[session_key]
