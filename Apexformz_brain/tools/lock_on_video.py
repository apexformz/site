"""
Lock onto one person in a recorded video with SAM 2 and extract only their poses.

    python tools/lock_on_video.py --video clip.mp4 --point 0.42,0.55 [--frame 0] --out poses.jsonl --preview check.mp4

--point is a normalized position on the raw (un-mirrored) frame, of the person to follow, on sampled frame
--frame. The preview draws the locked outline (green) and the kept skeleton for a visual check.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for extra in ("packages/perception-py", "packages/contracts/python", "ml"):
    sys.path.insert(0, str(ROOT / extra))

from apexformz_perception.subject.lock_on import lock_on_video  # noqa: E402


def write_preview(video: str, result, out: Path, honor: bool, max_side: int) -> None:
    import cv2
    import numpy as np
    from apexformz_perception.io.video import read_frames
    stride = result.summary["stride"]
    writer = None
    edges = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27), (24, 26), (26, 28)]
    for i, (fid, ts, img) in enumerate(read_frames(video, stride=stride, max_side=max_side, honor_orientation=honor)):
        if i >= len(result.frames):
            break
        h, w = img.shape[:2]
        if writer is None:
            writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"mp4v"), 30.0 / stride if stride else 15.0, (w, h))
        m = result.masks.get(i)
        if m is not None and m.any():
            big = cv2.resize(m.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
            contours, _ = cv2.findContours(big, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(img, contours, -1, (0, 255, 0), 3)
        fr = result.frames[i]
        lm = {p["id"]: p for p in fr["normalized_landmarks"]}
        for a, b in edges:
            if a in lm and b in lm and lm[a]["visibility"] > 0.5 and lm[b]["visibility"] > 0.5:
                cv2.line(img, (int(lm[a]["x"] * w), int(lm[a]["y"] * h)), (int(lm[b]["x"] * w), int(lm[b]["y"] * h)), (255, 0, 255), 3)
        q = fr["quality"]
        has_mask = m is not None and m.any()
        label = "LOCKED" if lm else ("UNCERTAIN" if q.get("ambiguous_people") else ("NO BODY IN OUTLINE" if has_mask else "NOT IN VIEW"))
        cv2.putText(img, f"{label}  people={q.get('person_count')}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 3)
        writer.write(img)
    if writer is not None:
        writer.release()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True)
    ap.add_argument("--point", required=True, help="x,y normalized on the raw frame")
    ap.add_argument("--frame", type=int, default=0, help="sampled frame index of the tap")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--preview", type=Path)
    ap.add_argument("--sam-variant", default="tiny", choices=["tiny", "small", "base_plus", "large"])
    ap.add_argument("--sample-hz", type=float, default=30.0)
    ap.add_argument("--max-side", type=int, default=1280)
    ap.add_argument("--ignore-orientation", action="store_true", help="use encoded pixels (as the squash capture preparation does)")
    a = ap.parse_args()
    x, y = (float(v) for v in a.point.split(","))
    honor = not a.ignore_orientation
    result = lock_on_video(a.video, (x, y), a.frame, sam_variant=a.sam_variant, sample_hz=a.sample_hz, max_side=a.max_side,
                           honor_orientation=honor, keep_masks=bool(a.preview))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    with a.out.open("w", encoding="utf-8") as fh:
        for fr in result.frames:
            fh.write(json.dumps(fr, allow_nan=False) + "\n")
    if a.preview:
        write_preview(a.video, result, a.preview, honor, a.max_side)
    print(json.dumps(result.summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
