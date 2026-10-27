"""MotionBERT (Walter0807/MotionBERT, Apache-2.0) 2D->3D lifting adapter.

Weights are distributed via OneDrive and are not auto-downloadable; provide the
checkpoint path through APEXFORMZ_MOTIONBERT_CKPT (and the repo code through
APEXFORMZ_MOTIONBERT_REPO so `lib.model.DSTformer` can be imported). Without them
the adapter raises ModelUnavailable (fail closed). Input: H36M-17 2D keypoints
normalized to [-1,1] with confidence as the third channel, 243-frame clips.
"""
from __future__ import annotations

import os
import pathlib
import sys
from typing import Any, Dict, Optional

import numpy as np

from .base import H36M_17, LiftedSequence, Lifter3D, ModelUnavailable

# COCO-17 index -> H36M-17 slot (MotionBERT's coco2h36m: pelvis/thorax/spine/neck/head synthesized from COCO joints).


def coco2h36m(x: np.ndarray) -> np.ndarray:
    """(..., 17, C) COCO -> (..., 17, C) H36M as in MotionBERT's utils_data.coco2h36m."""
    y = np.zeros_like(x)
    y[..., 0, :] = (x[..., 11, :] + x[..., 12, :]) * 0.5
    y[..., 1, :] = x[..., 12, :]
    y[..., 2, :] = x[..., 14, :]
    y[..., 3, :] = x[..., 16, :]
    y[..., 4, :] = x[..., 11, :]
    y[..., 5, :] = x[..., 13, :]
    y[..., 6, :] = x[..., 15, :]
    y[..., 8, :] = (x[..., 5, :] + x[..., 6, :]) * 0.5
    y[..., 7, :] = (y[..., 0, :] + y[..., 8, :]) * 0.5
    y[..., 9, :] = x[..., 0, :]
    y[..., 10, :] = (x[..., 1, :] + x[..., 2, :]) * 0.5
    y[..., 11, :] = x[..., 5, :]
    y[..., 12, :] = x[..., 7, :]
    y[..., 13, :] = x[..., 9, :]
    y[..., 14, :] = x[..., 6, :]
    y[..., 15, :] = x[..., 8, :]
    y[..., 16, :] = x[..., 10, :]
    return y


class MotionBERTLifter(Lifter3D):
    name = "motionbert"
    license = "Apache-2.0"
    commercial_ok = True

    def __init__(self, ckpt: Optional[str] = None, repo: Optional[str] = None, device: str = "auto", clip_len: int = 243):
        try:
            import torch
        except ImportError as e:  # pragma: no cover
            raise ModelUnavailable(f"torch not installed: {e}") from e
        ckpt = ckpt or os.environ.get("APEXFORMZ_MOTIONBERT_CKPT")
        repo = repo or os.environ.get("APEXFORMZ_MOTIONBERT_REPO")
        if not ckpt or not pathlib.Path(ckpt).exists():
            raise ModelUnavailable("MotionBERT checkpoint not found; set APEXFORMZ_MOTIONBERT_CKPT (weights are not auto-downloadable)")
        if not repo or not pathlib.Path(repo).exists():
            raise ModelUnavailable("MotionBERT repo not found; set APEXFORMZ_MOTIONBERT_REPO to a clone of Walter0807/MotionBERT")
        sys.path.insert(0, str(repo))
        try:
            from lib.model.DSTformer import DSTformer  # type: ignore
        except Exception as e:  # noqa: BLE001
            raise ModelUnavailable(f"cannot import MotionBERT DSTformer from {repo}: {e}") from e
        self.device = ("cuda" if torch.cuda.is_available() else "cpu") if device == "auto" else device
        self.clip_len = clip_len
        self.model = DSTformer(dim_in=3, dim_out=3, dim_feat=512, dim_rep=512, depth=5, num_heads=8, mlp_ratio=2, num_joints=17,
                               maxlen=clip_len).to(self.device).eval()
        state = torch.load(ckpt, map_location=self.device, weights_only=False)
        sd = state.get("model_pos", state)
        sd = {k.replace("module.", ""): v for k, v in sd.items()}
        self.model.load_state_dict(sd, strict=True)
        self.ckpt = ckpt

    def provenance(self) -> Dict[str, Any]:
        return {"model_id": "motionbert_dstformer", "version": f"ckpt={pathlib.Path(self.ckpt).name}|clip={self.clip_len}", "delegate": self.device}

    def lift(self, keypoints_2d: np.ndarray, scores: np.ndarray, image_size) -> LiftedSequence:
        import torch
        w, h = int(image_size[0]), int(image_size[1])
        T = keypoints_2d.shape[0]
        px = keypoints_2d * np.array([w, h])
        inp = np.concatenate([px, scores[..., None]], axis=-1)
        inp = coco2h36m(inp)
        # MotionBERT normalization: center on image, scale by max side
        inp[..., :2] = (inp[..., :2] - np.array([w, h]) / 2) / (max(w, h) / 2)
        outs = []
        for s in range(0, T, self.clip_len):
            clip = inp[s:s + self.clip_len].astype(np.float32)
            if clip.shape[0] < self.clip_len:
                clip = np.concatenate([clip, np.repeat(clip[-1:], self.clip_len - clip.shape[0], axis=0)], axis=0)
            with torch.no_grad():
                out = self.model(torch.from_numpy(clip)[None].to(self.device))[0].cpu().numpy()
            outs.append(out[: min(self.clip_len, T - s)])
        joints = np.concatenate(outs, axis=0)
        joints = joints - joints[:, :1]
        valid = (scores >= 0.3).sum(axis=1) >= 12
        return LiftedSequence(joints_xyz=joints, joint_names=H36M_17, valid=valid, provenance=self.provenance(),
                              notes=["MotionBERT outputs are root-relative, uncalibrated (estimated_world)."])
