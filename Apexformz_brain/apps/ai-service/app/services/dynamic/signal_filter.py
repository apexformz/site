"""
One Euro Filter — Adaptive Low-Pass Signal Smoothing

Reduces jitter in real-time keypoint coordinates from MediaPipe without
adding perceptible lag. Uses an adaptive cutoff frequency: low speed =
aggressive smoothing (kills jitter), high speed = minimal smoothing
(preserves fast movements like kicks).

Reference: Casiez, Roussel, Vogel, "1€ Filter: A Simple Speed-based
Low-pass Filter for Noisy Input in Interactive Systems", CHI 2012.

This module is completely self-contained — no external dependency required.
"""

import math
from typing import Dict, List, Any, Optional


class LowPassFilter:
    """Simple first-order IIR low-pass filter."""

    def __init__(self, alpha: float = 1.0):
        self._y = 0.0
        self._s = 0.0
        self._initialized = False
        self._alpha = alpha

    def _set_alpha(self, alpha: float):
        self._alpha = max(0.0, min(1.0, alpha))

    def filter(self, value: float, alpha: Optional[float] = None) -> float:
        if alpha is not None:
            self._set_alpha(alpha)
        if not self._initialized:
            self._s = value
            self._initialized = True
        else:
            self._s = self._alpha * value + (1.0 - self._alpha) * self._s
        self._y = self._s
        return self._y

    def last_value(self) -> float:
        return self._y

    def reset(self):
        self._initialized = False
        self._y = 0.0
        self._s = 0.0


class OneEuroFilter:
    """
    Attempt to reduce jitter while preserving responsiveness.

    Parameters:
        freq:       Estimated signal frequency (Hz). For 15fps webcam, use 15.0.
        min_cutoff: Minimum cutoff frequency. Lower = more smoothing at low speeds.
        beta:       Speed coefficient. Higher = less lag during fast motions (kicks).
        d_cutoff:   Cutoff frequency for the derivative filter.
    """

    def __init__(
        self,
        freq: float = 15.0,
        min_cutoff: float = 1.0,
        beta: float = 0.007,
        d_cutoff: float = 1.0,
    ):
        self.freq = freq
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x_filter = LowPassFilter()
        self._dx_filter = LowPassFilter()
        self._last_time: Optional[float] = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def filter(self, x: float, timestamp: Optional[float] = None) -> float:
        if self._last_time is not None and timestamp is not None:
            dt = timestamp - self._last_time
            if dt <= 0:
                dt = 1.0 / self.freq
            self.freq = 1.0 / dt
        else:
            dt = 1.0 / self.freq

        self._last_time = timestamp

        # Derivative of the signal (speed)
        prev = self._x_filter.last_value()
        dx = 0.0 if not self._x_filter._initialized else (x - prev) * self.freq
        edx = self._dx_filter.filter(dx, self._alpha(self.d_cutoff, dt))

        # Adaptive cutoff based on speed
        cutoff = self.min_cutoff + self.beta * abs(edx)
        return self._x_filter.filter(x, self._alpha(cutoff, dt))

    def reset(self):
        self._x_filter.reset()
        self._dx_filter.reset()
        self._last_time = None


class KeypointSmoother:
    """
    Smooths all incoming keypoints using per-coordinate One Euro Filters.

    Creates one filter per (keypoint_name, coordinate) pair so that each
    x and y channel is filtered independently with its own velocity tracking.

    Usage:
        smoother = KeypointSmoother(fps_estimate=15.0)
        smoothed = smoother.smooth(raw_keypoints)
    """

    def __init__(
        self,
        fps_estimate: float = 15.0,
        min_cutoff: float = 1.7,
        beta: float = 0.01,
    ):
        self.fps = fps_estimate
        self.min_cutoff = min_cutoff
        self.beta = beta
        self._filters: Dict[str, OneEuroFilter] = {}
        self._frame_count = 0

    def _get_filter(self, key: str) -> OneEuroFilter:
        if key not in self._filters:
            self._filters[key] = OneEuroFilter(
                freq=self.fps,
                min_cutoff=self.min_cutoff,
                beta=self.beta,
            )
        return self._filters[key]

    def smooth(self, keypoints: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Apply One Euro filtering to each keypoint's x and y coordinates.
        Returns a new list of keypoint dicts with smoothed values.
        Score and name are passed through unchanged.
        """
        self._frame_count += 1
        timestamp = self._frame_count / self.fps
        smoothed = []

        for kp in keypoints:
            name = kp.get("name", "")
            score = kp.get("score", 0)

            # Only smooth if confidence is decent
            if score < 0.3:
                smoothed.append(dict(kp))
                continue

            fx = self._get_filter(f"{name}_x")
            fy = self._get_filter(f"{name}_y")

            new_kp = dict(kp)
            new_kp["x"] = fx.filter(kp["x"], timestamp)
            new_kp["y"] = fy.filter(kp["y"], timestamp)
            smoothed.append(new_kp)

        return smoothed

    def set_fps_estimate(self, fps_estimate: float):
        """Update filter timing from the live stream without resetting state."""
        self.fps = max(float(fps_estimate), 1.0)
        # At lower capture rates, reduce lag by increasing the One-Euro beta.
        adaptive_beta = max(0.008, min(0.035, self.beta * (15.0 / self.fps)))
        for filt in self._filters.values():
            filt.freq = self.fps
            filt.beta = adaptive_beta

    def reset(self):
        """Clear all filter state for a new session."""
        self._filters.clear()
        self._frame_count = 0
