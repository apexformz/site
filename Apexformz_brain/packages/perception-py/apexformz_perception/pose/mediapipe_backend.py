"""MediaPipe Tasks PoseLandmarker backend (Apache-2.0).

VIDEO running mode with monotonic timestamps, multi-person via `num_poses`,
GPU delegate attempted first (falls back to CPU; the Python wheel on Windows is
CPU only), model files cached under APEXFORMZ_MODEL_CACHE.
"""
from __future__ import annotations

import logging
import os
import pathlib
import time
import urllib.request
from typing import Any, Dict, List, Optional

import numpy as np

from .base import ModelUnavailable, PersonPose, PoseBackend

log = logging.getLogger("apexformz.perception.mediapipe")

MODEL_URLS = {
    "heavy": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task",
    "full": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
    "lite": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
}


def model_cache_dir() -> pathlib.Path:
    d = pathlib.Path(os.environ.get("APEXFORMZ_MODEL_CACHE", pathlib.Path.home() / ".cache" / "apexformz"))
    d.mkdir(parents=True, exist_ok=True)
    return d


def ensure_model(variant: str = "full", timeout_s: float = 120.0) -> pathlib.Path:
    if variant not in MODEL_URLS:
        raise ValueError(f"unknown PoseLandmarker variant {variant}; choose {sorted(MODEL_URLS)}")
    target = model_cache_dir() / f"pose_landmarker_{variant}.task"
    if target.exists() and target.stat().st_size > 1_000_000:
        return target
    # Reuse the model shipped with the original repo if present (same file for 'heavy').
    legacy = pathlib.Path(__file__).resolve().parents[5] / "Apexformz" / "pose_landmarker.task"
    if variant == "heavy" and legacy.exists():
        return legacy
    tmp = target.with_suffix(".tmp")
    try:
        log.info("downloading PoseLandmarker %s", variant)
        with urllib.request.urlopen(MODEL_URLS[variant], timeout=timeout_s) as r, open(tmp, "wb") as f:
            f.write(r.read())
        tmp.replace(target)
    except Exception as e:  # noqa: BLE001
        if tmp.exists():
            tmp.unlink()
        raise ModelUnavailable(f"could not download PoseLandmarker {variant}: {e}") from e
    return target


class MediaPipePoseBackend(PoseBackend):
    name = "mediapipe_pose_landmarker"
    landmark_set = "mediapipe_pose_33"

    def __init__(self, variant: str = "full", num_poses: int = 2, min_detection_confidence: float = 0.5,
                 min_presence_confidence: float = 0.5, min_tracking_confidence: float = 0.5, prefer_gpu: bool = True):
        try:
            import mediapipe as mp  # noqa: F401
            from mediapipe.tasks.python import BaseOptions, vision
        except ImportError as e:  # pragma: no cover
            raise ModelUnavailable(f"mediapipe is not installed: {e}") from e
        self._mp = __import__("mediapipe")
        self._vision = vision
        self.variant = variant
        self.model_path = ensure_model(variant)
        self.delegate = "CPU"
        self._last_ts = -1
        opts_kwargs = dict(
            running_mode=vision.RunningMode.VIDEO,
            num_poses=num_poses,
            min_pose_detection_confidence=min_detection_confidence,
            min_pose_presence_confidence=min_presence_confidence,
            min_tracking_confidence=min_tracking_confidence,
            output_segmentation_masks=False,
        )
        landmarker = None
        if prefer_gpu:
            try:
                landmarker = vision.PoseLandmarker.create_from_options(
                    vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(self.model_path), delegate=BaseOptions.Delegate.GPU), **opts_kwargs))
                self.delegate = "GPU"
            except Exception as e:  # noqa: BLE001
                log.info("GPU delegate unavailable (%s); using CPU", str(e).splitlines()[0][:120])
        if landmarker is None:
            landmarker = vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=str(self.model_path), delegate=BaseOptions.Delegate.CPU), **opts_kwargs))
        self._landmarker = landmarker

    def provenance(self) -> Dict[str, Any]:
        return {"model_id": "mediapipe_pose_landmarker", "version": f"{self.variant}/float16/1/mediapipe-{self._mp.__version__}", "delegate": self.delegate}

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: float, frame_id: int, meta: Optional[Dict[str, Any]] = None) -> List[PersonPose]:
        rgb = frame_bgr[:, :, ::-1].copy()
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        ts = int(round(timestamp_ms))
        if ts <= self._last_ts:  # VIDEO mode requires strictly increasing timestamps
            ts = self._last_ts + 1
        self._last_ts = ts
        result = self._landmarker.detect_for_video(image, ts)
        persons: List[PersonPose] = []
        for i, lms in enumerate(result.pose_landmarks):
            xy = np.array([[l.x, l.y] for l in lms], dtype=np.float64)
            z = np.array([l.z for l in lms], dtype=np.float64)
            scores = np.array([l.visibility if l.visibility is not None else 1.0 for l in lms], dtype=np.float64)
            world = None
            if result.pose_world_landmarks and i < len(result.pose_world_landmarks):
                world = np.array([[w.x, w.y, w.z] for w in result.pose_world_landmarks[i]], dtype=np.float64)
            persons.append(PersonPose(landmark_set="mediapipe_pose_33", xy=xy, scores=scores, z=z, world_xyz=world))
        return persons

    def close(self) -> None:
        try:
            self._landmarker.close()
        except Exception:  # noqa: BLE001
            pass


def benchmark(backend: PoseBackend, frames: List[np.ndarray]) -> float:
    """Frames per second over a list of BGR frames (excludes decoding)."""
    t0 = time.perf_counter()
    for i, f in enumerate(frames):
        backend.detect(f, i * 33.0, i)
    dt = time.perf_counter() - t0
    return len(frames) / dt if dt > 0 else float("inf")
