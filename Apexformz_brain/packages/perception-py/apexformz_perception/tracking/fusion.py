"""Sport-agnostic fusion utilities between TrackSets and PoseFrame sequences.

* ``assign_tracks_to_subject``: label each track with the nearest tracked subject.
* ``fill_landmark_gaps``: fill short occlusion gaps of landmarks with point tracks seeded at the last
  visible landmark position; filled samples get reduced visibility and are listed in
  ``quality.filled_from_tracks`` so nothing is invented silently (TRD 03 "predicted samples reduce
  evidence reliability").
* ``track_to_equipment_observations``: convert object/point tracks into the TS ``EquipmentObservation``
  shape (``packages/perception/src/types.ts``).
"""
from __future__ import annotations

import copy
from typing import Dict, List, Optional, Sequence

import numpy as np

from apexformz_contracts.models import ModelProvenance, TrackSet

CORE_LANDMARKS = (11, 12, 23, 24, 25, 26, 27, 28)  # shoulders, hips, knees, ankles (MediaPipe 33 ids)


def _subject_bbox(frame: dict) -> Optional[np.ndarray]:
    lms = frame.get("normalized_landmarks") or []
    pts = [(l["x"], l["y"]) for l in lms if l.get("id") in CORE_LANDMARKS and (l.get("visibility") or 0) >= 0.5]
    if not pts:
        return None
    a = np.array(pts)
    return np.array([a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()])


def _dist_to_bbox(x: float, y: float, b: np.ndarray) -> float:
    dx = max(b[0] - x, 0.0, x - b[2])
    dy = max(b[1] - y, 0.0, y - b[3])
    return float(np.hypot(dx, dy))


def assign_tracks_to_subject(trackset: TrackSet, pose_frames: Sequence[dict], max_distance: float = 0.15) -> TrackSet:
    """Assign each track to the subject (``tracked_subject_id``) whose bbox it lies in/near most often.

    ``pose_frames`` are PoseFrame dicts (one subject each, possibly different subject ids over time).
    Tracks farther than ``max_distance`` (normalised) from every subject keep ``assigned_subject_id=None``.
    """
    by_frame: Dict[int, dict] = {int(f["frame_id"]): f for f in pose_frames}
    out = trackset.model_copy(deep=True)
    for tr in out.tracks:
        votes: Dict[str, int] = {}
        for p in tr.points:
            if not p.visible:
                continue
            f = by_frame.get(p.frame_id)
            if not f:
                continue
            b = _subject_bbox(f)
            sid = f.get("tracked_subject_id")
            if b is None or not sid:
                continue
            if _dist_to_bbox(p.x, p.y, b) <= max_distance:
                votes[sid] = votes.get(sid, 0) + 1
        tr.assigned_subject_id = max(votes, key=votes.get) if votes else None
    return out


def seed_queries_from_landmarks(pose_frames: Sequence[dict], landmark_ids: Sequence[int], min_visibility: float = 0.5) -> List[dict]:
    """For each landmark, the first frame where it is visible becomes a (frame_id, x, y) query with the landmark id as label."""
    queries = []
    for lid in landmark_ids:
        for f in pose_frames:
            lm = next((l for l in f.get("normalized_landmarks", []) if l.get("id") == lid), None)
            if lm and (lm.get("visibility") or 0) >= min_visibility:
                queries.append({"frame_id": int(f["frame_id"]), "x": float(lm["x"]), "y": float(lm["y"]), "label": f"landmark:{lid}"})
                break
    return queries


def fill_landmark_gaps(pose_frames: Sequence[dict], trackset: TrackSet, max_gap_frames: int = 8, min_visibility: float = 0.5, filled_visibility: float = 0.4) -> List[dict]:
    """Fill short landmark occlusion gaps from tracks labelled ``landmark:<id>``.

    Only gaps strictly shorter than ``max_gap_frames`` that are bounded by visible observations on
    both sides are filled, and only where the track itself is visible. Filled landmarks get
    ``visibility=filled_visibility`` and ``quality.filled_from_tracks`` records ``{"landmark_id", "track_id"}``.
    The input is not modified.
    """
    frames = [copy.deepcopy(f) for f in pose_frames]
    idx_by_frame = {int(f["frame_id"]): i for i, f in enumerate(frames)}
    for tr in trackset.tracks:
        if not (tr.label or "").startswith("landmark:"):
            continue
        lid = int(tr.label.split(":", 1)[1])
        pts_by_frame = {p.frame_id: p for p in tr.points if p.visible}
        # find visibility timeline for this landmark
        vis = []
        for f in frames:
            lm = next((l for l in f.get("normalized_landmarks", []) if l.get("id") == lid), None)
            vis.append(bool(lm) and (lm.get("visibility") or 0) >= min_visibility)
        i = 0
        n = len(frames)
        while i < n:
            if vis[i]:
                i += 1
                continue
            j = i
            while j < n and not vis[j]:
                j += 1
            gap = j - i
            bounded = i > 0 and j < n
            if bounded and gap < max_gap_frames:
                for k in range(i, j):
                    fid = int(frames[k]["frame_id"])
                    p = pts_by_frame.get(fid)
                    if p is None:
                        continue
                    lms = frames[k].setdefault("normalized_landmarks", [])
                    lm = next((l for l in lms if l.get("id") == lid), None)
                    if lm is None:
                        lm = {"id": lid, "x": 0.0, "y": 0.0}
                        lms.append(lm)
                    lm["x"], lm["y"] = float(p.x), float(p.y)
                    lm["visibility"] = filled_visibility
                    lm["presence"] = filled_visibility
                    q = frames[k].setdefault("quality", {})
                    q.setdefault("filled_from_tracks", []).append({"landmark_id": lid, "track_id": tr.track_id})
                    if "missing_joints" in q and lid in q["missing_joints"]:
                        q["missing_joints"] = [m for m in q["missing_joints"] if m != lid]
            i = j
    return frames


def track_to_equipment_observations(trackset: TrackSet, label: Optional[str] = None, provenance: Optional[ModelProvenance] = None) -> List[dict]:
    """Flatten tracks into EquipmentObservation dicts (TS shape: object_class, assigned_subject_id,
    coordinate_system, frame_id, timestamp_ms, confidence, bbox?, keypoints?, provenance)."""
    prov = (provenance or trackset.source).model_dump()
    out: List[dict] = []
    for tr in trackset.tracks:
        cls = label or tr.label or "unknown_object"
        for p in tr.points:
            if not p.visible:
                continue
            obs = {
                "object_class": cls,
                "assigned_subject_id": tr.assigned_subject_id,
                "coordinate_system": trackset.coordinate_system,
                "frame_id": p.frame_id,
                "timestamp_ms": p.timestamp_ms if p.timestamp_ms is not None else 0.0,
                "confidence": p.confidence if p.confidence is not None else 0.0,
                "keypoints": [{"id": 0, "x": p.x, "y": p.y, "confidence": p.confidence}],
                "provenance": prov,
            }
            if p.bbox:
                obs["bbox"] = {"x0": p.bbox[0], "y0": p.bbox[1], "x1": p.bbox[2], "y1": p.bbox[3]}
            out.append(obs)
    return out


def track_displacement_stats(trackset: TrackSet) -> Dict[str, float]:
    """Per-frame displacement statistics (normalised units) over visible consecutive points; used by tests and QA."""
    steps = []
    vis_frac = []
    for tr in trackset.tracks:
        pts = tr.points
        vis_frac.append(sum(p.visible for p in pts) / max(1, len(pts)))
        for a, b in zip(pts, pts[1:]):
            if a.visible and b.visible:
                steps.append(float(np.hypot(b.x - a.x, b.y - a.y)))
    return {
        "max_step": max(steps) if steps else 0.0,
        "mean_step": float(np.mean(steps)) if steps else 0.0,
        "mean_visible_fraction": float(np.mean(vis_frac)) if vis_frac else 0.0,
    }
