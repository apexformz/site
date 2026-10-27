"""PoseFrame JSONL dataset for training the Brain recognizers (TRD 10/12).

Input: one PoseFrame JSON object per line (contract packages/contracts/schemas/pose_frame.schema.json,
validated with the apexformz_contracts Pydantic model). Processing mirrors the edge
runtime so train and deploy share one sampling contract:
  * mirror canonicalisation exactly once (x -> 1 - x, left/right ids swapped) when mirror=True,
  * landmark validity = visibility (or presence) >= min_visibility,
  * body-relative normalisation: hip-midpoint origin, torso-length scale, aspect corrected
    (packages/signal/src/coordinates.ts),
  * fixed-rate resampling with hold-last-sample semantics and explicit masks
    (packages/signal/src/pose_window.ts::resample): no interpolation across gaps, padded
    samples carry an all-zero mask,
  * sliding windows; labels from a JSONL/JSON label file {sequence_id, movement_id, start_ms, end_ms};
    windows without a covering label (>= label_coverage of their span) are UNKNOWN.
"""
from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

try:  # torch is optional for the pure-numpy helpers
    import torch
    from torch.utils.data import Dataset
except ImportError:  # pragma: no cover
    torch = None  # type: ignore

    class Dataset:  # type: ignore
        pass

try:
    from apexformz_contracts import PoseFrame
except ImportError:  # pragma: no cover
    PoseFrame = None  # type: ignore

MIRROR_PAIRS_33 = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
MIRROR_PAIRS_17 = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16)]
TORSO = {"mediapipe_pose_33": (11, 12, 23, 24), "coco_17": (5, 6, 11, 12)}  # left_shoulder, right_shoulder, left_hip, right_hip
NUM_LANDMARKS = {"mediapipe_pose_33": 33, "coco_17": 17}


@dataclass
class NormalizedFrame:
    timestamp_ms: float
    body: np.ndarray  # [V, 3]
    valid: np.ndarray  # [V] bool
    normalization_valid: bool
    continuity_break: bool = False


def canonicalize(landmarks: np.ndarray, valid: np.ndarray, mirror: bool, landmark_set: str) -> Tuple[np.ndarray, np.ndarray]:
    if not mirror:
        return landmarks, valid
    lm = landmarks.copy()
    vd = valid.copy()
    lm[:, 0] = 1.0 - lm[:, 0]
    for l, r in (MIRROR_PAIRS_33 if landmark_set == "mediapipe_pose_33" else MIRROR_PAIRS_17):
        lm[[l, r]] = lm[[r, l]]
        vd[[l, r]] = vd[[r, l]]
    return lm, vd


NORMALIZATIONS = ("body_relative_v1", "world_bodyframe_v1")


def normalize_world_bodyframe(world: np.ndarray, valid: np.ndarray, landmark_set: str) -> Tuple[np.ndarray, np.ndarray, bool]:
    """3D world landmarks [V,3] (metres, model-estimated) -> camera-independent body frame.

    Origin at the hip centre; rotated about the vertical (y) axis so the right-hip -> left-hip vector points along
    +x, which removes the camera's yaw (front, back, side views map to the same frame); scaled by 3D torso length.
    The left/right identity of landmarks is preserved (no mirroring). Invalid root or scale => all invalid.
    Must match packages/brain-client/src/movement_detector.ts (normalization 'world_bodyframe_v1').
    """
    ls, rs, lh, rh = TORSO[landmark_set]
    if not (valid[ls] and valid[rs] and valid[lh] and valid[rh]):
        return np.zeros_like(world), np.zeros_like(valid, dtype=bool), False
    hp = (world[lh] + world[rh]) / 2
    sh = (world[ls] + world[rs]) / 2
    scale = float(np.linalg.norm(sh - hp))
    hv = world[lh] - world[rh]
    yaw = float(np.arctan2(hv[2], hv[0]))
    if not np.isfinite(scale) or scale < 1e-6 or not np.isfinite(yaw):
        return np.zeros_like(world), np.zeros_like(valid, dtype=bool), False
    c, s = np.cos(yaw), np.sin(yaw)
    rel = world - hp
    body = np.zeros_like(world)
    # rotate by -yaw about y: x' = c*x + s*z, z' = -s*x + c*z
    body[:, 0] = (c * rel[:, 0] + s * rel[:, 2]) / scale
    body[:, 1] = rel[:, 1] / scale
    body[:, 2] = (-s * rel[:, 0] + c * rel[:, 2]) / scale
    body[~valid] = 0.0
    return body, valid, True


def normalize_body_relative(landmarks: np.ndarray, valid: np.ndarray, image_size: Sequence[int], landmark_set: str) -> Tuple[np.ndarray, np.ndarray, bool]:
    """landmarks [V,3] image_normalized -> body_relative [V,3]; invalid root/scale => all invalid."""
    W, H = float(image_size[0]), float(image_size[1])
    ls, rs, lh, rh = TORSO[landmark_set]
    if not (valid[ls] and valid[rs] and valid[lh] and valid[rh]):
        return np.zeros_like(landmarks), np.zeros_like(valid, dtype=bool), False
    sh = (landmarks[ls] + landmarks[rs]) / 2
    hp = (landmarks[lh] + landmarks[rh]) / 2
    scale = float(np.hypot((sh[0] - hp[0]) * W, (sh[1] - hp[1]) * H))
    if not np.isfinite(scale) or scale < 1e-9:
        return np.zeros_like(landmarks), np.zeros_like(valid, dtype=bool), False
    body = np.zeros_like(landmarks)
    body[:, 0] = (landmarks[:, 0] - hp[0]) * W / scale
    body[:, 1] = (landmarks[:, 1] - hp[1]) * H / scale
    body[:, 2] = (landmarks[:, 2] - hp[2]) * W / scale
    body[~valid] = 0.0
    return body, valid, True


FRAME_GATES = ("strict", "identity_only")


def frame_from_json(obj: dict, landmark_set: str = "mediapipe_pose_33", min_visibility: float = 0.5, validate: bool = True, frame_gate: str = "strict",
                    normalization: str = "body_relative_v1") -> NormalizedFrame:
    """frame_gate='strict' blanks the whole frame on any framing/missing-joint flag (original behaviour).
    frame_gate='identity_only' blanks it only when the subject's identity is unsafe (second person, track change);
    missing or out-of-frame joints stay masked per landmark, and an unrecoverable body root still invalidates
    normalisation. Training and browser inference must use the same gate (recorded in the deployment input)."""
    if frame_gate not in FRAME_GATES:
        raise ValueError(f"unknown frame_gate {frame_gate}")
    if validate and PoseFrame is not None:
        PoseFrame.model_validate(obj)
    if obj.get("landmark_set", landmark_set) != landmark_set:
        raise ValueError(f"expected {landmark_set} landmarks, got {obj.get('landmark_set')}; convert explicitly before training")
    V = NUM_LANDMARKS[landmark_set]
    lm = np.zeros((V, 3), dtype=np.float32)
    valid = np.zeros(V, dtype=bool)
    for p in obj.get("normalized_landmarks", []):
        i = int(p["id"])
        if i >= V:
            continue
        lm[i] = (p["x"], p["y"], p.get("z", 0.0) or 0.0)
        vis = p.get("visibility", p.get("presence", 1.0))
        valid[i] = bool(np.isfinite(lm[i]).all() and (vis if vis is not None else 1.0) >= min_visibility)
    lm, valid = canonicalize(lm, valid, bool(obj.get("mirror", False)), landmark_set)
    quality = obj.get("quality", {})
    identity_unsafe = bool(quality.get("ambiguous_people", False) or quality.get("track_changed", False))
    quality_blocked = identity_unsafe if frame_gate == "identity_only" else (
        identity_unsafe or quality.get("framing_ok") is False or bool(quality.get("missing_joints", [])))
    if quality_blocked:
        valid[:] = False
    if normalization == "world_bodyframe_v1":
        wl = np.zeros((V, 3), dtype=np.float32)
        have = np.zeros(V, dtype=bool)
        for p in obj.get("world_landmarks") or []:
            i = int(p["id"])
            if i < V:
                wl[i] = (p["x"], p["y"], p.get("z", 0.0) or 0.0)
                have[i] = bool(np.isfinite(wl[i]).all())
        if bool(obj.get("mirror", False)):
            # `valid` was already canonicalised (left/right swapped) above; mirror the world geometry the same way
            wl[:, 0] = -wl[:, 0]
            for l, r in (MIRROR_PAIRS_33 if landmark_set == "mediapipe_pose_33" else MIRROR_PAIRS_17):
                wl[[l, r]] = wl[[r, l]]
                have[[l, r]] = have[[r, l]]
        # visibility (from the image landmarks) decides validity; world coordinates supply the geometry
        body, valid, ok = normalize_world_bodyframe(wl, valid & have, landmark_set)
    elif normalization == "body_relative_v1":
        body, valid, ok = normalize_body_relative(lm, valid, obj["image_size"], landmark_set)
    else:
        raise ValueError(f"unknown normalization {normalization}")
    return NormalizedFrame(float(obj["timestamp_ms"]), body, valid, ok,
                           bool(quality.get("track_changed") or quality.get("ambiguous_people")))


SUBJECT_CONTINUITY = ("tracker", "tracker_root_v1", "geometric")


def _root(obj: dict, min_visibility: float) -> Optional[Tuple[np.ndarray, float]]:
    """Aspect-corrected hip centre and torso length of a frame, or None when the torso is not visible."""
    w, h = obj["image_size"]
    pts = {}
    for p in obj.get("normalized_landmarks", []):
        vis = p.get("visibility", p.get("presence", 1.0))
        if (vis if vis is not None else 1.0) >= min_visibility and np.isfinite([p["x"], p["y"]]).all():
            pts[int(p["id"])] = np.array([p["x"] * w / h, p["y"]], dtype=float)
    if not all(i in pts for i in (11, 12, 23, 24)):
        return None
    hip = (pts[23] + pts[24]) / 2
    torso = float(np.linalg.norm((pts[11] + pts[12]) / 2 - hip))
    return (hip, torso) if torso > 1e-6 else None


def read_jsonl(path: Path, landmark_set: str, min_visibility: float = 0.5, max_gap_ms: float = 400.0, frame_gate: str = "strict",
               subject_continuity: str = "tracker", max_root_speed: float = 12.0, max_root_jump: float = 0.75,
               normalization: str = "body_relative_v1") -> List[NormalizedFrame]:
    """Read frames in file order; enforce monotonic time (drop regressions/duplicates).

    subject_continuity='tracker' (default) trusts tracked_subject_id: an id change breaks continuity.
    subject_continuity='tracker_root_v1' preserves every tracker/ambiguity boundary and also masks abrupt
    same-track hip jumps (>0.75 torso lengths + 12 torso lengths/s). Matches the browser detector.
    subject_continuity='geometric' is legacy research-only and LIVE-INCOMPATIBLE: tracker id churn and
    ambiguity flags (glass-wall reflections, bystanders) are ignored, and the athlete is followed by body
    position instead. A frame whose hip centre jumps further than max_root_jump torso lengths plus
    max_root_speed torso lengths/s x elapsed time from the last accepted frame is treated as the wrong person
    and masked. Never used for live inference, which keeps its reset-on-track-change behaviour.
    """
    if subject_continuity not in SUBJECT_CONTINUITY:
        raise ValueError(f"unknown subject_continuity {subject_continuity}")
    geometric = subject_continuity == "geometric"
    safe_root = subject_continuity == "tracker_root_v1"
    if safe_root and (max_root_speed != 12.0 or max_root_jump != 0.75):
        raise ValueError("tracker_root_v1 requires its versioned root-jump limits (0.75 + 12/s)")
    frames: List[NormalizedFrame] = []
    last = -np.inf
    last_subject = last_camera = None
    anchor: Optional[Tuple[np.ndarray, float, float]] = None  # (hip, torso, timestamp) of the last accepted frame
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if "_header" in obj:
                continue
            if geometric:
                q = dict(obj.get("quality", {}))
                q["ambiguous_people"] = False
                q["track_changed"] = False
                obj = {**obj, "quality": q}
            f = frame_from_json(obj, landmark_set, min_visibility, frame_gate=frame_gate, normalization=normalization)
            if f.timestamp_ms <= last:
                continue
            subject, camera = obj.get("tracked_subject_id"), obj.get("camera_id")
            if geometric:
                r = _root(obj, min_visibility)
                if r is not None and anchor is not None:
                    dt = max(0.0, (f.timestamp_ms - anchor[2]) / 1000.0)
                    if np.linalg.norm(r[0] - anchor[0]) / max(anchor[1], 1e-6) > max_root_jump + max_root_speed * dt:
                        f.valid[:] = False
                        f.normalization_valid = False
                        r = None  # wrong person: do not move the anchor
                if r is not None:
                    anchor = (r[0], r[1], f.timestamp_ms)
                f.continuity_break = bool(frames) and (f.timestamp_ms - last > max_gap_ms or camera != last_camera)
            else:
                f.continuity_break |= bool(frames) and (f.timestamp_ms - last > max_gap_ms
                    or subject != last_subject or camera != last_camera)
                if safe_root:
                    if f.continuity_break:
                        anchor = None
                    # Never infer identity from geometry when the source tracker says it is unsafe.
                    r = _root(obj, min_visibility) if f.normalization_valid else None
                    if r is None and f.normalization_valid:
                        f.body[:] = 0
                        f.valid[:] = False
                        f.normalization_valid = False
                    if r is not None and anchor is not None:
                        dt = max(0.0, (f.timestamp_ms - anchor[2]) / 1000.0)
                        if np.linalg.norm(r[0] - anchor[0]) / anchor[1] > 0.75 + 12.0 * dt:
                            f.body[:] = 0
                            f.valid[:] = False
                            f.normalization_valid = False
                            f.continuity_break = True
                            r = None  # retain last accepted anchor; never follow the rejected subject
                    if r is not None:
                        anchor = (r[0], r[1], f.timestamp_ms)
            last = f.timestamp_ms
            last_subject, last_camera = subject, camera
            frames.append(f)
    return frames


def resample(frames: List[NormalizedFrame], hz: float, max_hold_ms: float = 100.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fixed-rate resampling with hold-last-sample and explicit masks (pose_window.ts::resample).
    Returns timestamps [T], x [T, V*3], mask [T, V]."""
    if not frames:
        return np.zeros(0), np.zeros((0, 0)), np.zeros((0, 0))
    V = frames[0].body.shape[0]
    step = 1000.0 / hz
    t0, t1 = frames[0].timestamp_ms, frames[-1].timestamp_ms
    n = max(1, int(np.floor((t1 - t0) / step)) + 1)
    ts = t0 + np.arange(n) * step
    x = np.zeros((n, V, 3), dtype=np.float32)
    mask = np.zeros((n, V), dtype=np.float32)
    idx = 0
    for k, t in enumerate(ts):
        while idx + 1 < len(frames) and frames[idx + 1].timestamp_ms <= t + 1e-6:
            idx += 1
        f = frames[idx]
        usable = f.timestamp_ms <= t + 1e-6 and (t - f.timestamp_ms) <= max_hold_ms and f.normalization_valid
        if not usable:
            continue  # padded: zeros + zero mask
        x[k] = f.body
        mask[k] = f.valid.astype(np.float32)
    return ts, x.reshape(n, V * 3), mask


def window_indices(n: int, window: int, stride: int) -> List[Tuple[int, int]]:
    if n < window:
        return [(0, n)] if n > 0 else []
    return [(s, s + window) for s in range(0, n - window + 1, stride)]


def label_for_window(ts: np.ndarray, labels: Iterable[dict], classes: List[str], coverage: float = 0.6) -> int:
    """Class index of the label covering >= `coverage` of the window span, else UNKNOWN."""
    unknown = classes.index("UNKNOWN")
    if len(ts) == 0:
        return unknown
    w0, w1 = float(ts[0]), float(ts[-1]) + 1e-6
    best, best_cov = unknown, 0.0
    for lab in labels:
        if lab["movement_id"] not in classes:
            continue
        overlap = max(0.0, min(w1, float(lab["end_ms"])) - max(w0, float(lab["start_ms"])))
        cov = overlap / max(w1 - w0, 1e-6)
        if cov > best_cov:
            best_cov, best = cov, classes.index(lab["movement_id"])
    return best if best_cov >= coverage else unknown


def load_labels(path: Optional[str | Path]) -> Dict[str, List[dict]]:
    if not path:
        return {}
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    items = json.loads(text) if text.lstrip().startswith("[") else [json.loads(l) for l in text.splitlines() if l.strip()]
    out: Dict[str, List[dict]] = {}
    for it in items:
        sid = it.get("sequence_id") or it.get("stream_id") or it.get("view_stream_id")
        if not sid:
            raise ValueError("each label requires sequence_id, stream_id or view_stream_id")
        out.setdefault(sid, []).append(it)
    return out


def split_evidence(manifest: dict, assignments: Optional[dict]) -> dict:
    """Check supplied identities without turning unknown athletes into held-out evidence."""
    from .split import check_no_leakage

    executions = manifest.get("executions", [])
    if not assignments or not executions:
        return {"athlete_disjoint": None, "problems": [], "reason": "execution/athlete split lineage unavailable"}
    known = all(e.get("athlete_id") and not str(e["athlete_id"]).lower().startswith("unknown") for e in executions)
    all_problems = check_no_leakage([{**e, "athlete_id": e.get("athlete_id") or "unknown"} for e in executions], assignments)
    # Missing identity is not evidence of disjointness, but stream leakage is
    # detectable independently and must still be rejected.
    problems = all_problems if known else [p for p in all_problems if not p.startswith("athlete ")]
    session_splits = {}
    for ex in executions:
        if ex.get("capture_session_id"):
            session_splits.setdefault(ex["capture_session_id"], set()).add(assignments.get(ex["execution_id"]))
    problems.extend(f"capture session {sid} appears in {sorted(str(v) for v in values)}"
                    for sid, values in session_splits.items() if len(values) > 1)
    athletes = {e.get("athlete_id") for e in executions} if known else set()
    partitions = sorted({assignments.get(e["execution_id"]) for e in executions}
                        & {"train", "val", "test"})
    has_holdout = len(partitions) >= 2
    reason = ("no independent holdout: fewer than two nonempty assigned partitions" if not has_holdout
              else None if known else "athlete identities unverified")
    return {"athlete_disjoint": not problems if known and has_holdout else None, "problems": problems,
            "athletes": len(athletes), "partitions": partitions, "reason": reason}


class PoseJsonlDataset(Dataset):
    """Windows of resampled, body-relative PoseFrames with masks and class labels."""

    def __init__(self, sequences: Dict[str, Path], labels: Dict[str, List[dict]], classes: List[str], window_frames: int = 45, stride: int = 15, hz: float = 15.0,
                 landmark_set: str = "mediapipe_pose_33", max_hold_ms: float = 100.0, min_visibility: float = 0.5, label_coverage: float = 0.6,
                 sequence_metadata: Optional[Dict[str, dict]] = None, time_ranges: Optional[Dict[str, Tuple[float, float]]] = None,
                 min_observed_fraction: float = 0.6, excluded_classes: Optional[List[str]] = None, frame_gate: str = "strict",
                 subject_continuity: str = "tracker", normalization: str = "body_relative_v1"):
        assert classes and classes[-1] == "UNKNOWN"
        self.classes = list(classes)
        self.excluded_classes = list(excluded_classes or [])
        if set(self.excluded_classes) & set(classes):
            raise ValueError("excluded classes must not appear in model classes")
        label_classes = self.classes[:-1] + self.excluded_classes + ["UNKNOWN"]
        self.landmark_set = landmark_set
        self.frame_gate = frame_gate
        self.items: List[Tuple[np.ndarray, np.ndarray, int, str]] = []
        self.metadata: List[dict] = []
        self.split_evidence = {"athlete_disjoint": None, "problems": []}
        self.skipped_empty: List[str] = []
        self.rejected_windows: Dict[str, int] = {"empty": 0, "current_frame_unusable": 0,
                                                "below_min_observed_fraction": 0, "excluded_class": 0}
        self.rejected_by_sequence: Dict[str, int] = {}
        if window_frames < 1 or stride < 1 or hz <= 0:
            raise ValueError("window_frames, stride and hz must be positive")
        if not np.isfinite(min_observed_fraction) or not 0 <= min_observed_fraction <= 1:
            raise ValueError("min_observed_fraction must be between 0 and 1")
        cache = {}
        for seq_id, path in sequences.items():
            path = Path(path)
            if path not in cache:
                cache[path] = read_jsonl(path, landmark_set, min_visibility, frame_gate=frame_gate, subject_continuity=subject_continuity, normalization=normalization)
            frames = cache[path]
            if time_ranges and seq_id in time_ranges:
                lo, hi = time_ranges[seq_id]
                frames = [f for f in frames if lo <= f.timestamp_ms <= hi]
            if not frames:
                self.skipped_empty.append(seq_id)
                continue
            seq_labels = labels.get(seq_id, [])
            unsupported = {l["movement_id"] for l in seq_labels} - set(label_classes)
            if unsupported:
                raise ValueError(f"unmapped movement labels in {seq_id}: {sorted(unsupported)}")
            segments = []
            for fr in frames:
                if not segments or fr.continuity_break:
                    segments.append([])
                segments[-1].append(fr)
            count_before = len(self.items)
            for segment in segments:
                ts, x, mask = resample(segment, hz, max_hold_ms)
                for s, e in window_indices(len(ts), window_frames, stride):
                    if not mask[s:e].any():
                        self.rejected_windows["empty"] += 1
                        continue
                    if not mask[e - 1].any():
                        self.rejected_windows["current_frame_unusable"] += 1
                        continue
                    xw = np.zeros((window_frames, x.shape[1]), dtype=np.float32)
                    mw = np.zeros((window_frames, mask.shape[1]), dtype=np.float32)
                    # The causal decision is the last frame; short captures are left padded.
                    xw[-(e - s):] = x[s:e]
                    mw[-(e - s):] = mask[s:e]
                    # Same denominator as browser recognition, including zero padding.
                    observed_fraction = float(np.count_nonzero(mw) / mw.size)
                    if observed_fraction < min_observed_fraction:
                        self.rejected_windows["below_min_observed_fraction"] += 1
                        self.rejected_by_sequence[seq_id] = self.rejected_by_sequence.get(seq_id, 0) + 1
                        continue
                    label = label_classes[label_for_window(ts[s:e], seq_labels, label_classes, label_coverage)]
                    if label in self.excluded_classes:
                        self.rejected_windows["excluded_class"] += 1
                        continue
                    y = self.classes.index(label)
                    self.items.append((xw, mw, y, seq_id))
                    self.metadata.append({"sequence_id": seq_id, "start_ms": float(ts[s]), "end_ms": float(ts[e - 1]),
                                          "observed_fraction": observed_fraction,
                                          "view": "unknown", **(sequence_metadata or {}).get(seq_id, {})})
            if len(self.items) == count_before:
                self.skipped_empty.append(seq_id)

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, i: int):
        x, m, y, _ = self.items[i]
        return torch.tensor(x), torch.tensor(m), torch.tensor(y, dtype=torch.long)

    def class_counts(self) -> Dict[str, int]:
        counts = {c: 0 for c in self.classes}
        for _, _, y, _ in self.items:
            counts[self.classes[y]] += 1
        return counts

    @classmethod
    def from_manifest(cls, manifest_path: str | Path, labels_file: Optional[str | Path], classes: List[str], split_manifest: Optional[str | Path] = None, split: str = "train", allow_development_split: bool = False, excluded_classes: Optional[List[str]] = None, ignore_labels: bool = False, **kw) -> "PoseJsonlDataset":
        """Load capture manifests (view_streams[].pose_path + executions) or legacy sequences.

        Execution time bounds are applied before windowing. A long multi-execution stream
        is never loaded wholesale into each split. Original movement labels are retained,
        except for self-supervised callers explicitly setting ignore_labels=True.
        """
        m = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        assign = json.loads(Path(split_manifest).read_text(encoding="utf-8"))["assignments"] if split_manifest else m.get("splits", {}).get("assignments")
        evidence = split_evidence(m, assign)
        if evidence["problems"] and not allow_development_split:
            raise ValueError("split leakage: " + "; ".join(evidence["problems"]))
        if split != "train" and not assign:
            raise ValueError(f"an explicit split manifest is required for {split} evaluation")
        seqs: Dict[str, Path] = {}
        excluded_executions = []
        metadata, ranges, selected_labels = {}, {}, {}
        labels = {} if ignore_labels else load_labels(labels_file)
        root = Path(manifest_path).parent
        def add(sid, path, meta, bounds=None, source_labels=None):
            p = Path(path)
            seqs[sid] = p if p.is_absolute() else root / p
            metadata[sid] = meta
            if bounds is not None:
                ranges[sid] = bounds
            selected_labels[sid] = [] if ignore_labels else source_labels or []

        if "sequences" in m:
            for s in m["sequences"]:
                sid = s["sequence_id"]
                if assign is not None and assign.get(s.get("execution_id", sid)) != split:
                    continue
                bounds = (s["start_ms"], s["end_ms"]) if "start_ms" in s and "end_ms" in s else None
                sl = labels.get(sid, [])
                if not sl and s.get("movement_id") and bounds:
                    sl = [{"movement_id": s["movement_id"], "start_ms": bounds[0], "end_ms": bounds[1]}]
                add(sid, s.get("pose_path") or s["path"], {k: s[k] for k in ("view", "execution_id", "athlete_id", "capture_session_id") if k in s}, bounds, sl)
        else:
            streams = {s["view_stream_id"]: s for s in m.get("view_streams", [])}
            cameras = {c["camera_id"]: c for c in m.get("cameras", [])}
            verified = set()
            for ex in m.get("executions", []):
                eid = ex["execution_id"]
                if assign is not None and assign.get(eid) != split:
                    continue
                if not ignore_labels and ex["movement_id"] in (excluded_classes or []):
                    excluded_executions.append(eid)
                    continue
                for stream_id in ex["view_stream_ids"]:
                    st = streams[stream_id]
                    if not st.get("pose_path"):
                        raise ValueError(f"view stream {stream_id} has no extracted pose_path")
                    if st.get("pose_sha256") and stream_id not in verified:
                        pose_path = Path(st["pose_path"])
                        if not pose_path.is_absolute():
                            pose_path = root / pose_path
                        with pose_path.open("rb") as fh:
                            actual = hashlib.file_digest(fh, "sha256").hexdigest()
                        if actual != st["pose_sha256"]:
                            raise ValueError(f"pose checksum mismatch for stream {stream_id}")
                        verified.add(stream_id)
                    sid = f"{stream_id}::{eid}"
                    bounds = (float(ex["start_ms"]), float(ex["end_ms"]))
                    if bounds[1] < bounds[0]:
                        raise ValueError(f"reversed execution bounds: {eid}")
                    sl = [l for l in labels.get(stream_id, []) if l.get("execution_id", eid) == eid]
                    if not sl and not ignore_labels:
                        sl = [{"movement_id": ex["movement_id"], "start_ms": bounds[0], "end_ms": bounds[1]}]
                    # A single photograph has a zero-length annotated interval.
                    sl = [{**l, "end_ms": max(float(l["end_ms"]), float(l["start_ms"]) + 1e-3)} for l in sl]
                    meta = {"stream_id": stream_id, "execution_id": eid, "athlete_id": ex.get("athlete_id"),
                            "capture_session_id": ex.get("capture_session_id"), "view": cameras.get(st["camera_id"], {}).get("view", st.get("view", "unknown"))}
                    add(sid, st["pose_path"], meta, bounds, sl)
        ds = cls(seqs, selected_labels, classes, sequence_metadata=metadata, time_ranges=ranges,
                 excluded_classes=excluded_classes, **kw)
        ds.split_evidence = evidence
        ds.excluded_executions = excluded_executions
        return ds
