"""VideoPose3D (facebookresearch, CC-BY-NC) temporal convolution lifter.

LICENSE: CC-BY-NC 4.0 -> research/evaluation only. `commercial_ok = False` and the
job API refuses it unless the caller sets allow_noncommercial. Architecture
re-implemented from the paper/repo (Pavllo et al. 2019): dilated temporal convs,
`-arc 3,3,3,3,3` => receptive field 243, 1024 channels, residual blocks, optional
causal mode. Weights: pretrained_h36m_detectron_coco.bin (2D COCO-17 from Detectron
-> H36M-17 3D).
"""
from __future__ import annotations

import logging
import os
import pathlib
import urllib.request
from typing import Any, Dict, Optional

import numpy as np

from ..pose.mediapipe_backend import model_cache_dir
from .base import H36M_17, LiftedSequence, Lifter3D, ModelUnavailable

log = logging.getLogger("apexformz.perception.videopose3d")
WEIGHTS_URL = "https://dl.fbaipublicfiles.com/video-pose-3d/pretrained_h36m_detectron_coco.bin"

# COCO-17 -> H36M-17 input ordering used by the Detectron/COCO pretrained model (repo: data_utils / inference).
# The pretrained COCO model consumes COCO joints directly (17 inputs) and predicts H36M joints.


def _torch():
    try:
        import torch
        import torch.nn as nn
        return torch, nn
    except ImportError as e:  # pragma: no cover
        raise ModelUnavailable(f"torch not installed: {e}") from e


def build_temporal_model(num_joints_in: int = 17, in_features: int = 2, num_joints_out: int = 17, filter_widths=(3, 3, 3, 3, 3),
                         causal: bool = False, dropout: float = 0.25, channels: int = 1024, dense: bool = False):
    torch, nn = _torch()

    class TemporalModel(nn.Module):
        def __init__(self):
            super().__init__()
            for fw in filter_widths:
                assert fw % 2 != 0, "only odd filter widths are supported"
            self.num_joints_in, self.in_features, self.num_joints_out = num_joints_in, in_features, num_joints_out
            self.filter_widths = list(filter_widths)
            self.drop = nn.Dropout(dropout)
            self.relu = nn.ReLU(inplace=True)
            self.pad = [filter_widths[0] // 2]
            self.expand_bn = nn.BatchNorm1d(channels, momentum=0.1)
            self.shrink = nn.Conv1d(channels, num_joints_out * 3, 1)
            self.expand_conv = nn.Conv1d(num_joints_in * in_features, channels, filter_widths[0], bias=False)
            layers_conv, layers_bn = [], []
            self.causal_shift = [(filter_widths[0]) // 2 if causal else 0]
            next_dilation = filter_widths[0]
            for i in range(1, len(filter_widths)):
                self.pad.append((filter_widths[i] - 1) * next_dilation // 2)
                self.causal_shift.append((filter_widths[i] // 2 * next_dilation) if causal else 0)
                layers_conv.append(nn.Conv1d(channels, channels, filter_widths[i] if not dense else (2 * self.pad[-1] + 1),
                                             dilation=next_dilation if not dense else 1, bias=False))
                layers_bn.append(nn.BatchNorm1d(channels, momentum=0.1))
                layers_conv.append(nn.Conv1d(channels, channels, 1, dilation=1, bias=False))
                layers_bn.append(nn.BatchNorm1d(channels, momentum=0.1))
                next_dilation *= filter_widths[i]
            self.layers_conv = nn.ModuleList(layers_conv)
            self.layers_bn = nn.ModuleList(layers_bn)

        def receptive_field(self) -> int:
            frames = 0
            for f in self.pad:
                frames += f
            return 1 + 2 * frames

        def forward(self, x):  # x: (B, T, J, C)
            B, T = x.shape[:2]
            x = x.view(B, T, -1).permute(0, 2, 1)
            x = self.drop(self.relu(self.expand_bn(self.expand_conv(x))))
            for i in range(len(self.pad) - 1):
                pad = self.pad[i + 1]
                shift = self.causal_shift[i + 1]
                res = x[:, :, pad + shift: x.shape[2] - pad + shift]
                x = self.drop(self.relu(self.layers_bn[2 * i](self.layers_conv[2 * i](x))))
                x = res + self.drop(self.relu(self.layers_bn[2 * i + 1](self.layers_conv[2 * i + 1](x))))
            x = self.shrink(x)
            x = x.permute(0, 2, 1)
            return x.view(B, -1, self.num_joints_out, 3)

    return TemporalModel()


def normalize_screen_coordinates(xy_norm: np.ndarray, w: int, h: int) -> np.ndarray:
    """Repo convention: pixel coords -> [-1,1] on x, y scaled by aspect. Input here is 0..1 normalized."""
    px = xy_norm[..., 0] * w
    py = xy_norm[..., 1] * h
    return np.stack([px / w * 2 - 1, py / w * 2 - h / w], axis=-1)


def ensure_weights(timeout_s: float = 300.0) -> pathlib.Path:
    env = os.environ.get("APEXFORMZ_VIDEOPOSE3D_CKPT")
    if env and pathlib.Path(env).exists():
        return pathlib.Path(env)
    target = model_cache_dir() / "videopose3d_pretrained_h36m_detectron_coco.bin"
    if target.exists() and target.stat().st_size > 10_000_000:
        return target
    tmp = target.with_suffix(".tmp")
    try:
        with urllib.request.urlopen(WEIGHTS_URL, timeout=timeout_s) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        tmp.replace(target)
    except Exception as e:  # noqa: BLE001
        if tmp.exists():
            tmp.unlink()
        raise ModelUnavailable(f"VideoPose3D weights download failed: {e}") from e
    return target


class VideoPose3DLifter(Lifter3D):
    name = "videopose3d"
    license = "CC-BY-NC-4.0"
    commercial_ok = False

    def __init__(self, weights: Optional[str] = None, causal: bool = False, device: str = "auto", random_init: bool = False):
        torch, _ = _torch()
        self.device = ("cuda" if torch.cuda.is_available() else "cpu") if device == "auto" else device
        self.model = build_temporal_model(causal=causal).to(self.device).eval()
        self.causal = causal
        self.weights_path: Optional[str] = None
        if random_init:
            self.weights_path = "random-init (shape test only)"
        else:
            path = pathlib.Path(weights) if weights else ensure_weights()
            ckpt = torch.load(str(path), map_location=self.device, weights_only=False)
            state = ckpt["model_pos"] if isinstance(ckpt, dict) and "model_pos" in ckpt else ckpt
            self.model.load_state_dict(state, strict=True)
            self.weights_path = str(path)

    def provenance(self) -> Dict[str, Any]:
        return {"model_id": "videopose3d", "version": f"pretrained_h36m_detectron_coco|arc=3,3,3,3,3|causal={self.causal}|license=CC-BY-NC", "delegate": self.device}

    def lift(self, keypoints_2d: np.ndarray, scores: np.ndarray, image_size) -> LiftedSequence:
        torch, _ = _torch()
        w, h = int(image_size[0]), int(image_size[1])
        T = keypoints_2d.shape[0]
        rf = self.model.receptive_field()
        pad = (rf - 1) // 2
        inp = normalize_screen_coordinates(keypoints_2d, w, h).astype(np.float32)
        if self.causal:
            inp_p = np.concatenate([np.repeat(inp[:1], rf - 1, axis=0), inp], axis=0)
        else:
            inp_p = np.pad(inp, ((pad, pad), (0, 0), (0, 0)), mode="edge")
        with torch.no_grad():
            out = self.model(torch.from_numpy(inp_p)[None].to(self.device))[0].cpu().numpy()
        out = out[:T]
        valid = (scores >= 0.3).sum(axis=1) >= 12
        notes = ["VideoPose3D is CC-BY-NC: research/evaluation only; outputs are root-relative, uncalibrated metres (estimated_world)."]
        return LiftedSequence(joints_xyz=out, joint_names=H36M_17, valid=valid, provenance=self.provenance(), notes=notes)
