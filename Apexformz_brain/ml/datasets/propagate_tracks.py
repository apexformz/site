"""Annotation propagation with point trackers (TRD 12).

Takes a clip plus either keyframe annotations ``{"frame_id": int, "points": [{"label", "x", "y"}]}``
(normalised coordinates) or a PoseFrame JSONL (landmarks seed the queries), runs a tracker from
``apexformz_perception.tracking.registry`` and writes a TrackSet JSON that annotators review.

    python ml/datasets/propagate_tracks.py --video clip.mp4 --keyframes kf.json --tracker bootstapir_offline --out tracks.json
    python ml/datasets/propagate_tracks.py --video clip.mp4 --poseframes frames.jsonl --landmarks 25,26,27,28 --out tracks.json

Propagated tracks are proposals: TrackSet.retrospective is true for offline trackers and every point
carries visibility/confidence so reviewers can reject low-confidence spans.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

Query = Tuple[int, float, float]


def queries_from_keyframes(keyframes: Sequence[Dict[str, Any]]) -> Tuple[List[Query], List[Optional[str]]]:
    qs: List[Query] = []
    labels: List[Optional[str]] = []
    for kf in keyframes:
        fid = int(kf["frame_id"])
        for p in kf.get("points", []):
            qs.append((fid, float(p["x"]), float(p["y"])))
            labels.append(p.get("label"))
    return qs, labels


def queries_from_poseframes(frames: Sequence[Dict[str, Any]], landmark_ids: Sequence[int], min_visibility: float = 0.5) -> Tuple[List[Query], List[Optional[str]]]:
    from apexformz_perception.tracking.fusion import seed_queries_from_landmarks

    seeds = seed_queries_from_landmarks(frames, landmark_ids, min_visibility)
    return [(s["frame_id"], s["x"], s["y"]) for s in seeds], [s["label"] for s in seeds]


def read_jsonl(path: pathlib.Path) -> List[Dict[str, Any]]:
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def propagate(frames_or_path, queries: List[Query], labels: List[Optional[str]], tracker, fps: Optional[float] = None, video_ref: Optional[str] = None):
    """Run ``tracker`` (PointTracker or OnlineTracker with track_clip) and return a validated TrackSet."""
    from apexformz_contracts.validate import validate

    if not queries:
        raise ValueError("no queries to propagate")
    if hasattr(tracker, "track_clip"):
        ts = tracker.track_clip(frames_or_path, queries, fps=fps, video_ref=video_ref, labels=labels)
    else:
        ts = tracker.track(frames_or_path, queries, fps=fps, video_ref=video_ref, labels=labels)
    errors = validate("trackSet", ts.model_dump(exclude_none=True))
    if errors:
        raise ValueError(f"tracker produced an invalid TrackSet: {errors[:3]}")
    ts.notes = list(ts.notes or []) + ["annotation_propagation_proposal: review before use as labels"]
    return ts


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--video", required=True, help="clip path (mp4) ")
    ap.add_argument("--keyframes", help="keyframe annotation JSON (list of {frame_id, points:[{label,x,y}]})")
    ap.add_argument("--poseframes", help="PoseFrame JSONL to seed landmark queries")
    ap.add_argument("--landmarks", default="11,12,23,24,25,26,27,28", help="landmark ids to seed from poseframes")
    ap.add_argument("--tracker", default="bootstapir_offline")
    ap.add_argument("--allow-noncommercial", action="store_true", help="permit CC-BY-NC trackers (research only)")
    ap.add_argument("--max-frames", type=int, default=None)
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    from apexformz_perception.tracking import registry
    from apexformz_perception.tracking._video import read_video

    if args.keyframes:
        qs, labels = queries_from_keyframes(json.load(open(args.keyframes, encoding="utf-8")))
    elif args.poseframes:
        ids = [int(x) for x in args.landmarks.split(",") if x.strip()]
        qs, labels = queries_from_poseframes(read_jsonl(pathlib.Path(args.poseframes)), ids)
    else:
        ap.error("--keyframes or --poseframes required")
    frames, fps = read_video(args.video, max_frames=args.max_frames, stride=args.stride)
    tracker = registry.create(args.tracker, allow_noncommercial=args.allow_noncommercial)
    ok, why = tracker.available()
    if not ok:
        print(f"tracker unavailable: {why}", file=sys.stderr)
        return 2
    ts = propagate(frames, qs, labels, tracker, fps=fps, video_ref=args.video)
    pathlib.Path(args.out).write_text(json.dumps(ts.model_dump(exclude_none=True), indent=1), encoding="utf-8")
    print(f"wrote {args.out}: {len(ts.tracks)} tracks over {ts.frame_count} frames ({ts.source.model_id})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
