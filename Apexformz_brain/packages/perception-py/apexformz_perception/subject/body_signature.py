"""
Body-proportion signature (sport-agnostic): 3D bone-length ratios from MediaPipe world landmarks.

The signature uses 3D lengths, so it does not change when a person turns around, and it ignores clothing,
so it can tell apart people wearing the same kit. It is a weak signal on its own (pose noise is about
5-10 %). Use it with motion continuity; never use it alone as proof of identity.

Mirrors packages/perception/src/body_signature.ts exactly; both are checked against the same fixture
(packages/perception/src/__fixtures__/body_signature.json).
"""
from __future__ import annotations

from typing import List, Optional, Sequence

import numpy as np

# (name, landmark pairs averaged over left/right). Normalized by torso length (shoulder-to-hip, both sides).
SEGMENTS = (
    ("shoulder_width", ((11, 12),)),
    ("hip_width", ((23, 24),)),
    ("upper_arm", ((11, 13), (12, 14))),
    ("forearm", ((13, 15), (14, 16))),
    ("thigh", ((23, 25), (24, 26))),
    ("shin", ((25, 27), (26, 28))),
)
TORSO = ((11, 23), (12, 24))
MIN_VISIBILITY = 0.5
MIN_SHARED = 3


def signature(world: np.ndarray, visibility: np.ndarray, min_visibility: float = MIN_VISIBILITY) -> Optional[np.ndarray]:
    """6 ratios (NaN where an endpoint is not visible), or None without a visible torso."""
    def length(pairs):
        ls = [float(np.linalg.norm(world[a] - world[b])) for a, b in pairs
              if visibility[a] >= min_visibility and visibility[b] >= min_visibility]
        return float(np.mean(ls)) if ls else float("nan")
    torso = length(TORSO)
    if not np.isfinite(torso) or torso <= 1e-6:
        return None
    return np.array([length(pairs) / torso for _, pairs in SEGMENTS], dtype=float)


def distance(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    """Mean absolute log-ratio over the ratios both signatures have (0 = identical proportions)."""
    ok = np.isfinite(a) & np.isfinite(b) & (a > 0) & (b > 0)
    if ok.sum() < MIN_SHARED:
        return None
    return float(np.mean(np.abs(np.log(a[ok] / b[ok]))))


class RunningSignature:
    """Per-ratio median over the most recent clean samples of one person."""

    def __init__(self, capacity: int = 90):
        self.capacity = capacity
        self.samples: List[np.ndarray] = []

    def add(self, sig: Optional[np.ndarray]) -> None:
        if sig is None:
            return
        self.samples.append(sig)
        if len(self.samples) > self.capacity:
            self.samples.pop(0)

    @property
    def ready(self) -> bool:
        return len(self.samples) >= 10

    def value(self) -> Optional[np.ndarray]:
        if not self.samples:
            return None
        stack = np.vstack(self.samples)
        out = np.full(stack.shape[1], np.nan)
        for k in range(stack.shape[1]):
            col = stack[:, k][np.isfinite(stack[:, k])]
            if len(col):
                out[k] = float(np.median(col))
        return out


def summarize(values: Sequence[float]) -> dict:
    v = np.asarray([x for x in values if x is not None and np.isfinite(x)])
    return {"n": int(len(v)), "p10": float(np.percentile(v, 10)) if len(v) else None,
            "median": float(np.median(v)) if len(v) else None, "p90": float(np.percentile(v, 90)) if len(v) else None}
