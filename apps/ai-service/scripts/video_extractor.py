import sys
import os
import json
try:
    import cv2  # type: ignore
    import mediapipe as mp  # type: ignore
except ImportError:
    print("Error: Missing required libraries.")
    print("Please run: pip install opencv-python mediapipe")
    sys.exit(1)
import argparse

# Add parent directory to path so we can import from app
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.dynamic.phase_detector import compute_all_angles

mp_pose = mp.solutions.pose

def format_keypoints(pose_landmarks):
    """Convert mediapipe landmarks to the dict format expected by compute_all_angles"""
    keypoints = []
    
    LANDMARK_NAMES = {
        11: "left_shoulder", 12: "right_shoulder",
        13: "left_elbow", 14: "right_elbow",
        15: "left_wrist", 16: "right_wrist",
        23: "left_hip", 24: "right_hip",
        25: "left_knee", 26: "right_knee",
        27: "left_ankle", 28: "right_ankle"
    }
    
    for idx, landmark in enumerate(pose_landmarks.landmark):
        if idx in LANDMARK_NAMES:
            keypoints.append({
                "name": LANDMARK_NAMES[idx],
                "x": landmark.x,
                "y": landmark.y,
                "z": landmark.z,
                "score": landmark.visibility
            })
            
    return keypoints

def extract_telemetry(video_path, output_path):
    print(f"Opening video: {video_path}")
    cap = cv2.VideoCapture(video_path)
    
    if not cap.isOpened():
        print(f"Error: Could not open video {video_path}")
        return
        
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    print(f"Video loaded: {total_frames} frames @ {fps} FPS")

    telemetry = {
        "metadata": {
            "fps": fps,
            "total_frames": total_frames
        },
        "frames": []
    }

    with mp_pose.Pose(min_detection_confidence=0.5, min_tracking_confidence=0.5) as pose:
        frame_idx = 0
        while cap.isOpened():
            success, image = cap.read()
            if not success:
                break

            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            results = pose.process(image_rgb)

            if results.pose_landmarks:
                keypoints = format_keypoints(results.pose_landmarks)
                angles = compute_all_angles(keypoints)
                valid_angles = {k: v for k, v in angles.items() if v >= 0}
                
                telemetry["frames"].append({
                    "frame": frame_idx,
                    "timestamp_ms": (frame_idx / fps) * 1000,
                    "angles": valid_angles
                })
            else:
                telemetry["frames"].append({
                    "frame": frame_idx,
                    "timestamp_ms": (frame_idx / fps) * 1000,
                    "angles": {}
                })
                
            frame_idx += 1
            if frame_idx % 30 == 0:
                print(f"Processed {frame_idx}/{total_frames} frames...")

    cap.release()
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    
    with open(output_path, 'w') as f:
        json.dump(telemetry, f, indent=2)
        
    print(f"Done! Telemetry saved to {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Extract joint angle telemetry from expert videos')
    parser.add_argument('video', type=str, help='Path to the input video file')
    parser.add_argument('output', type=str, help='Path to the output JSON file')
    args = parser.parse_args()
    
    extract_telemetry(args.video, args.output)
