"""
Video Analyzer — Offline Video Analysis Service

Processes an uploaded video file through the full dynamic analysis pipeline
frame-by-frame. Uses MMPose (if available) for higher accuracy, or falls
back to MediaPipe.

Returns a comprehensive session report with per-phase scores, trajectory
similarity, kinetic chain evaluation, and fluidity metrics.
"""

import os
import json
import logging
from typing import Dict, List, Any, Optional

logger = logging.getLogger(__name__)

# Graceful imports for video processing
try:
    import cv2  # type: ignore
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False

try:
    import mediapipe as mp  # type: ignore
    MP_AVAILABLE = True
except ImportError:
    MP_AVAILABLE = False


def _mediapipe_extract(frame) -> List[Dict[str, Any]]:
    """Extract keypoints from a single frame using MediaPipe Pose."""
    if not MP_AVAILABLE:
        return []

    LANDMARK_NAMES = {
        11: "left_shoulder", 12: "right_shoulder",
        13: "left_elbow", 14: "right_elbow",
        15: "left_wrist", 16: "right_wrist",
        23: "left_hip", 24: "right_hip",
        25: "left_knee", 26: "right_knee",
        27: "left_ankle", 28: "right_ankle",
    }

    mp_pose = mp.solutions.pose
    with mp_pose.Pose(
        static_image_mode=True,
        min_detection_confidence=0.5,
    ) as pose:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = pose.process(rgb)
        if not results.pose_landmarks:
            return []

        keypoints = []
        for idx, landmark in enumerate(results.pose_landmarks.landmark):
            if idx in LANDMARK_NAMES:
                keypoints.append({
                    "name": LANDMARK_NAMES[idx],
                    "x": landmark.x,
                    "y": landmark.y,
                    "score": landmark.visibility,
                })
        return keypoints


def analyze_video(
    video_path: str,
    sport: str,
    pose_name: str,
    use_mmpose: bool = True,
    sample_every_n: int = 1,
) -> Dict[str, Any]:
    """
    Process an entire video through the dynamic analysis pipeline.

    Args:
        video_path:     Absolute path to the video file.
        sport:          Sport name (e.g. "taekwondo").
        pose_name:      Movement name (e.g. "ap_chagi").
        use_mmpose:     Prefer MMPose over MediaPipe (if installed).
        sample_every_n: Process every Nth frame (1 = all frames).

    Returns:
        A comprehensive analysis report dict.
    """
    if not CV2_AVAILABLE:
        return {"error": "OpenCV (cv2) is not installed. Cannot process video."}

    if not os.path.exists(video_path):
        return {"error": f"Video file not found: {video_path}"}

    # Determine pose estimator
    estimator = None
    estimator_name = "mediapipe"

    if use_mmpose:
        from app.services.mmpose_estimator import MMPoseEstimator
        mm = MMPoseEstimator()
        if mm.available:
            estimator = mm
            estimator_name = "mmpose"
            logger.info("Using MMPose for video analysis.")

    if estimator is None:
        if not MP_AVAILABLE:
            return {"error": "Neither MMPose nor MediaPipe is installed."}
        logger.info("Using MediaPipe for video analysis (MMPose not available).")

    # Open video
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"error": f"Could not open video: {video_path}"}

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # Create dynamic analyzer for this video
    from app.services.dynamic.movement_registry import DYNAMIC_LOOKUP
    if sport not in DYNAMIC_LOOKUP or pose_name not in DYNAMIC_LOOKUP[sport]:
        cap.release()
        return {"error": f"No dynamic config for {sport}/{pose_name}"}

    config = DYNAMIC_LOOKUP[sport][pose_name]

    from app.services.dynamic.dynamic_analyzer import DynamicAnalyzer
    analyzer = DynamicAnalyzer(config, fps_estimate=fps)

    # Process frames
    frame_results = []
    frame_idx = 0
    last_result = None

    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break

        if frame_idx % sample_every_n != 0:
            frame_idx += 1
            continue

        # Extract keypoints
        if estimator is not None:
            keypoints = estimator.extract_keypoints_from_frame(frame)
        else:
            keypoints = _mediapipe_extract(frame)

        if keypoints:
            result = analyzer.analyze_frame(keypoints)
            last_result = result
            frame_results.append({
                "frame": frame_idx,
                "timestamp_ms": round((frame_idx / fps) * 1000, 1),
                "score": result["score"],
                "phase": result["current_phase"],
                "phase_changed": result["phase_changed"],
                "fluidity": result["fluidity_score"],
            })

        frame_idx += 1

    cap.release()

    # Build summary report
    report = {
        "video_path": video_path,
        "sport": sport,
        "movement": pose_name,
        "estimator": estimator_name,
        "total_frames": total_frames,
        "frames_analyzed": len(frame_results),
        "fps": fps,
    }

    if last_result:
        report["final_score"] = last_result["score"]
        report["phase_scores"] = last_result.get("phase_scores", {})
        report["rep_count"] = last_result.get("rep_count", 0)
        report["fluidity_score"] = last_result.get("fluidity_score", 0)
        report["kinetic_chain"] = last_result.get("kinetic_chain", {})
        report["trajectory_similarity"] = last_result.get("trajectory_similarity")
        report["total_phases"] = last_result.get("total_phases", 0)
        report["issues"] = last_result.get("issues", [])
    else:
        report["final_score"] = 0
        report["error"] = "No poses detected in video."

    report["frame_timeline"] = frame_results

    return report
