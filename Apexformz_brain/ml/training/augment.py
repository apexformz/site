"""Physics- and semantics-constrained augmentations (TRD 10).

Mirroring is only valid when the handedness label and any side-specific
movement label transform together; `mirror` therefore returns the flipped
handedness and expects the caller to remap side-specific movement ids.
"""
from __future__ import annotations

from typing import Dict, Tuple

import numpy as np

# Mirror pairs for MediaPipe Pose 33 (left id, right id), matching contracts/enums.
MIRROR_PAIRS = [(1, 4), (2, 5), (3, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32)]
MIRROR_PAIRS_17 = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10), (11, 12), (13, 14), (15, 16)]


def jitter(x: np.ndarray, mask: np.ndarray, sigma: float, rng: np.random.Generator) -> np.ndarray:
    """Modest landmark jitter in body-relative units; masked landmarks stay zero."""
    noise = rng.normal(0, sigma, size=x.shape)
    T, VC = x.shape
    V = VC // 3
    m = np.repeat(mask.reshape(T, V, 1), 3, axis=2).reshape(T, VC)
    return x + noise * m


def masked_occlusion(x: np.ndarray, mask: np.ndarray, p_joint: float, min_len: int, max_len: int, rng: np.random.Generator) -> Tuple[np.ndarray, np.ndarray]:
    """Drop contiguous spans of random joints; coordinates zeroed and mask cleared (never interpolated)."""
    x = x.copy()
    mask = mask.copy()
    T, V = mask.shape
    for v in range(V):
        if rng.random() < p_joint:
            L = int(rng.integers(min_len, max_len + 1))
            s = int(rng.integers(0, max(1, T - L)))
            mask[s : s + L, v] = 0
            x[s : s + L, v * 3 : v * 3 + 3] = 0
    return x, mask


def temporal_resample(x: np.ndarray, mask: np.ndarray, factor: float) -> Tuple[np.ndarray, np.ndarray]:
    """Speed change by nearest-neighbour index resampling (no interpolation across gaps)."""
    T = x.shape[0]
    new_T = max(2, int(round(T * factor)))
    idx = np.clip(np.round(np.linspace(0, T - 1, new_T)).astype(int), 0, T - 1)
    return x[idx], mask[idx]


def mirror(x: np.ndarray, mask: np.ndarray, handedness: str, landmark_set: str | None = None) -> Tuple[np.ndarray, np.ndarray, str]:
    """Flip x axis and swap left/right landmark identities; returns flipped handedness."""
    T, VC = x.shape
    V = VC // 3
    xs = x.reshape(T, V, 3).copy()
    ms = mask.copy()
    xs[:, :, 0] *= -1
    expected = {"mediapipe_pose_33": 33, "coco_17": 17}
    if V not in (17, 33) or (landmark_set is not None and expected.get(landmark_set) != V):
        raise ValueError(f"unsupported or mismatched mirror skeleton: {landmark_set}, {V} landmarks")
    for l, r in (MIRROR_PAIRS_17 if V == 17 else MIRROR_PAIRS):
        xs[:, [l, r]] = xs[:, [r, l]]
        ms[:, [l, r]] = ms[:, [r, l]]
    new_hand = {"left": "right", "right": "left"}.get(handedness, "unknown")
    return xs.reshape(T, VC), ms, new_hand


def apply_pipeline(x: np.ndarray, mask: np.ndarray, handedness: str, rng: np.random.Generator, cfg: Dict | None = None):
    cfg = cfg or {}
    x = jitter(x, mask, cfg.get("jitter_sigma", 0.01), rng)
    x, mask = masked_occlusion(x, mask, cfg.get("occlusion_p", 0.1), cfg.get("occlusion_min", 3), cfg.get("occlusion_max", 10), rng)
    if cfg.get("resample", True):
        x, mask = temporal_resample(x, mask, float(rng.uniform(0.8, 1.25)))
    mirrored = False
    if cfg.get("mirror", True) and rng.random() < 0.5:
        x, mask, handedness = mirror(x, mask, handedness, cfg.get("landmark_set"))
        mirrored = True
    return x, mask, handedness, mirrored
