import sys, os
sys.path.append(os.getcwd() + '/apps/ai-service')
import json
from app.services.dynamic.phase_detector import PhaseDetector

with open('apps/ai-service/app/data/reference_movements.json') as f:
    config = json.load(f)['taekwondo']['ap_chagi_front_kick']

detector = PhaseDetector(config['phases'])

# Simulate 300 frames of standing still
keypoints = [{'name': name, 'x': 0.5, 'y': y, 'score': 0.9} for name, y in [
    ('left_shoulder', 0.2), ('right_shoulder', 0.2),
    ('left_hip', 0.5), ('right_hip', 0.5),
    ('left_knee', 0.8), ('right_knee', 0.8),
    ('left_ankle', 1.0), ('right_ankle', 1.0)
]]

for i in range(300):
    res = detector.process_frame(keypoints)
    if res['phase_changed']:
        print(f"Frame {i}: Changed to phase {res['phase_index']} - Reps: {res['rep_count']}")

print('Final reps:', detector.rep_count)
