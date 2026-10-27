"""Meta Segment Anything 2.1 video object tracker (Apache-2.0, github.com/facebookresearch/sam2).

Prompted object tracking is the generic equipment-adapter pathway (TRD 02): the caller labels the
object (any string, e.g. the pack's equipment ``object_class``); this module never names a sport.

Install notes (verified on Windows): ``SAM2_BUILD_CUDA=0 pip install git+https://github.com/facebookresearch/sam2.git``
installs without the optional CUDA post-processing extension. ``init_state`` accepts a directory of
JPEG frames (``00000.jpg`` ...) or an MP4 path; we always write a JPEG directory so decoding never
depends on optional video backends. Checkpoint: ``sam2.1_hiera_tiny.pt`` (156 MB) with config
``configs/sam2.1/sam2.1_hiera_t.yaml`` (shipped inside the installed package).

SAM 3 (facebookresearch/sam3, Nov 2025, custom license) is a documented future adapter, not integrated.
"""
from __future__ import annotations

import os
import pathlib
import tempfile
import time
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from apexformz_contracts.models import Track, TrackPoint, TrackSet

from .base import FramesLike, ModelUnavailable, ObjectPrompt, ObjectTracker, TrackerInfo, ensure_checkpoint, iter_frames, make_trackset, provenance

REPO = "https://github.com/facebookresearch/sam2"
LICENSE = "Apache-2.0"
CKPT_URLS = {
    "tiny": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
    "small": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt",
    "base_plus": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt",
    "large": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt",
}
CFGS = {"tiny": "configs/sam2.1/sam2.1_hiera_t.yaml", "small": "configs/sam2.1/sam2.1_hiera_s.yaml", "base_plus": "configs/sam2.1/sam2.1_hiera_b+.yaml", "large": "configs/sam2.1/sam2.1_hiera_l.yaml"}


def mask_to_bbox_centroid(mask: np.ndarray) -> Optional[Tuple[Tuple[float, float, float, float], Tuple[float, float], float]]:
    """(bbox x0,y0,x1,y1 normalised, centroid normalised, area fraction) or None if the mask is empty."""
    h, w = mask.shape[-2:]
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return None
    x0, x1 = xs.min() / w, (xs.max() + 1) / w
    y0, y1 = ys.min() / h, (ys.max() + 1) / h
    return (float(x0), float(y0), float(x1), float(y1)), (float(xs.mean() / w), float(ys.mean() / h)), float(len(xs) / (h * w))


class Sam2ObjectTracker(ObjectTracker):
    info = TrackerInfo(
        name="sam2.1_video", kind="object", repo=REPO, license=LICENSE, commercial_ok=True, online=False,
        description="SAM 2.1 promptable video object segmentation; masks -> per-frame bbox/centroid tracks.",
        checkpoint_urls=[CKPT_URLS["tiny"]],
        notes=["Propagation is offline over the clip (streaming memory internally, but we run it per clip).", "SAM 3 is a future adapter (custom license)."],
    )

    def __init__(self, variant: str = "tiny", device: Optional[str] = None, checkpoint: Optional[str] = None, max_frames: Optional[int] = None):
        self.variant = variant
        self.device_pref = device
        self.checkpoint = checkpoint
        self.max_frames = max_frames
        self._predictor = None
        self._ckpt_path = None

    def available(self) -> Tuple[bool, str]:
        try:
            import torch  # noqa: F401
            from sam2.build_sam import build_sam2_video_predictor  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return False, f"sam2 not importable: {e}"
        return True, "ok"

    def _load(self):
        if self._predictor is not None:
            return self._predictor
        ok, why = self.available()
        if not ok:
            raise ModelUnavailable(why)
        import torch
        from sam2.build_sam import build_sam2_video_predictor

        self._ckpt_path = ensure_checkpoint(CKPT_URLS[self.variant]) if self.checkpoint is None else pathlib.Path(self.checkpoint)
        self.device = self.device_pref or ("cuda" if torch.cuda.is_available() else "cpu")
        self._predictor = build_sam2_video_predictor(CFGS[self.variant], str(self._ckpt_path), device=self.device)
        return self._predictor

    def track(self, frames: FramesLike, prompts: Sequence[ObjectPrompt], *, fps: Optional[float] = None, video_ref: Optional[str] = None) -> TrackSet:
        import cv2
        import torch

        predictor = self._load()
        frame_list, read_fps = iter_frames(frames)
        if self.max_frames:
            frame_list = frame_list[: self.max_frames]
        T = len(frame_list)
        H, W = frame_list[0].shape[:2]
        t0 = time.perf_counter()
        with tempfile.TemporaryDirectory(prefix="apexformz_sam2_") as tmp:
            for i, f in enumerate(frame_list):
                cv2.imwrite(os.path.join(tmp, f"{i:05d}.jpg"), f, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
            use_autocast = self.device == "cuda"
            ctx = torch.autocast("cuda", dtype=torch.bfloat16) if use_autocast else torch.autocast("cpu", enabled=False)
            with torch.inference_mode(), ctx:
                state = predictor.init_state(video_path=tmp, offload_video_to_cpu=(self.device != "cuda"))
                obj_labels: Dict[int, str] = {}
                for oid, p in enumerate(prompts, start=1):
                    obj_labels[oid] = p.label
                    box = None
                    pts = labels = None
                    if p.box is not None:
                        x0, y0, x1, y1 = p.box
                        box = np.array([x0 * W, y0 * H, x1 * W, y1 * H], dtype=np.float32)
                    if p.points:
                        pts = np.array([[x * W, y * H] for x, y in p.points], dtype=np.float32)
                        labels = np.ones(len(p.points), dtype=np.int32)
                    predictor.add_new_points_or_box(state, frame_idx=int(p.frame_id), obj_id=oid, points=pts, labels=labels, box=box)
                per_obj: Dict[int, Dict[int, np.ndarray]] = {oid: {} for oid in obj_labels}
                start = min(int(p.frame_id) for p in prompts)
                for fidx, obj_ids, mask_logits in predictor.propagate_in_video(state, start_frame_idx=start):
                    for k, oid in enumerate(obj_ids):
                        per_obj[int(oid)][int(fidx)] = (mask_logits[k, 0] > 0.0).cpu().numpy()
                if start > 0:
                    for fidx, obj_ids, mask_logits in predictor.propagate_in_video(state, start_frame_idx=start, reverse=True):
                        for k, oid in enumerate(obj_ids):
                            per_obj[int(oid)].setdefault(int(fidx), (mask_logits[k, 0] > 0.0).cpu().numpy())
        elapsed = time.perf_counter() - t0
        fps_eff = fps or read_fps
        tracks: List[Track] = []
        for oid, masks in per_obj.items():
            pts: List[TrackPoint] = []
            for fidx in range(T):
                m = masks.get(fidx)
                info = mask_to_bbox_centroid(m) if m is not None else None
                ts = None if fps_eff is None else fidx * 1000.0 / float(fps_eff)
                if info is None:
                    pts.append(TrackPoint(frame_id=fidx, timestamp_ms=ts, x=0.0, y=0.0, visible=False, confidence=0.0, bbox=None))
                else:
                    bbox, (cx, cy), area = info
                    pts.append(TrackPoint(frame_id=fidx, timestamp_ms=ts, x=cx, y=cy, visible=True, confidence=float(min(1.0, 0.5 + 50.0 * area)), bbox=list(bbox)))
            prompt = prompts[oid - 1]
            qx, qy = (prompt.points[0] if prompt.points else (((prompt.box[0] + prompt.box[2]) / 2, (prompt.box[1] + prompt.box[3]) / 2) if prompt.box else (0.0, 0.0)))
            tracks.append(Track(track_id=f"sam2-obj-{oid}", label=obj_labels[oid], query={"frame_id": int(prompt.frame_id), "x": float(qx), "y": float(qy)}, points=pts))
        return make_trackset(
            source=provenance(f"facebookresearch/sam2:sam2.1_hiera_{self.variant}", "2.1", self._ckpt_path, getattr(self, "device", None)),
            kind="object", tracks=tracks, frame_count=T, image_size=(W, H), fps=fps_eff, retrospective=True, video_ref=video_ref,
            notes=[f"inference_s={elapsed:.3f}", f"fps_equivalent={T / max(elapsed, 1e-6):.1f}", "confidence is a mask-area heuristic, not a calibrated probability"],
        )
