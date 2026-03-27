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
    Compare current pose to reference and generate real-time feedback.
    """
    actual_angles = compute_joint_angles(keypoints)
    hand_feedback = analyze_hands(hands)
    
    # Selection logic: use provided pose_name or fall back to first one
    if sport not in REFERENCE_POSES:
        sport = "cricket" # default fallback
        
    sport_poses = REFERENCE_POSES[sport]
    if pose_name and pose_name in sport_poses:
        ref_angles = sport_poses[pose_name]
    else:
        # Fallback to the first available pose for this sport
        pose_name = list(sport_poses.keys())[0]
        ref_angles = sport_poses[pose_name]

    feedback = []
    total_error = 0
    joints_checked = 0

    for joint, actual_angle in actual_angles.items():
        if joint not in ref_angles:
            continue
            
        ref_angle = ref_angles[joint]
        error = abs(actual_angle - ref_angle)
        total_error += error
        joints_checked += 1

        if error <= 15:
            severity = "good"
            msg = "Perfect"
        elif error <= 30:
            severity = "warning"
            msg = f"Adjust your {joint.replace('_', ' ')}. Needs to be {'straighter' if ref_angle > actual_angle else 'more bent'}."
        else:
            severity = "error"
            msg = f"Fix your {joint.replace('_', ' ')}. Target is {ref_angle}°, you are at {int(actual_angle)}°."

        feedback.append({
            "joint": joint,
            "severity": severity,
            "message": msg,
            "angle_actual": round(actual_angle, 1),
            "angle_reference": ref_angle,
            "error_degrees": round(error, 1)
        })

    # Calculate 0-100 score
    avg_error = total_error / joints_checked if joints_checked > 0 else 100
    # 0 error = 100 score. 90 degree error = 0 score
    frame_score = max(0, min(100, 100 - (avg_error * (100 / 90))))
    
    # Boost score slightly if hand feedback is good
    if any(h['severity'] == 'good' for h in hand_feedback):
        frame_score = min(100, frame_score + 5)

    overall_severity = "good"
    if frame_score < 50:
        overall_severity = "error"
    elif frame_score < 80:
        overall_severity = "warning"

    return {
        "frame_score": round(frame_score, 1),
        "overall_severity": overall_severity,
        "joint_angles": actual_angles,
        "feedback": feedback + hand_feedback
    }
