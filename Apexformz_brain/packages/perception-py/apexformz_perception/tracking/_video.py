"""Minimal private video reader for the tracking subpackage (BGR uint8 frames via OpenCV)."""
from __future__ import annotations

from typing import List, Optional, Tuple

import numpy as np


def read_video(path: str, max_frames: Optional[int] = None, stride: int = 1, resize_to: Optional[Tuple[int, int]] = None) -> Tuple[List[np.ndarray], Optional[float]]:
    """Read a video file into BGR frames. ``resize_to`` is (width, height)."""
    import cv2

    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise FileNotFoundError(f"cannot open video {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or None
    frames: List[np.ndarray] = []
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % stride == 0:
            if resize_to is not None:
                frame = cv2.resize(frame, resize_to, interpolation=cv2.INTER_AREA)
            frames.append(frame)
            if max_frames is not None and len(frames) >= max_frames:
                break
        idx += 1
    cap.release()
    if fps is not None and stride > 1:
        fps = fps / stride
    return frames, fps
