"""rtmlib backend (Apache-2.0): RTMPose / RTMO / RTMW / DWPose ONNX models from OpenMMLab.

- `Body`: two-stage YOLOX detector + RTMPose (COCO-17), modes lightweight/balanced/performance.
- `RTMO`: one-stage multi-person COCO-17 (no detector; best for crowded or edge use).
- `Wholebody`: 133 keypoints (RTMW/DWPose) emitted as `custom` or re-mapped to the 33-slot frame.

Model URLs are recorded verbatim as provenance; rtmlib downloads them to its own
cache (`~/.cache/rtmlib`) with a Hugging Face mirror fallback.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

import numpy as np

from .base import ModelUnavailable, PersonPose, PoseBackend

log = logging.getLogger("apexformz.perception.rtmlib")


def _import_rtmlib():
    try:
        import rtmlib  # type: ignore
        return rtmlib
    except ImportError as e:
        raise ModelUnavailable(f"rtmlib is not installed (pip install rtmlib): {e}") from e


def _providers_for(device: str) -> str:
    if device == "auto":
        try:
            import onnxruntime as ort
            return "cuda" if "CUDAExecutionProvider" in ort.get_available_providers() else "cpu"
        except Exception:  # noqa: BLE001
            return "cpu"
    return device


class RTMLibBackend(PoseBackend):
    """Backend over rtmlib solutions. `solution` in {'body', 'rtmo', 'wholebody'}."""

    def __init__(self, solution: str = "rtmo", mode: str = "balanced", device: str = "auto", backend: str = "onnxruntime",
                 score_thr: float = 0.3, nms_thr: float = 0.45, min_keypoint_score: float = 0.3):
        rtmlib = _import_rtmlib()
        self.solution = solution
        self.mode = mode
        self.device = _providers_for(device)
        self.backend = backend
        self.min_keypoint_score = min_keypoint_score
        self.model_urls: Dict[str, str] = {}
        try:
            if solution == "body":
                cfg = rtmlib.Body.MODE[mode]
                self.model_urls = {"det": cfg["det"], "pose": cfg["pose"]}
                self._model = rtmlib.Body(mode=mode, backend=backend, device=self.device, to_openpose=False)
                self.landmark_set = "coco_17"
            elif solution == "rtmo":
                cfg = rtmlib.Body.RTMO_MODE[mode]
                self.model_urls = {"pose": cfg["pose"]}
                self._model = rtmlib.RTMO(onnx_model=cfg["pose"], model_input_size=cfg["pose_input_size"], backend=backend,
                                          device=self.device, score_thr=score_thr, nms_thr=nms_thr, to_openpose=False)
                self.landmark_set = "coco_17"
            elif solution == "wholebody":
                cfg = rtmlib.Wholebody.MODE[mode]
                self.model_urls = {"det": cfg["det"], "pose": cfg["pose"]}
                self._model = rtmlib.Wholebody(mode=mode, backend=backend, device=self.device, to_openpose=False)
                self.landmark_set = "coco_wholebody_133"
            else:
                raise ValueError(f"unknown rtmlib solution {solution}")
        except ModelUnavailable:
            raise
        except Exception as e:  # noqa: BLE001  (download failure, provider failure)
            raise ModelUnavailable(f"rtmlib {solution}/{mode} could not be initialised: {e}") from e
        self.name = f"rtmlib_{solution}"

    def provenance(self) -> Dict[str, Any]:
        pose_url = self.model_urls.get("pose", "")
        model_file = os.path.basename(pose_url).replace(".zip", "")
        return {"model_id": f"rtmlib_{self.solution}", "version": f"{model_file}|mode={self.mode}|urls={','.join(self.model_urls.values())}",
                "delegate": f"{self.backend}:{self.device}"}

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: float, frame_id: int, meta: Optional[Dict[str, Any]] = None) -> List[PersonPose]:
        h, w = frame_bgr.shape[:2]
        keypoints, scores = self._model(frame_bgr)
        persons: List[PersonPose] = []
        if keypoints is None or len(keypoints) == 0:
            return persons
        keypoints = np.asarray(keypoints, dtype=np.float64)
        scores = np.asarray(scores, dtype=np.float64)
        for k, s in zip(keypoints, scores):
            xy = np.stack([k[:, 0] / w, k[:, 1] / h], axis=1)
            s = np.clip(s, 0.0, 1.0)
            ok = s >= self.min_keypoint_score
            if ok.sum() < 3:
                continue
            bbox = np.array([xy[ok, 0].min(), xy[ok, 1].min(), xy[ok, 0].max(), xy[ok, 1].max()])
            persons.append(PersonPose(landmark_set=self.landmark_set, xy=xy, scores=s, bbox=np.clip(bbox, 0, 1), detection_score=float(s[ok].mean())))
        return persons
