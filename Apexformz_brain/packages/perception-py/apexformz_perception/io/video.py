"""OpenCV video reader yielding (frame_id, timestamp_ms, frame_bgr) with capture-derived timestamps."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Optional, Tuple

import cv2
import numpy as np


@dataclass
class VideoInfo:
    path: str
    width: int
    height: int
    fps: float
    frame_count: int


def _open_capture(path: str, honor_orientation: bool):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(f"cannot open video {path}")
    if not honor_orientation and not cap.set(cv2.CAP_PROP_ORIENTATION_AUTO, 0):
        cap.release()
        raise ValueError("Video backend cannot disable container orientation metadata")
    return cap


def probe(path: str, honor_orientation: bool = True) -> VideoInfo:
    cap = _open_capture(path, honor_orientation)
    info = VideoInfo(path, int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                     float(cap.get(cv2.CAP_PROP_FPS) or 0.0), int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    cap.release()
    return info


def read_frames(path: str, max_frames: Optional[int] = None, stride: int = 1, max_side: Optional[int] = None,
                start_frame: int = 0, honor_orientation: bool = True) -> Iterator[Tuple[int, float, np.ndarray]]:
    """Yield frames. Timestamps come from CAP_PROP_POS_MSEC when the container provides them,
    otherwise frame_index / fps. Timestamps are forced monotonic (duplicates nudged by 1 ms)."""
    cap = _open_capture(path, honor_orientation)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    idx = -1
    emitted = 0
    last_ts = -1.0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            idx += 1
            if idx < start_frame or (idx - start_frame) % stride:
                continue
            pos = cap.get(cv2.CAP_PROP_POS_MSEC)
            ts = float(pos) if pos and pos > 0 else idx * 1000.0 / fps
            if ts <= last_ts:
                ts = last_ts + 1.0
            last_ts = ts
            if max_side:
                h, w = frame.shape[:2]
                s = max_side / max(h, w)
                if s < 1.0:
                    frame = cv2.resize(frame, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
            yield idx, ts, frame
            emitted += 1
            if max_frames is not None and emitted >= max_frames:
                break
    finally:
        cap.release()
