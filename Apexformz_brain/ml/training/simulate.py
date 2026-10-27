"""
Physically grounded simulation of new executions from real labeled ones (3D body frame inputs only).

Every call turns one real window into a plausible variant of the SAME movement, so labels stay correct:

  anthropometry   segment lengths (thigh, shank, foot, upper arm, forearm, hand, torso width, head) scaled
                  independently within +/- `bone_scale` (with a small left/right asymmetry), joint angles kept;
                  simulates athletes with different body proportions
  camera tilt     rotation of the whole body frame by up to `tilt_deg` about the two horizontal axes;
                  simulates a camera that is not level
  depth noise     temporally smooth noise on the depth (z) axis, the axis MediaPipe estimates least reliably
  tempo           handled by train.py speed_range

Inputs are windows in the world_bodyframe_v1 layout: [T, V*3] body-frame coordinates (hip centre at origin,
torso length 1) and a [T, V] mask. Masked joints stay masked and at zero. After simulation the window is
re-normalised to the same frame (hip centre at origin, unit torso length), exactly as the deployed input is.
Nothing here introduces data from another source.
"""
from __future__ import annotations

from typing import Dict, Tuple

import numpy as np

# MediaPipe Pose 33 kinematic tree: child -> (parent, segment name). Hips and shoulders hang off the pelvis centre.
PARENT = {
    25: (23, "thigh"), 27: (25, "shank"), 29: (27, "foot"), 31: (27, "foot"),
    26: (24, "thigh"), 28: (26, "shank"), 30: (28, "foot"), 32: (28, "foot"),
    13: (11, "upper_arm"), 15: (13, "forearm"), 17: (15, "hand"), 19: (15, "hand"), 21: (15, "hand"),
    14: (12, "upper_arm"), 16: (14, "forearm"), 18: (16, "hand"), 20: (16, "hand"), 22: (16, "hand"),
}
HEAD = list(range(0, 11))
ORDER = [25, 26, 13, 14, 27, 28, 15, 16, 29, 31, 30, 32, 17, 19, 21, 18, 20, 22]
SEGMENTS = ("thigh", "shank", "foot", "upper_arm", "forearm", "hand", "torso_width", "head")
LEFT = {23, 25, 27, 29, 31, 11, 13, 15, 17, 19, 21}


def _rot(ax: float, az: float) -> np.ndarray:
    cx, sx, cz, sz = np.cos(ax), np.sin(ax), np.cos(az), np.sin(az)
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rz @ rx


def simulate_window(x: np.ndarray, mask: np.ndarray, rng: np.random.Generator, cfg: Dict) -> Tuple[np.ndarray, np.ndarray]:
    T = x.shape[0]
    V = mask.shape[1]
    if V != 33:
        return x, mask
    p = x.reshape(T, V, 3).astype(np.float64).copy()
    m = mask.astype(bool)
    bs = float(cfg.get("bone_scale", 0.12))
    asym = float(cfg.get("asymmetry", 0.03))
    base = {s: 1.0 + rng.uniform(-bs, bs) for s in SEGMENTS}
    side = {s: (rng.uniform(-asym, asym), rng.uniform(-asym, asym)) for s in SEGMENTS}

    def scale(seg: str, joint: int) -> float:
        return base[seg] + (side[seg][0] if joint in LEFT else side[seg][1])

    out = p.copy()
    # torso width: hips and shoulders spread about their midpoints
    for a, b in ((23, 24), (11, 12)):
        mid = (p[:, a] + p[:, b]) / 2
        for j in (a, b):
            out[:, j] = mid + scale("torso_width", j) * (p[:, j] - mid)
    # limbs, parents before children, keep each joint's direction from its parent
    for child in ORDER:
        par, seg = PARENT[child]
        ok = m[:, child] & m[:, par]
        out[ok, child] = out[ok, par] + scale(seg, child) * (p[ok, child] - p[ok, par])
    # head moves rigidly with the shoulder centre and scales about it
    sh_old = (p[:, 11] + p[:, 12]) / 2
    sh_new = (out[:, 11] + out[:, 12]) / 2
    for j in HEAD:
        ok = m[:, j]
        out[ok, j] = sh_new[ok] + base["head"] * (p[ok, j] - sh_old[ok])
    # camera tilt
    td = np.deg2rad(float(cfg.get("tilt_deg", 8.0)))
    R = _rot(rng.uniform(-td, td), rng.uniform(-td, td))
    out = out @ R.T
    # temporally smooth depth noise (random walk, low-passed)
    dz = float(cfg.get("depth_noise", 0.03))
    if dz > 0 and T > 1:
        walk = np.cumsum(rng.normal(0, dz / np.sqrt(T), size=(T, V)), axis=0)
        walk -= walk.mean(axis=0, keepdims=True)
        out[:, :, 2] += walk + rng.normal(0, dz * 0.3, size=(T, V))
    elif dz > 0:
        out[:, :, 2] += rng.normal(0, dz, size=(T, V))
    # re-normalise: hip centre at origin, unit torso length, per frame where the root is valid
    root_ok = m[:, 11] & m[:, 12] & m[:, 23] & m[:, 24]
    hp = (out[:, 23] + out[:, 24]) / 2
    sh = (out[:, 11] + out[:, 12]) / 2
    torso = np.linalg.norm(sh - hp, axis=1)
    good = root_ok & (torso > 1e-6)
    out[good] = (out[good] - hp[good, None, :]) / torso[good, None, None]
    out[~m] = 0.0
    out[~good] = 0.0
    m2 = m & good[:, None]
    return out.reshape(T, V * 3).astype(np.float32), m2.astype(mask.dtype)
