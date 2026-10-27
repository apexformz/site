import os
import sys
import cv2
import json
import urllib.request

try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
except ImportError:
    print("MediaPipe is not installed. Run: pip install mediapipe opencv-python")
    sys.exit(1)

MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task'
MODEL_PATH = os.path.join(os.path.dirname(__file__), 'pose_landmarker_heavy.task')

def download_model():
    if not os.path.exists(MODEL_PATH):
        print("Downloading MediaPipe Pose model (this may take a moment)...")
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        print("Download complete.")

def create_detector():
    base_options = python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.PoseLandmarkerOptions(
        base_options=base_options,
        output_segmentation_masks=False)
    return vision.PoseLandmarker.create_from_options(options)

def extract_from_video(detector, video_path, source_name, is_start_only=False):
    cap = cv2.VideoCapture(video_path)
    frames_data = []
    frame_idx = 0
    start_extracted = False
    
    while cap.isOpened():
        success, image = cap.read()
        if not success:
            break
            
        # Convert BGR to RGB
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
        
        detection_result = detector.detect(mp_image)
        
        if detection_result.pose_landmarks:
            landmarks = detection_result.pose_landmarks[0]
            kps = []
            
            names = [
                'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
                'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow',
                'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index',
                'left_thumb', 'right_thumb', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
                'left_heel', 'right_heel', 'left_foot_index', 'right_foot_index'
            ]
            
            for i, lm in enumerate(landmarks):
                name = names[i] if i < len(names) else f'point_{i}'
                kps.append({
                    "name": name,
                    "x": lm.x,
                    "y": lm.y,
                    "z": lm.z,
                    "score": lm.presence
                })
            
            # Extract first valid frame (skip initial blur)
            if frame_idx >= 5 and not start_extracted:
                frames_data.append({
                    "source": f"{source_name}_start",
                    "type": "start_stance",
                    "keypoints": kps
                })
                start_extracted = True
                if is_start_only:
                    break
            
            # Extract dynamic frames every 3rd frame
            if start_extracted and frame_idx % 3 == 0 and not is_start_only:
                frames_data.append({
                    "source": f"{source_name}_dynamic",
                    "type": "reference",
                    "keypoints": kps
                })
                
        frame_idx += 1
        
    cap.release()
    return frames_data

FOLDER_TO_ID = {
    "Ap_chagi_front_kick": "ap_chagi_front_kick",
    "baka_chagi_Side_slide_roundhouse_kick": "baka_chagi_side_slide_roundhouse",
    "bandae_dollyo_chagi_reverse_roundhouse_kick": "bandae_dollyo_chagi_reverse_roundhouse",
    "dolyo_chagi_roundhouse_kick": "dollyo_chagi_roundhouse_kick",
    "dwi_chagi_Back_kick": "dwi_chagi_back_kick",
    "miro_chagi_push_kick": "miro_chagi_push_kick",
    "Preamble_dollyo_chagi_front_leg_slide_roundhouse_kick": "preamble_dollyo_chagi_front_leg_slide",
    "twio_ap_chagi_jumping_front_kick": "twio_ap_chagi_jumping_front_kick",
    "twio_dollyo_chagi_Jumping_roundhouse_kick": "twio_dollyo_chagi_jumping_roundhouse_kick",
    "yeop_chagi_side_kick": "yeop_chagi_side_kick"
}

def main():
    download_model()
    detector = create_detector()

    BASE_VIDEO_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "taekwando_training_videos"))
    OUTPUT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app", "services", "dynamic", "expert_data", "taekwondo"))
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    if not os.path.exists(BASE_VIDEO_DIR):
        print(f"Directory not found: {BASE_VIDEO_DIR}")
        return

    print(f"Scanning for videos in {BASE_VIDEO_DIR}")
    for folder in os.listdir(BASE_VIDEO_DIR):
        folder_path = os.path.join(BASE_VIDEO_DIR, folder)
        if not os.path.isdir(folder_path):
            continue
            
        movement_id = FOLDER_TO_ID.get(folder)
        if not movement_id:
            continue
            
        print(f"Processing {folder} -> {movement_id}...")
        all_frames = []
        
        for vid_file in os.listdir(folder_path):
            if not vid_file.endswith(".mp4"):
                continue
                
            vid_path = os.path.join(folder_path, vid_file)
            source_name = os.path.splitext(vid_file)[0]
            
            print(f"  Extracting from {vid_file}...")
            frames = extract_from_video(detector, vid_path, source_name, is_start_only=False)
            all_frames.extend(frames)
            print(f"    Extracted {len(frames)} frames.")
            
        if all_frames:
            out_path = os.path.join(OUTPUT_DIR, f"{movement_id}.json")
            with open(out_path, "w") as f:
                json.dump(all_frames, f)
            print(f"Saved {len(all_frames)} frames to {out_path}")

if __name__ == "__main__":
    main()
