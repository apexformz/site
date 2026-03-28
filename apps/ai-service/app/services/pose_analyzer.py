import math
import json
import os
from typing import Dict, List, Any

# Load reference poses
DATA_DIR = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(DATA_DIR, '../data/reference_poses.json'), 'r') as f:
    REFERENCE_POSES = json.load(f)

def calculate_angle(p1: Dict[str, float], p2: Dict[str, float], p3: Dict[str, float]) -> float:
    """
    Calculate angle between 3 points (p2 is the vertex).
    Returns angle in degrees (0 to 180).
    """
    if p1['score'] < 0.3 or p2['score'] < 0.3 or p3['score'] < 0.3:
        return -1.0 # Invalid/unseen angle

    radians = math.atan2(p3['y'] - p2['y'], p3['x'] - p2['x']) - \
              math.atan2(p1['y'] - p2['y'], p1['x'] - p2['x'])
    angle = abs(radians * 180.0 / math.pi)

    if angle > 180.0:
        angle = 360 - angle

    return angle

def get_keypoint(keypoints: List[Dict[str, Any]], name: str) -> Dict[str, float]:
    for kp in keypoints:
        if kp['name'] == name:
            return kp
    return {"x": 0, "y": 0, "score": 0, "name": name}

def compute_joint_angles(keypoints: List[Dict[str, Any]]) -> Dict[str, float]:
    """
    Computes 10 major joint angles based on standard 17-keypoint model.
    """
    kp_map = {kp['name']: kp for kp in keypoints}

    angles = {
        "left_elbow": calculate_angle(kp_map.get('left_shoulder', {}), kp_map.get('left_elbow', {}), kp_map.get('left_wrist', {})),
        "right_elbow": calculate_angle(kp_map.get('right_shoulder', {}), kp_map.get('right_elbow', {}), kp_map.get('right_wrist', {})),
        "left_shoulder": calculate_angle(kp_map.get('left_hip', {}), kp_map.get('left_shoulder', {}), kp_map.get('left_elbow', {})),
        "right_shoulder": calculate_angle(kp_map.get('right_hip', {}), kp_map.get('right_shoulder', {}), kp_map.get('right_elbow', {})),
        "left_hip": calculate_angle(kp_map.get('left_shoulder', {}), kp_map.get('left_hip', {}), kp_map.get('left_knee', {})),
        "right_hip": calculate_angle(kp_map.get('right_shoulder', {}), kp_map.get('right_hip', {}), kp_map.get('right_knee', {})),
        "left_knee": calculate_angle(kp_map.get('left_hip', {}), kp_map.get('left_knee', {}), kp_map.get('left_ankle', {})),
        "right_knee": calculate_angle(kp_map.get('right_hip', {}), kp_map.get('right_knee', {}), kp_map.get('right_ankle', {})),
    }
    
    # Filter out unseen joints
    return {k: v for k, v in angles.items() if v >= 0}

def analyze_hands(hands: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Analyzes finger joint angles to detect grip quality.
    """
    hand_feedback = []
    
    for hand in hands:
        side = hand.get('handedness', 'Hand')
        kps = hand.get('keypoints', [])
        if len(kps) < 21:
            continue
            
        # Indices for Index Finger (5, 6, 7, 8)
        index_angle = calculate_angle(kps[5], kps[6], kps[7])
        # Indices for Middle Finger (9, 10, 11, 12)
        middle_angle = calculate_angle(kps[9], kps[10], kps[11])
        
        # Simple Logic: If fingers are highly bent (< 100), it's a "Tight Grip"
        if index_angle > 0 and index_angle < 100:
            hand_feedback.append({
                "joint": f"{side} Index",
                "severity": "good",
                "message": f"{side} grip looks firm.",
                "angle_actual": round(index_angle, 1)
            })
        elif index_angle >= 100:
            hand_feedback.append({
                "joint": f"{side} Index",
                "severity": "warning",
                "message": f"Open {side} palm detected. Ensure firm grip.",
                "angle_actual": round(index_angle, 1)
            })

    return hand_feedback

def analyze_pose(sport: str, keypoints: List[Dict[str, Any]], pose_name: str = None, hands: List[Dict[str, Any]] = []) -> Dict[str, Any]:
    """
    Dispatcher: Routes current frame to the specialized analyzer in the registry.
    """
    from .analyzers.registry import AnalyzerRegistry
    
    actual_angles = compute_joint_angles(keypoints)
    
    # Selection logic: prioritize incoming pose_name or default to first for the sport
    if not pose_name or pose_name == "undefined":
         from .analyzers.base import REFERENCE_POSES
         pose_name = list(REFERENCE_POSES.get(sport, {"unknown":{}}).keys())[0]

    # Perform modular analysis with temporal smoothing (5-frame window)
    analysis_result = AnalyzerRegistry.analyze_with_smoothing(
        sport=sport,
        pose_id=pose_name,
        keypoints=keypoints,
        actual_angles=actual_angles
    )
    
    # Optional: Combine with hand feedback if available
    # Hand feedback is now optional and can be appended to the issues list
    if hands:
        hand_feedback = analyze_hands(hands)
        for hf in hand_feedback:
            analysis_result['issues'].append({
                "joint": hf['joint'],
                "problem": hf['message'],
                "correction": "Ensure your grip is firm.",
                "severity": hf['severity']
            })

    return {
        "score": analysis_result['score'],
        "overall_severity": analysis_result['overall_severity'],
        "issues": analysis_result['issues'],
        "pose_name": pose_name,
        "joint_angles": actual_angles
    }
