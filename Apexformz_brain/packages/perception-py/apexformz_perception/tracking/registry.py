"""Tracker registry: names, licenses and commercial gates for every adapter."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from .base import ModelUnavailable, TrackerInfo
from .cotracker_tracker import CoTracker3Tracker
from .sam2_tracker import Sam2ObjectTracker
from .tapnet_tracker import BootsTapirTracker, CausalBootsTapirTracker, TapNextPPTracker

_FACTORIES = {
    "bootstapir_offline": lambda **kw: BootsTapirTracker(**{k: v for k, v in kw.items() if k in ("resolution", "device", "checkpoint")}),
    "bootstapir_online": lambda **kw: CausalBootsTapirTracker(**{k: v for k, v in kw.items() if k in ("resolution", "device", "checkpoint")}),
    "tapnextpp_online": lambda **kw: TapNextPPTracker(**{k: v for k, v in kw.items() if k in ("resolution", "device", "checkpoint")}),
    "cotracker3_offline": lambda **kw: CoTracker3Tracker(variant="offline", **{k: v for k, v in kw.items() if k in ("allow_noncommercial", "device")}),
    "cotracker3_online": lambda **kw: CoTracker3Tracker(variant="online", **{k: v for k, v in kw.items() if k in ("allow_noncommercial", "device")}),
    "sam2.1_video": lambda **kw: Sam2ObjectTracker(**{k: v for k, v in kw.items() if k in ("variant", "device", "checkpoint", "max_frames")}),
}

INFOS: Dict[str, TrackerInfo] = {
    "bootstapir_offline": BootsTapirTracker.info,
    "bootstapir_online": CausalBootsTapirTracker.info,
    "tapnextpp_online": TapNextPPTracker.info,
    "cotracker3_offline": CoTracker3Tracker.info,
    "cotracker3_online": TrackerInfo(**{**CoTracker3Tracker.info.__dict__, "name": "cotracker3_online", "online": True}),
    "sam2.1_video": Sam2ObjectTracker.info,
}

FUTURE: List[Dict[str, Any]] = [
    {"name": "sam3", "repo": "https://github.com/facebookresearch/sam3", "license": "custom (SAM License)", "commercial_ok": None, "status": "not integrated: license review required"},
    {"name": "bootstapnext_jax", "repo": "https://github.com/google-deepmind/tapnet", "license": "Apache-2.0", "commercial_ok": True, "status": "JAX-only checkpoint; TAPNext++ torch used instead"},
]


def names() -> List[str]:
    return list(_FACTORIES)


def create(name: str, **kwargs):
    if name not in _FACTORIES:
        raise ModelUnavailable(f"unknown tracker {name}", reason="UNKNOWN_MODEL_ID")
    return _FACTORIES[name](**kwargs)


def describe(name: str, allow_noncommercial: bool = False, probe: bool = True) -> Dict[str, Any]:
    info = INFOS[name]
    d = {**info.__dict__}
    if probe:
        try:
            tracker = create(name, allow_noncommercial=allow_noncommercial)
            ok, why = tracker.available()
        except Exception as e:  # noqa: BLE001
            ok, why = False, str(e)
        d["available"] = bool(ok)
        d["availability_reason"] = why
    d["license_gate"] = (not info.commercial_ok) and not allow_noncommercial
    return d


def describe_all(allow_noncommercial: bool = False, probe: bool = True) -> Dict[str, Any]:
    return {"trackers": [describe(n, allow_noncommercial, probe) for n in names()], "future": FUTURE}


def commercial_ok(name: str) -> Optional[bool]:
    info = INFOS.get(name)
    return None if info is None else info.commercial_ok
