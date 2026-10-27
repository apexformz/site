"""ByteTrack-style multi-person tracker (clean re-implementation, MIT-licensed design
after Zhang et al. 2022) plus the single-athlete selection policy.

State per track: Kalman filter over [cx, cy, aspect, h, vcx, vcy, va, vh].
Association: stage 1 matches high-score detections to active tracks by IoU,
stage 2 matches remaining tracks to low-score detections (recovering occluded
people, filtering background), unmatched tracks live `track_buffer` frames.
No appearance features, no sport knowledge.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np


def iou_matrix(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU between boxes a (N,4) and b (M,4) in x0,y0,x1,y1."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    ax0, ay0, ax1, ay1 = [a[:, i][:, None] for i in range(4)]
    bx0, by0, bx1, by1 = [b[:, i][None, :] for i in range(4)]
    iw = np.clip(np.minimum(ax1, bx1) - np.maximum(ax0, bx0), 0, None)
    ih = np.clip(np.minimum(ay1, by1) - np.maximum(ay0, by0), 0, None)
    inter = iw * ih
    area_a = np.clip(ax1 - ax0, 0, None) * np.clip(ay1 - ay0, 0, None)
    area_b = np.clip(bx1 - bx0, 0, None) * np.clip(by1 - by0, 0, None)
    return inter / np.clip(area_a + area_b - inter, 1e-9, None)


def greedy_assign(cost: np.ndarray, thresh: float) -> Tuple[List[Tuple[int, int]], List[int], List[int]]:
    """Greedy minimum-cost assignment (adequate for a handful of people). cost = 1 - IoU."""
    if cost.size == 0:
        return [], list(range(cost.shape[0])), list(range(cost.shape[1]))
    matches: List[Tuple[int, int]] = []
    used_r, used_c = set(), set()
    order = np.dstack(np.unravel_index(np.argsort(cost, axis=None), cost.shape))[0]
    for r, c in order:
        if r in used_r or c in used_c:
            continue
        if cost[r, c] > thresh:
            break
        matches.append((int(r), int(c)))
        used_r.add(int(r))
        used_c.add(int(c))
    un_r = [r for r in range(cost.shape[0]) if r not in used_r]
    un_c = [c for c in range(cost.shape[1]) if c not in used_c]
    return matches, un_r, un_c


class KalmanBox:
    """Constant-velocity Kalman filter on [cx, cy, a, h] (a = aspect ratio w/h)."""

    def __init__(self, bbox: np.ndarray):
        self.ndim = 4
        self.x = np.zeros(8)
        self.x[:4] = self.measure(bbox)
        self.P = np.eye(8)
        self.P[4:, 4:] *= 1000.0
        self.P *= 10.0
        self.F = np.eye(8)
        for i in range(4):
            self.F[i, i + 4] = 1.0
        self.H = np.eye(4, 8)
        self.Q = np.eye(8) * 1e-2
        self.Q[4:, 4:] *= 1e-2
        self.R = np.eye(4) * 1e-2

    @staticmethod
    def measure(bbox: np.ndarray) -> np.ndarray:
        x0, y0, x1, y1 = bbox
        w, h = max(x1 - x0, 1e-6), max(y1 - y0, 1e-6)
        return np.array([(x0 + x1) / 2, (y0 + y1) / 2, w / h, h])

    def predict(self) -> None:
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q

    def update(self, bbox: np.ndarray) -> None:
        z = self.measure(bbox)
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(8) - K @ self.H) @ self.P

    def bbox(self) -> np.ndarray:
        cx, cy, a, h = self.x[:4]
        h = max(h, 1e-6)
        w = max(a * h, 1e-6)
        return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2])


@dataclass
class Track:
    track_id: int
    kf: KalmanBox
    score: float
    age: int = 0
    hits: int = 1
    time_since_update: int = 0
    state: str = "tracked"  # tracked | lost | removed
    payload_index: Optional[int] = None  # index into the detections of the current frame

    def bbox(self) -> np.ndarray:
        return self.kf.bbox()


@dataclass
class Detection:
    bbox: np.ndarray  # normalized x0,y0,x1,y1
    score: float
    index: int


class ByteTracker:
    """Frame-by-frame tracker. Call `update(detections)` once per frame."""

    def __init__(self, track_thresh: float = 0.5, match_thresh: float = 0.8, track_buffer: int = 30, low_thresh: float = 0.1, min_hits: int = 1):
        self.track_thresh = track_thresh
        self.match_thresh = match_thresh
        self.track_buffer = track_buffer
        self.low_thresh = low_thresh
        self.min_hits = min_hits
        self.tracks: List[Track] = []
        self._next_id = 1
        self.frame_count = 0

    def _new_track(self, det: Detection) -> Track:
        t = Track(track_id=self._next_id, kf=KalmanBox(det.bbox), score=det.score, payload_index=det.index)
        self._next_id += 1
        return t

    def update(self, detections: Sequence[Tuple[np.ndarray, float]]) -> List[Track]:
        """detections: list of (bbox_xyxy_normalized, score). Returns active (tracked) tracks."""
        self.frame_count += 1
        dets = [Detection(np.asarray(b, dtype=np.float64), float(s), i) for i, (b, s) in enumerate(detections)]
        high = [d for d in dets if d.score >= self.track_thresh]
        low = [d for d in dets if self.low_thresh <= d.score < self.track_thresh]
        for t in self.tracks:
            t.kf.predict()
            t.age += 1
            t.time_since_update += 1
            t.payload_index = None

        active = [t for t in self.tracks if t.state in ("tracked", "lost")]
        # Stage 1: high-score detections vs all live tracks.
        cost = 1.0 - iou_matrix(np.array([t.bbox() for t in active]) if active else np.zeros((0, 4)), np.array([d.bbox for d in high]) if high else np.zeros((0, 4)))
        matches, un_tracks, un_high = greedy_assign(cost, 1.0 - (1.0 - self.match_thresh) if cost.size else 0.0) if cost.size else ([], list(range(len(active))), list(range(len(high))))
        for ti, di in matches:
            self._hit(active[ti], high[di])
        # Stage 2: remaining tracked (not lost) tracks vs low-score detections.
        remaining = [active[i] for i in un_tracks if active[i].state == "tracked"]
        cost2 = 1.0 - iou_matrix(np.array([t.bbox() for t in remaining]) if remaining else np.zeros((0, 4)), np.array([d.bbox for d in low]) if low else np.zeros((0, 4)))
        matches2, un_tracks2, _ = greedy_assign(cost2, 0.5) if cost2.size else ([], list(range(len(remaining))), [])
        for ti, di in matches2:
            self._hit(remaining[ti], low[di])
        for i in un_tracks2:
            remaining[i].state = "lost"
        for i in un_tracks:
            t = active[i]
            if t.state == "lost" and t.time_since_update > self.track_buffer:
                t.state = "removed"
        # New tracks from unmatched high-score detections.
        for di in un_high:
            self.tracks.append(self._new_track(high[di]))
        self.tracks = [t for t in self.tracks if t.state != "removed"]
        return [t for t in self.tracks if t.state == "tracked" and t.hits >= self.min_hits]

    def _hit(self, track: Track, det: Detection) -> None:
        track.kf.update(det.bbox)
        track.score = det.score
        track.hits += 1
        track.time_since_update = 0
        track.state = "tracked"
        track.payload_index = det.index


@dataclass
class SubjectSelection:
    index: Optional[int]
    track_id: Optional[str]
    ambiguous: bool
    track_changed: bool
    person_count: int


class SubjectSelector:
    """Single-athlete policy on top of ByteTracker (mirrors packages/perception/src/subject_tracker.ts).

    Keeps following the chosen track; flags ambiguity when another person of
    comparable size overlaps or sits close to the subject; declares a track change
    when the followed track is gone and a new one must be adopted.
    """

    def __init__(self, tracker: Optional[ByteTracker] = None, competing_area_ratio: float = 0.6, proximity: float = 0.35,
                 subject_roi: Optional[Tuple[float, float, float, float]] = None):
        self.tracker = tracker or ByteTracker()
        self.competing_area_ratio = competing_area_ratio
        self.proximity = proximity
        self.subject_track_id: Optional[int] = None
        self._adoptions = 0
        if subject_roi is not None:
            if len(subject_roi) != 4 or not np.isfinite(subject_roi).all() or any(v < 0 or v > 1 for v in subject_roi) or subject_roi[0] >= subject_roi[2] or subject_roi[1] >= subject_roi[3]:
                raise ValueError("subject_roi must be an ordered normalized region (x0,y0,x1,y1)")
        self.subject_roi = tuple(subject_roi) if subject_roi is not None else None
        self._frame = self._last_seen = 0

    def reset(self) -> None:
        self.tracker = ByteTracker(self.tracker.track_thresh, self.tracker.match_thresh, self.tracker.track_buffer)
        self.subject_track_id = None
        self._frame = self._last_seen = 0

    @staticmethod
    def _area(b: np.ndarray) -> float:
        return float(max(b[2] - b[0], 0) * max(b[3] - b[1], 0))

    def select(self, detections: Sequence[Tuple[np.ndarray, float]]) -> SubjectSelection:
        n = len(detections)
        self._frame += 1
        eligible = []
        for index, (box, score) in enumerate(detections):
            if not np.isfinite(box).all() or self._area(box) <= 0:
                continue
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            roi = self.subject_roi
            if roi is None or (roi[0] <= cx <= roi[2] and roi[1] <= cy <= roi[3]):
                eligible.append(index)
        active = self.tracker.update([detections[i] for i in eligible])
        if not active:
            return SubjectSelection(None, f"track-{self.subject_track_id}" if self.subject_track_id else None, False, False, n)
        by_id = {t.track_id: t for t in active}
        changed = False
        if self.subject_track_id is None or self.subject_track_id not in by_id:
            if self.subject_track_id is not None and self._frame - self._last_seen <= self.tracker.track_buffer:
                return SubjectSelection(None, f"track-{self.subject_track_id}", False, False, n)
            # (Re)adopt: the largest person. A re-adoption after loss is a track change.
            largest = max(active, key=lambda t: self._area(t.bbox()))
            if any(i != largest.payload_index and self._area(detections[original][0]) >= self.competing_area_ratio * self._area(largest.bbox())
                   for i, original in enumerate(eligible)):
                return SubjectSelection(None, f"track-{self.subject_track_id}" if self.subject_track_id else None, True, False, n)
            changed = self.subject_track_id is not None and self.subject_track_id != largest.track_id
            self.subject_track_id = largest.track_id
            self._adoptions += 1
        subj = by_id[self.subject_track_id]
        self._last_seen = self._frame
        sb = subj.bbox()
        sa = self._area(sb)
        scx, scy = (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2
        ambiguous = False
        for index, original in enumerate(eligible):
            if index == subj.payload_index:
                continue
            b = detections[original][0]
            if self._area(b) >= self.competing_area_ratio * sa:
                cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                overlap = iou_matrix(sb[None, :], b[None, :])[0, 0]
                if overlap > 0.05 or np.hypot(cx - scx, cy - scy) < self.proximity:
                    ambiguous = True
                    break
        return SubjectSelection(None if ambiguous else eligible[subj.payload_index], f"track-{subj.track_id}", ambiguous, changed, n)
