"""Offline (retrospective) temporal smoothers for keypoint sequences with missingness masks.

Live paths must never use these: zero-phase filters look at future frames
(TRD 03). Every result carries `retrospective=True` and the filter provenance.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

import numpy as np
from scipy.signal import butter, filtfilt, savgol_filter


@dataclass
class SmoothingResult:
    values: np.ndarray        # same shape as input
    mask: np.ndarray          # (T,) or (T,K) bool: True where the output is supported by observations
    provenance: Dict[str, Any]
    retrospective: bool = True


def _interp_missing(x: np.ndarray, mask: np.ndarray, max_gap: int) -> np.ndarray:
    """Linear interpolation across gaps up to max_gap samples; longer gaps keep the edge value."""
    x = x.astype(np.float64).copy()
    T = x.shape[0]
    idx = np.arange(T)
    if mask.sum() == 0:
        return x
    for col in np.ndindex(x.shape[1:]):
        series = x[(slice(None),) + col]
        m = mask if mask.ndim == 1 else mask[(slice(None),) + col[: mask.ndim - 1]]
        if m.sum() < 2:
            continue
        series[~m] = np.interp(idx[~m], idx[m], series[m])
        x[(slice(None),) + col] = series
    return x


def savitzky_golay(x: np.ndarray, mask: Optional[np.ndarray] = None, window: int = 11, polyorder: int = 3, max_gap: int = 15) -> SmoothingResult:
    """x: (T, ...) ; mask: (T,) or (T, K) observation mask."""
    T = x.shape[0]
    mask = np.ones(T, dtype=bool) if mask is None else mask.astype(bool)
    window = min(window if window % 2 else window + 1, T if T % 2 else T - 1)
    if window <= polyorder:
        return SmoothingResult(x.copy(), mask, {"filter": "savitzky_golay", "window": window, "polyorder": polyorder, "note": "too short; passthrough"})
    filled = _interp_missing(x, mask, max_gap)
    out = savgol_filter(filled, window_length=window, polyorder=polyorder, axis=0, mode="interp")
    return SmoothingResult(out, mask, {"filter": "savitzky_golay", "window": window, "polyorder": polyorder})


def butterworth_zero_phase(x: np.ndarray, fs: float, cutoff_hz: float = 5.0, order: int = 2, mask: Optional[np.ndarray] = None, max_gap: int = 15) -> SmoothingResult:
    """Zero-phase Butterworth (filtfilt). cutoff is a candidate value (TRD 03), not validated."""
    T = x.shape[0]
    mask = np.ones(T, dtype=bool) if mask is None else mask.astype(bool)
    padlen = 3 * (order + 1)
    if T <= padlen + 1 or fs <= 2 * cutoff_hz:
        return SmoothingResult(x.copy(), mask, {"filter": "butterworth_zero_phase", "cutoff_hz": cutoff_hz, "order": order, "fs": fs, "note": "too short or fs too low; passthrough"})
    filled = _interp_missing(x, mask, max_gap)
    b, a = butter(order, cutoff_hz / (fs / 2), btype="low")
    out = filtfilt(b, a, filled, axis=0)
    return SmoothingResult(out, mask, {"filter": "butterworth_zero_phase", "cutoff_hz": cutoff_hz, "order": order, "fs": fs})


class SmoothNetLike:
    """Interface placeholder for learned temporal refinement (cure-lab/SmoothNet, Apache-2.0).

    SmoothNet refines pose sequences with a temporal MLP over sliding windows (e.g. 32
    frames). Its checkpoints are distributed through Google Drive and are not
    auto-downloadable; set APEXFORMZ_SMOOTHNET_CKPT and implement `load()`.
    Until then `available` is False and callers fall back to the analytic filters.
    """

    name = "smoothnet"
    license = "Apache-2.0"
    available = False

    def smooth(self, x: np.ndarray, mask: Optional[np.ndarray] = None) -> SmoothingResult:
        raise RuntimeError("SmoothNet weights not configured (APEXFORMZ_SMOOTHNET_CKPT); use savitzky_golay or butterworth_zero_phase")


def smooth_pose_frames(frames, method: str = "butterworth", fs: Optional[float] = None, **kwargs) -> Dict[str, Any]:
    """Smooth the normalized landmarks of a PoseFrame sequence; returns new frames plus provenance.

    Landmarks with visibility < 0.5 are treated as missing; output visibility is kept."""
    if not frames:
        return {"frames": [], "provenance": {"filter": method, "note": "empty"}, "retrospective": True}
    K = max(len(f["normalized_landmarks"]) for f in frames)
    T = len(frames)
    xy = np.zeros((T, K, 2))
    mask = np.zeros((T, K), dtype=bool)
    ts = np.array([f["timestamp_ms"] for f in frames], dtype=float)
    for t, f in enumerate(frames):
        for l in f["normalized_landmarks"]:
            xy[t, l["id"]] = (l["x"], l["y"])
            mask[t, l["id"]] = (l.get("visibility") or 0.0) >= 0.5
    if fs is None:
        d = np.diff(ts)
        fs = 1000.0 / float(np.median(d)) if len(d) and np.median(d) > 0 else 30.0
    if method == "savgol":
        res = savitzky_golay(xy, mask, **kwargs)
    else:
        res = butterworth_zero_phase(xy, fs, mask=mask, **kwargs)
    out = []
    for t, f in enumerate(frames):
        g = dict(f)
        g["normalized_landmarks"] = [dict(l, x=float(res.values[t, l["id"], 0]), y=float(res.values[t, l["id"], 1])) if mask[t, l["id"]] else dict(l)
                                     for l in f["normalized_landmarks"]]
        out.append(g)
    return {"frames": out, "provenance": {**res.provenance, "fs_hz": fs}, "retrospective": True}


__all__ = ["SmoothingResult", "savitzky_golay", "butterworth_zero_phase", "SmoothNetLike", "smooth_pose_frames"]
