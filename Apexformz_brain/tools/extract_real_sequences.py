"""Extract real pose sequences (pose-only, no media) for tests/golden/data/real. Usage: python tools/extract_real_sequences.py [source-videos-dir]."""
import json, os, sys, time
from apexformz_perception.pose import create_backend
from apexformz_perception.pose.extract import extract_pose_sequence

SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "Apexformz", "taekwando_training_videos")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "golden", "data", "real")
CLIPS = [
    ("Ap_chagi_front_kick", "front.mp4", "front_kick_front"),
    ("dolyo_chagi_roundhouse_kick", "left.mp4", "roundhouse_left"),
    ("yeop_chagi_side_kick", "right.mp4", "side_kick_right"),
]
backend = create_backend("mediapipe", variant="full", num_poses=2)
summary = []
for folder, file, name in CLIPS:
    path = os.path.join(SRC, folder, file)
    t0 = time.perf_counter()
    res = extract_pose_sequence(path, backend, session_id=f"real-{name}", camera_id=name.split("_")[-1], max_frames=150, max_side=960)
    dt = time.perf_counter() - t0
    out = os.path.join(OUT, f"{name}.jsonl")
    with open(out, "w", encoding="utf-8") as fh:
        for f in res.frames:
            fh.write(json.dumps(f) + "\n")
    ok = sum(1 for f in res.frames if f["quality"]["framing_ok"])
    summary.append({"clip": f"{folder}/{file}", "frames": len(res.frames), "framing_ok": ok, "fps": round(len(res.frames) / dt, 1), "provenance": res.provenance, "video": res.video})
    print(name, len(res.frames), "frames", ok, "framing_ok", f"{len(res.frames)/dt:.1f} fps")
json.dump(summary, open(os.path.join(OUT, "_extraction_summary.json"), "w"), indent=2)
