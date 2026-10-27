"""
SAM 2 lock-on for recorded videos (sport-agnostic).

The user taps the athlete once, on any frame. SAM 2.1 then segments that person and carries the mask
forward and backward through the clip; it follows pixels and shape, so turning around and identical kit
do not break it. Pose estimation then runs on every frame, and only the skeleton lying inside the locked
mask is kept:
- two skeletons inside the mask make the frame ambiguous and it is withheld;
- an empty mask means the athlete is not in view.

Every frame records quality.identity_method = "sam2" and identity_score = the share of the body inside
the mask. GPU-class: on a laptop RTX it runs offline over a clip, not live.
"""
from __future__ import annotations

import os
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

BODY = (0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28)
MASK_SCALE = 4  # masks are kept at 1/4 resolution: about 60 KB per frame


def body_coverage(xy: np.ndarray, scores: np.ndarray, mask: np.ndarray, min_visibility: float = 0.5, min_points: int = 6) -> Optional[float]:
    """Share of the visible body landmarks that fall inside the mask, or None when too few are visible."""
    h, w = mask.shape
    pts = [(xy[i, 0], xy[i, 1]) for i in BODY if scores[i] >= min_visibility]
    if len(pts) < min_points:
        return None
    inside = 0
    for x, y in pts:
        cx, cy = int(np.clip(x * w, 0, w - 1)), int(np.clip(y * h, 0, h - 1))
        inside += bool(mask[cy, cx])
    return inside / len(pts)


def select_by_mask(people: Sequence[Tuple[np.ndarray, np.ndarray]], mask: Optional[np.ndarray],
                   min_coverage: float = 0.6, margin: float = 0.25) -> Tuple[Optional[int], bool, Optional[float]]:
    """(index, ambiguous, coverage) of the person inside the locked mask."""
    if mask is None or not mask.any():
        return None, False, None
    cov = [body_coverage(xy, sc, mask) for xy, sc in people]
    ranked = sorted(((c, i) for i, c in enumerate(cov) if c is not None), reverse=True)
    # a low detection threshold can report one person twice: near-identical skeletons are the same person
    boxes = {i: _box(people[i]) for _, i in ranked}
    kept: List[Tuple[float, int]] = []
    for c, i in ranked:
        if all(_same_person(boxes[i], boxes[j]) is False for _, j in kept):
            kept.append((c, i))
    ranked = kept
    if not ranked or ranked[0][0] < min_coverage:
        return None, False, ranked[0][0] if ranked else None
    if len(ranked) > 1 and ranked[1][0] > ranked[0][0] - margin:
        return None, True, ranked[0][0]  # two bodies share the mask: crossing or occlusion
    return ranked[0][1], False, ranked[0][0]


def _box(person: Tuple[np.ndarray, np.ndarray], min_visibility: float = 0.5) -> Optional[Tuple[float, float, float, float]]:
    xy, sc = person
    ok = sc >= min_visibility
    if ok.sum() < 2:
        return None
    (x0, y0), (x1, y1) = xy[ok].min(0), xy[ok].max(0)
    return float(x0), float(y0), float(x1), float(y1)


def _same_person(a, b) -> bool:
    """Boxes that mostly overlap (IoU > 0.5, or one 70 % inside the other) belong to one person."""
    if a is None or b is None:
        return False
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    aa, ab = (a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])
    if aa <= 0 or ab <= 0:
        return False
    return ix / (aa + ab - ix) > 0.5 or ix / min(aa, ab) >= 0.7


def tapped_person_box(people: Sequence[Tuple[np.ndarray, np.ndarray]], point: Tuple[float, float],
                      min_visibility: float = 0.5, tap_radius: float = 0.08) -> Optional[Tuple[float, float, float, float]]:
    """Whole-body box (normalized, padded) of the person under the tap, so SAM 2 locks the whole person, not a limb."""
    best, best_d = None, float("inf")
    for xy, sc in people:
        ok = sc >= min_visibility
        if ok.sum() < 6:
            continue
        x0, y0 = xy[ok].min(0)
        x1, y1 = xy[ok].max(0)
        inside = x0 - 0.03 <= point[0] <= x1 + 0.03 and y0 - 0.03 <= point[1] <= y1 + 0.03
        d = float(np.min(np.hypot(xy[ok, 0] - point[0], xy[ok, 1] - point[1])))
        if (inside or d <= tap_radius) and d < best_d:
            px, py = 0.08 * (x1 - x0), 0.06 * (y1 - y0)  # landmarks sit inside the silhouette: pad to the outline
            best, best_d = (max(0.0, x0 - px), max(0.0, y0 - py), min(1.0, x1 + px), min(1.0, y1 + py)), d
    return best


def _dilate(mask: np.ndarray, px: int = 2) -> np.ndarray:
    import cv2
    return cv2.dilate(mask.astype(np.uint8), np.ones((2 * px + 1, 2 * px + 1), np.uint8)).astype(bool)


@dataclass
class LockOnResult:
    frames: List[Dict[str, Any]]
    summary: Dict[str, Any] = field(default_factory=dict)
    masks: Dict[int, np.ndarray] = field(default_factory=dict)


def lock_on_video(video_path: str, point: Tuple[float, float], frame_index: int = 0, *, sam_variant: str = "tiny",
                  pose_variant: str = "full", sample_hz: float = 30.0, max_side: int = 1280, honor_orientation: bool = True,
                  session_id: Optional[str] = None, camera_id: str = "video", keep_masks: bool = False) -> LockOnResult:
    """Lock onto the person under `point` (normalized, raw frame) on sampled frame `frame_index`."""
    import cv2
    import torch
    from apexformz_perception.io.video import probe, read_frames
    from apexformz_perception.pose import create_backend
    from apexformz_perception.pose.base import build_pose_frame
    from apexformz_perception.tracking.sam2_tracker import Sam2ObjectTracker

    if not (0 <= point[0] <= 1 and 0 <= point[1] <= 1):
        raise ValueError("point must be normalized (0..1)")
    info = probe(video_path, honor_orientation=honor_orientation)
    stride = max(1, round(info.fps / sample_hz)) if info.fps else 1
    t0 = time.perf_counter()
    masks: Dict[int, np.ndarray] = {}
    meta: List[Tuple[int, float, Tuple[int, int]]] = []
    tracker = Sam2ObjectTracker(variant=sam_variant)
    predictor = tracker._load()
    tap_frame = None
    with tempfile.TemporaryDirectory(prefix="apexformz_lockon_") as tmp:
        for i, (fid, ts, img) in enumerate(read_frames(video_path, stride=stride, max_side=max_side, honor_orientation=honor_orientation)):
            cv2.imwrite(os.path.join(tmp, f"{i:05d}.jpg"), img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
            meta.append((fid, ts, (img.shape[1], img.shape[0])))
            if i == frame_index:
                tap_frame = (img.copy(), ts, fid)
        if not meta:
            raise ValueError("video has no frames")
        if not 0 <= frame_index < len(meta):
            raise ValueError(f"frame_index must be within 0..{len(meta) - 1}")
        W, H = meta[0][2]
        small = (max(1, W // MASK_SCALE), max(1, H // MASK_SCALE))
        # the tapped person's whole-body box makes SAM 2 lock the person, not the limb or racket under the finger
        probe_pose = create_backend("mediapipe", variant=pose_variant, num_poses=3, prefer_gpu=False)
        try:
            tapped = probe_pose.detect(tap_frame[0], tap_frame[1], tap_frame[2])
        finally:
            probe_pose.close()
        box = tapped_person_box([(p.xy, p.scores) for p in tapped], point)
        cuda = tracker.device == "cuda"
        ctx = torch.autocast("cuda", dtype=torch.bfloat16) if cuda else torch.autocast("cpu", enabled=False)
        with torch.inference_mode(), ctx:
            state = predictor.init_state(video_path=tmp, offload_video_to_cpu=True)
            predictor.add_new_points_or_box(state, frame_idx=frame_index, obj_id=1,
                                            points=np.array([[point[0] * W, point[1] * H]], dtype=np.float32), labels=np.array([1], dtype=np.int32),
                                            box=None if box is None else np.array([box[0] * W, box[1] * H, box[2] * W, box[3] * H], dtype=np.float32))
            for reverse in (False, True):
                if reverse and frame_index == 0:
                    break
                for fidx, _ids, logits in predictor.propagate_in_video(state, start_frame_idx=frame_index, reverse=reverse):
                    m = (logits[0, 0] > 0.0).float().cpu().numpy()
                    masks.setdefault(int(fidx), cv2.resize(m, small, interpolation=cv2.INTER_AREA) > 0.5)
            predictor.reset_state(state)
    t_sam = time.perf_counter() - t0
    if cuda:
        torch.cuda.empty_cache()

    backend = create_backend("mediapipe", variant=pose_variant, num_poses=3, prefer_gpu=False)
    provenance = backend.provenance()
    frames: List[Dict[str, Any]] = []
    counts = {"locked": 0, "ambiguous": 0, "not_in_view": 0, "no_body_inside": 0}
    try:
        for i, (fid, ts, img) in enumerate(read_frames(video_path, stride=stride, max_side=max_side, honor_orientation=honor_orientation)):
            if i >= len(meta):
                break
            people = backend.detect(img, ts, fid)
            mask = masks.get(i)
            mask_d = _dilate(mask) if mask is not None and mask.any() else mask
            idx, ambiguous, cov = select_by_mask([(p.xy, p.scores) for p in people], mask_d)
            person = people[idx] if idx is not None else None
            h, w = img.shape[:2]
            frame = build_pose_frame(person, provenance=provenance, canonical=True, session_id=session_id or os.path.basename(video_path),
                                     frame_id=fid, timestamp_ms=ts, camera_id=camera_id, image_size=[w, h], mirror=False,
                                     orientation="portrait" if h > w else "landscape", tracked_subject_id="locked-1",
                                     person_count=len(people), ambiguous=ambiguous, track_changed=False)
            frame["quality"]["identity_method"] = "sam2" if person is not None else "none"
            frame["quality"]["identity_score"] = None if cov is None else round(float(cov), 4)
            frames.append(frame)
            if person is not None:
                counts["locked"] += 1
            elif ambiguous:
                counts["ambiguous"] += 1
            elif mask is None or not mask.any():
                counts["not_in_view"] += 1
            else:
                counts["no_body_inside"] += 1
    finally:
        backend.close()
    summary = {"frames": len(frames), **counts, "stride": stride, "prompt": {"frame_index": frame_index, "point": list(point),
                                                                              "body_box": None if box is None else [round(v, 4) for v in box]},
               "sam": f"sam2.1_hiera_{sam_variant}", "device": tracker.device, "sam_seconds": round(t_sam, 2),
               "total_seconds": round(time.perf_counter() - t0, 2)}
    return LockOnResult(frames=frames, summary=summary, masks=masks if keep_masks else {})
