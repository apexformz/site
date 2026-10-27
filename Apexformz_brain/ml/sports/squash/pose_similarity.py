"""
Pose-based similarity between squash movement labels, measured on the labeled Data Capture recordings.

Every capture is one camera view of one labeled movement. A descriptor is computed per capture from its pose
stream (MediaPipe 33, image-normalized, as extracted by ml/ingestion):

  static photo   -> body-relative layout of 17 body landmarks + 12 joint angles / inclinations
  dynamic video  -> the same per-frame channels summarised over time (mean, std, min, max, value at 0/25/50/75/100%
                    of the clip) + root travel (hip-centre displacement in torso lengths: net x, net y, path length,
                    peak speed) + duration

Two movements are compared only on views both were filmed from (a front view is never compared with a left view);
the class distance is the mean over shared views of the z-scored Euclidean distance between their captures.
Only jointly observed descriptor channels contribute; at least 60 percent must overlap. Ambiguous subjects,
track changes and root discontinuities are excluded before descriptors are calculated.
Lower is more similar. Nothing here is sport-specific except the input files.
"""
from __future__ import annotations

import json
import math
import pathlib
from collections import Counter, defaultdict
from typing import Dict, List, Optional, Tuple

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
DATA = ROOT / "data" / "squash"

LM = {n: i for i, n in enumerate([
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow",
    "right_elbow", "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index",
    "left_thumb", "right_thumb", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_heel", "right_heel", "left_foot_index", "right_foot_index"])}
BODY = ["nose", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
        "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel", "right_heel",
        "left_foot_index", "right_foot_index"]
CORE = ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]
VIEWS = ("front", "back", "left", "right")


def _angle(a, b, c) -> float:
    u = a - b
    v = c - b
    nu, nv = np.linalg.norm(u), np.linalg.norm(v)
    if nu < 1e-9 or nv < 1e-9:
        return float("nan")
    return float(np.degrees(np.arccos(np.clip(np.dot(u, v) / (nu * nv), -1.0, 1.0))))


def _incl(a, b) -> float:
    """Inclination of segment a->b from image vertical (deg, signed)."""
    d = b - a
    if np.linalg.norm(d) < 1e-9:
        return float("nan")
    return float(np.degrees(math.atan2(d[0], -d[1])))


def frame_channels(lms: List[dict], size: Tuple[int, int], min_vis: float = 0.5) -> Optional[Tuple[np.ndarray, np.ndarray, float]]:
    """Per-frame channel vector, or None when the torso is not visible. Coordinates are aspect corrected."""
    w, h = size
    if not all(math.isfinite(x) and x > 0 for x in (w, h)):
        return None
    pts = {}
    for p in lms:
        if p.get("visibility", p.get("presence", 1.0)) >= min_vis and math.isfinite(p['x']) and math.isfinite(p['y']):
            pts[p["id"]] = np.array([p["x"] * w / h, p["y"]], dtype=float)
    if any(LM[n] not in pts for n in CORE):
        return None
    P = lambda n: pts.get(LM[n])  # noqa: E731
    hip = (P("left_hip") + P("right_hip")) / 2
    sh = (P("left_shoulder") + P("right_shoulder")) / 2
    torso = np.linalg.norm(sh - hip)
    if not math.isfinite(torso) or torso < 1e-6:
        return None
    coords = []
    for n in BODY:
        q = P(n)
        coords.extend(((q - hip) / torso).tolist() if q is not None else [np.nan, np.nan])
    def ang(a, b, c):
        return _angle(P(a), P(b), P(c)) if all(P(x) is not None for x in (a, b, c)) else np.nan
    angles = [
        ang("left_hip", "left_knee", "left_ankle"), ang("right_hip", "right_knee", "right_ankle"),
        ang("left_shoulder", "left_hip", "left_knee"), ang("right_shoulder", "right_hip", "right_knee"),
        ang("left_shoulder", "left_elbow", "left_wrist"), ang("right_shoulder", "right_elbow", "right_wrist"),
        ang("left_hip", "left_shoulder", "left_elbow"), ang("right_hip", "right_shoulder", "right_elbow"),
        _incl(hip, sh),
        _incl(P("left_shoulder"), P("right_shoulder")) if True else np.nan,
        (np.linalg.norm(P("left_ankle") - P("right_ankle")) / torso) if P("left_ankle") is not None and P("right_ankle") is not None else np.nan,
        (min(P("left_wrist")[1], P("right_wrist")[1]) - sh[1]) / torso if P("left_wrist") is not None and P("right_wrist") is not None else np.nan,
    ]
    # angles in degrees are scaled to ~unit range so they weigh like coordinates after z-scoring anyway
    return np.array(coords + angles, dtype=float), hip, torso


def read_pose(path: pathlib.Path) -> List[dict]:
    frames = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            if "_header" in o:
                continue
            frames.append(o)
    return frames


def usable_segments(frames: List[dict], counts: Optional[Counter] = None) -> List[List[dict]]:
    """Keep identity-safe, observed frames without joining different tracks or camera/time gaps.

    Uses the deployed tracker_root_v1 image-root bound (0.75 + 12 torso lengths/s).
    Partial limbs remain missing channels; they are never fabricated at a view-average position.
    """
    counts = counts if counts is not None else Counter()
    segments, current = [], []
    previous = None
    anchor = None
    for frame in frames:
        counts['frames_read'] += 1
        quality = frame.get('quality', {})
        reason = None
        timestamp = frame.get('timestamp_ms', float('nan'))
        channels = frame_channels(frame.get('normalized_landmarks', []), tuple(frame.get('image_size', (0, 0))))
        if quality.get('ambiguous_people') or quality.get('track_changed'):
            reason = 'identity_unsafe'
        elif not math.isfinite(timestamp) or channels is None:
            reason = 'invalid_time_or_torso'
        elif np.isfinite(channels[0]).mean() < 0.6:
            reason = 'insufficient_observed_channels'
        boundary = previous is not None and (timestamp <= previous['timestamp_ms'] or timestamp - previous['timestamp_ms'] > 400
            or frame.get('camera_id') != previous.get('camera_id') or frame.get('tracked_subject_id') != previous.get('tracked_subject_id'))
        if boundary:
            counts['continuity_boundaries'] += 1
            if current:
                segments.append(current)
            current, anchor = [], None
        if reason is None and anchor is not None:
            elapsed = max(0.0, (timestamp - anchor[2]) / 1000)
            if np.linalg.norm(channels[1] - anchor[0]) / anchor[1] > 0.75 + 12 * elapsed:
                reason = 'root_jump'
        if reason:
            counts['rejected_' + reason] += 1
            if current:
                segments.append(current)
            current = []
            # Keep the pre-jump anchor: do not follow a rejected subject.
            if reason != 'root_jump':
                anchor = None
        else:
            current.append(frame)
            anchor = (channels[1], channels[2], timestamp)
            counts['frames_usable'] += 1
        previous = frame
    if current:
        segments.append(current)
    return segments


def static_descriptor(frames: List[dict]) -> Optional[np.ndarray]:
    vals = []
    for f in frames:
        r = frame_channels(f["normalized_landmarks"], tuple(f["image_size"]))
        if r is not None:
            vals.append(r[0])
    if not vals:
        return None
    return np.nanmean(np.stack(vals), axis=0)


def dynamic_descriptor(frames: List[dict]) -> Optional[np.ndarray]:
    rows, roots, ts, torsos = [], [], [], []
    for f in frames:
        r = frame_channels(f["normalized_landmarks"], tuple(f["image_size"]))
        if r is None:
            continue
        rows.append(r[0]); roots.append(r[1]); torsos.append(r[2]); ts.append(f["timestamp_ms"])
    if len(rows) < 8:
        return None
    X = np.stack(rows)
    t = np.array(ts, dtype=float)
    # Summary over time; nan-robust.
    q = [np.nanpercentile(X, p, axis=0) for p in (0, 25, 50, 75, 100)]
    idx = [int(round(k * (len(X) - 1))) for k in (0, 0.25, 0.5, 0.75, 1.0)]
    at = [X[i] for i in idx]
    summary = np.concatenate([np.nanmean(X, 0), np.nanstd(X, 0)] + q + at)
    R = np.stack(roots)
    scale = float(np.nanmedian(torsos))
    disp = (R - R[0]) / scale
    step = np.linalg.norm(np.diff(R, axis=0), axis=1) / scale
    dt = np.diff(t) / 1000.0
    speed = step / np.maximum(dt, 1e-3)
    travel = np.array([disp[-1, 0], disp[-1, 1], float(step.sum()), float(np.nanpercentile(speed, 95)),
                       float(np.abs(disp[:, 0]).max()), float(np.abs(disp[:, 1]).max()), (t[-1] - t[0]) / 1000.0])
    return np.concatenate([summary, travel * 3.0])  # travel up-weighted: it separates court movements


def load_captures(task: str, audit: Optional[dict] = None) -> List[dict]:
    """[{movement_id, name, view, descriptor}] for every capture with a usable pose stream."""
    ds = json.loads((DATA / f"dataset_{task}.json").read_text(encoding="utf-8"))
    streams = {v["view_stream_id"]: v for v in ds["view_streams"]}
    cams = {c["camera_id"]: c for c in ds["cameras"]}
    out = []
    counts = Counter()
    excluded = []
    for e in ds["executions"]:
        v = streams[e["view_stream_ids"][0]]
        view = cams[v["camera_id"]]["view"]
        p = DATA / v["pose_path"]
        if not p.exists():
            excluded.append({'execution_id': e['execution_id'], 'movement_id': e['movement_id'], 'reason': 'missing_pose_stream'})
            continue
        frames = read_pose(p)
        segments = usable_segments(frames, counts)
        # A clip-wide descriptor must not combine motions from separate identities or disconnected segments.
        usable = max(segments, key=len, default=[])
        desc = static_descriptor(usable) if task == "static_pose" else dynamic_descriptor(usable)
        if desc is None:
            excluded.append({'execution_id': e['execution_id'], 'movement_id': e['movement_id'], 'reason': 'no_identity_safe_segment_with_sufficient_observation'})
            continue
        counts['frames_in_descriptors'] += len(usable)
        out.append({"movement_id": e["movement_id"], "name": e.get("source_movement_name"), "view": view, "descriptor": desc, "execution_id": e["execution_id"]})
    if audit is not None:
        audit.update({'dataset_version': ds['dataset_version'], 'executions': len(ds['executions']), 'usable_captures': len(out),
                      'athletes': len(ds['athletes']), 'split_counts': ds['splits'].get('counts', {}), 'frame_counts': dict(counts),
                      'excluded_captures': excluded, 'descriptor_policy': 'identity_only + tracker_root_v1; longest safe contiguous segment; >=60% observed channels'})
    return out


def class_distances(caps: List[dict]) -> Tuple[List[str], np.ndarray, Dict[str, Dict[str, int]]]:
    """Mean over shared views of mean same-view capture distance (z-scored per view). NaN when no shared view."""
    by_view: Dict[str, List[dict]] = defaultdict(list)
    for c in caps:
        by_view[c["view"]].append(c)
    labels = sorted({c["movement_id"] for c in caps})
    ix = {l: i for i, l in enumerate(labels)}
    n = len(labels)
    acc = np.zeros((n, n)); cnt = np.zeros((n, n))
    coverage: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for view, items in by_view.items():
        if len(items) < 4:
            continue
        M = np.stack([c["descriptor"] for c in items])
        mu = np.nanmean(M, 0); sd = np.nanstd(M, 0)
        sd[~np.isfinite(sd) | (sd < 1e-9)] = 1.0
        Z = (M - mu) / sd
        # Missing channels do not imply that two poses agree. Require enough jointly observed evidence.
        D = np.full((len(Z), len(Z)), np.nan)
        for a in range(len(Z)):
            common = np.isfinite(Z[a]) & np.isfinite(Z)
            support = common.sum(axis=1)
            difference = np.where(common, Z[a] - Z, 0.0)
            valid = support >= max(1, int(np.ceil(Z.shape[1] * 0.6)))
            D[a, valid] = np.sqrt((difference[valid] ** 2).sum(axis=1) / support[valid])
        per = defaultdict(list)
        for a, ca in enumerate(items):
            coverage[ca["movement_id"]][view] += 1
            for b, cb in enumerate(items):
                if a < b and np.isfinite(D[a, b]):
                    per[tuple(sorted((ca["movement_id"], cb["movement_id"])))].append(D[a, b])
        for (la, lb), ds in per.items():
            i, j = ix[la], ix[lb]
            m = float(np.mean(ds))
            acc[i, j] += m; cnt[i, j] += 1
            if i != j:
                acc[j, i] += m; cnt[j, i] += 1
    with np.errstate(invalid="ignore"):
        Dm = acc / cnt
    np.fill_diagonal(Dm, 0.0)
    return labels, Dm, {k: dict(v) for k, v in coverage.items()}
