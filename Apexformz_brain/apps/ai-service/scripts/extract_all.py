import os
import sys
import json
import glob

# Add parent directory to path so we can import video_extractor
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.dynamic.pyomeca_adapter import PyomecaStreamAdapter

import urllib.request

try:
    import cv2  # type: ignore
    import mediapipe as mp  # type: ignore
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
except ImportError:
    print("Error: Missing required libraries.")
    sys.exit(1)

model_path = os.path.join(os.path.dirname(__file__), 'pose_landmarker.task')
if not os.path.exists(model_path):
    print("Downloading Pose Landmarker model...")
    urllib.request.urlretrieve(
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
        model_path
    )

def format_keypoints(pose_landmarks):
    keypoints = []
    LANDMARK_NAMES = {
        11: "left_shoulder", 12: "right_shoulder",
        13: "left_elbow", 14: "right_elbow",
        15: "left_wrist", 16: "right_wrist",
        23: "left_hip", 24: "right_hip",
        25: "left_knee", 26: "right_knee",
        27: "left_ankle", 28: "right_ankle"
    }
    for idx, landmark in enumerate(pose_landmarks):
        if idx in LANDMARK_NAMES:
            keypoints.append({
                "name": LANDMARK_NAMES[idx],
                "x": landmark.x,
                "y": landmark.y,
                "z": landmark.z,
                "score": landmark.visibility if hasattr(landmark, 'visibility') else 1.0
            })
    return keypoints

def process_video(video_path):
    print(f"Opening video: {video_path}")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"Error: Could not open video {video_path}")
        return []
        
    fps = cap.get(cv2.CAP_PROP_FPS)
    trajectory = []
    
    adapter = PyomecaStreamAdapter(fps_estimate=fps, window_size=15)
    
    base_options = python.BaseOptions(model_asset_path=model_path)
    options = vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.VIDEO)
    
    with vision.PoseLandmarker.create_from_options(options) as landmarker:
        frame_idx = 0
        while cap.isOpened():
            success, image = cap.read()
            if not success:
                break
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
            
            # Calculate timestamp in milliseconds
            timestamp_ms = int((frame_idx / fps) * 1000)
            pose_result = landmarker.detect_for_video(mp_image, timestamp_ms)
            
            if pose_result and pose_result.pose_landmarks and len(pose_result.pose_landmarks) > 0:
                keypoints = format_keypoints(pose_result.pose_landmarks[0])
                angles, _ = adapter.process_frame(keypoints)
                valid_angles = {k: v for k, v in angles.items() if v >= 0}
                trajectory.append(valid_angles)
            else:
                trajectory.append({})
            frame_idx += 1
            
    cap.release()
    return trajectory

def main():
    base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../taekwando_training_videos"))
    ref_json_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../app/data/reference_movements.json"))
    
    with open(ref_json_path, 'r') as f:
        data = json.load(f)
        
    if "taekwondo" not in data:
        print("taekwondo not found in reference_movements.json, creating...")
        data["taekwondo"] = {}

    # Iterate over all .mp4 files
    search_pattern = os.path.join(base_dir, "**/*.mp4")
    video_files = glob.glob(search_pattern, recursive=True)
    
    for vf in video_files:
        # Folder name is the movement name (maybe slightly different case/symbols)
        folder_name = os.path.basename(os.path.dirname(vf)).lower()
        # Clean folder name to match reference keys
        key = folder_name.replace(" ", "_")
        
        # Match with actual keys in reference_movements if there are slight spelling differences
        matched_key = None
        for k in data.get("taekwondo", {}).keys():
            if key in k or k in key or k.lower() == key.lower():
                matched_key = k
                break
                
        # Handle specific mismatches based on folder names vs keys
        if "ap_chagi" in key and "jumping" not in key: matched_key = "ap_chagi_front_kick"
        elif "baka_chagi" in key: matched_key = "baka_chagi_side_slide_roundhouse"
        elif "bandae" in key: matched_key = "bandae_dollyo_chagi_reverse_roundhouse"
        elif "dolyo_chagi" in key and "preamble" not in key: matched_key = "dollyo_chagi_roundhouse_kick"
        elif "dwi_chagi" in key: matched_key = "dwi_chagi_back_kick"
        elif "miro_chagi" in key: matched_key = "miro_chagi_push_kick"
        elif "preamble" in key: matched_key = "preamble_dollyo_chagi_front_leg_slide"
        elif "twio_ap_chagi" in key: matched_key = "twio_ap_chagi_jumping_front_kick"
        elif "twio_dollyo_chagi" in key: matched_key = "twio_dollyo_chagi_jumping_roundhouse"
        elif "yeop_chagi" in key: matched_key = "yeop_chagi_side_kick"

        if matched_key:
            print(f"Processing {vf} for key {matched_key}...")
            trajectory = process_video(vf)
            if trajectory:
                data["taekwondo"][matched_key]["reference_trajectory"] = trajectory
                print(f"Added {len(trajectory)} frames to {matched_key}")
        else:
            print(f"Warning: Could not match folder '{folder_name}' to any taekwondo movement.")

    with open(ref_json_path, 'w') as f:
        json.dump(data, f, indent=2)
        
    print("Successfully updated reference_movements.json with video telemetry.")

if __name__ == "__main__":
    main()
