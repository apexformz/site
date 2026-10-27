"""Tracker interfaces (sport-agnostic).

Every tracker emits the ``TrackSet`` contract (``packages/contracts/schemas/track_set.schema.json``):
image_normalized coordinates in [0, 1], per-frame ``visible`` and ``confidence``, model
provenance, and ``retrospective=True`` for offline models (only genuinely causal models may
claim ``retrospective=False``). Nothing here knows about sports or equipment classes; callers
pass generic labels.
"""
from __future__ import annotations

import hashlib
import os
import pathlib
from dataclasses import dataclass, field
from typing import Iterable, List, Optional, Sequence, Tuple, Union

import numpy as np

from apexformz_contracts.models import ModelProvenance, Track, TrackPoint, TrackQuery, TrackSet

CONTRACT_VERSION = "1.0.0"

Query = Tuple[int, float, float]  # (frame_id, x_norm, y_norm)
FramesLike = Union[Sequence[np.ndarray], str, os.PathLike]


class ModelUnavailable(RuntimeError):
    """Raised when a tracker's weights, dependencies or license gate make it unusable.

    Maps to the contract error code ``MODEL_UNAVAILABLE``; callers must abstain, never fall back silently.
    """

    code = "MODEL_UNAVAILABLE"

    def __init__(self, message: str, reason: str = "MODEL_UNAVAILABLE"):
        super().__init__(message)
        self.reason = reason


def model_cache_dir() -> pathlib.Path:
    root = pathlib.Path(os.environ.get("APEXFORMZ_MODEL_CACHE", pathlib.Path.home() / ".cache" / "apexformz"))
    (root / "checkpoints").mkdir(parents=True, exist_ok=True)
    return root


def sha256_file(path: pathlib.Path, max_bytes: Optional[int] = None) -> str:
    """Streaming sha256 of a checkpoint (``max_bytes`` caps very large files; digest is then prefixed)."""
    h = hashlib.sha256()
    read = 0
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(1 << 22)
            if not chunk:
                break
            h.update(chunk)
            read += len(chunk)
            if max_bytes is not None and read >= max_bytes:
                return "partial-" + h.hexdigest()
    return h.hexdigest()


def ensure_checkpoint(url: str, filename: Optional[str] = None, expected_min_bytes: int = 1_000_000) -> pathlib.Path:
    """Download ``url`` into the model cache once; returns the local path or raises ModelUnavailable."""
    import urllib.request

    dest = model_cache_dir() / "checkpoints" / (filename or url.rsplit("/", 1)[-1])
    if dest.exists() and dest.stat().st_size >= expected_min_bytes:
        return dest
    if os.environ.get("APEXFORMZ_OFFLINE") == "1":
        raise ModelUnavailable(f"checkpoint missing and APEXFORMZ_OFFLINE=1: {dest}")
    try:
        urllib.request.urlretrieve(url, dest)  # noqa: S310 - fixed https URLs from the registry
    except Exception as e:  # noqa: BLE001
        raise ModelUnavailable(f"could not download {url}: {e}") from e
    if dest.stat().st_size < expected_min_bytes:
        dest.unlink(missing_ok=True)
        raise ModelUnavailable(f"download of {url} is truncated")
    return dest


@dataclass
class TrackerInfo:
    """Registry record: provenance and license gate for one tracker implementation."""

    name: str
    kind: str  # "point" | "object"
    repo: str
    license: str
    commercial_ok: bool
    online: bool
    description: str
    checkpoint_urls: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)


def provenance(model_id: str, version: str, checkpoint: Optional[pathlib.Path] = None, delegate: Optional[str] = None) -> ModelProvenance:
    """Model provenance; ``digest`` (sha256 of at most the first 64 MiB of the checkpoint) and ``delegate``
    are only set when known, because the schema types them as strings."""
    fields = {"model_id": model_id, "version": version}
    if delegate:
        fields["delegate"] = delegate
    if checkpoint is not None and pathlib.Path(checkpoint).exists():
        fields["digest"] = sha256_file(pathlib.Path(checkpoint), max_bytes=64 << 20)
    return ModelProvenance(**fields)


def trackset_dict(ts: TrackSet) -> dict:
    """Schema-valid JSON dict for a TrackSet (optional fields omitted instead of null where the schema types them)."""
    return ts.model_dump(exclude_none=True)


def make_trackset(
    *,
    source: ModelProvenance,
    kind: str,
    tracks: List[Track],
    frame_count: int,
    image_size: Tuple[int, int],
    fps: Optional[float],
    retrospective: bool,
    video_ref: Optional[str] = None,
    session_id: Optional[str] = None,
    notes: Optional[List[str]] = None,
) -> TrackSet:
    return TrackSet(
        schema_version=CONTRACT_VERSION,
        session_id=session_id,
        video_ref=video_ref,
        source=source,
        kind=kind,  # type: ignore[arg-type]
        coordinate_system="image_normalized",
        image_size=[int(image_size[0]), int(image_size[1])],
        frame_count=int(frame_count),
        fps=fps,
        tracks=tracks,
        retrospective=retrospective,
        notes=notes or [],
    )


def points_to_track(
    track_id: str,
    xy_norm: np.ndarray,
    visible: np.ndarray,
    confidence: Optional[np.ndarray],
    timestamps_ms: Optional[Sequence[Optional[float]]] = None,
    label: Optional[str] = None,
    query: Optional[Query] = None,
    bboxes: Optional[np.ndarray] = None,
    first_frame_id: int = 0,
) -> Track:
    """Build a Track from per-frame arrays (``xy_norm`` [T,2], ``visible`` [T], ``confidence`` [T])."""
    pts: List[TrackPoint] = []
    T = int(xy_norm.shape[0])
    for t in range(T):
        x = float(np.clip(xy_norm[t, 0], -0.5, 1.5))
        y = float(np.clip(xy_norm[t, 1], -0.5, 1.5))
        conf = None if confidence is None else float(np.clip(confidence[t], 0.0, 1.0))
        bbox = None
        if bboxes is not None and bboxes[t] is not None and np.all(np.isfinite(bboxes[t])):
            bbox = [float(v) for v in bboxes[t]]
        pts.append(TrackPoint(
            frame_id=first_frame_id + t,
            timestamp_ms=None if timestamps_ms is None else timestamps_ms[t],
            x=x if np.isfinite(x) else 0.0,
            y=y if np.isfinite(y) else 0.0,
            visible=bool(visible[t]) and bool(np.isfinite(xy_norm[t]).all()),
            confidence=conf,
            bbox=bbox,
        ))
    return Track(
        track_id=track_id,
        label=label,
        assigned_subject_id=None,
        query=None if query is None else TrackQuery(frame_id=int(query[0]), x=float(query[1]), y=float(query[2])),
        points=pts,
    )


class PointTracker:
    """Offline (whole-clip) point tracker interface."""

    info: TrackerInfo

    def available(self) -> Tuple[bool, str]:
        """(is_available, reason). Never raises."""
        raise NotImplementedError

    def track(self, frames: FramesLike, queries: Sequence[Query], *, fps: Optional[float] = None, video_ref: Optional[str] = None, labels: Optional[Sequence[Optional[str]]] = None) -> TrackSet:
        raise NotImplementedError


class OnlineTracker:
    """Causal, frame-by-frame point tracker interface (``retrospective=False``)."""

    info: TrackerInfo

    def available(self) -> Tuple[bool, str]:
        raise NotImplementedError

    def start(self, first_frame: np.ndarray, queries_xy_norm: Sequence[Tuple[float, float]]) -> List[TrackPoint]:
        raise NotImplementedError

    def step(self, frame: np.ndarray) -> List[TrackPoint]:
        raise NotImplementedError

    def finish(self) -> TrackSet:
        raise NotImplementedError


@dataclass
class ObjectPrompt:
    """Prompt on one frame: a box (x0,y0,x1,y1 normalized) and/or positive points (normalized)."""

    frame_id: int
    label: str
    box: Optional[Tuple[float, float, float, float]] = None
    points: Optional[List[Tuple[float, float]]] = None


class ObjectTracker:
    """Prompted object (mask) tracker interface; emits kind='object' TrackSets with per-frame centroid + bbox."""

    info: TrackerInfo

    def available(self) -> Tuple[bool, str]:
        raise NotImplementedError

    def track(self, frames: FramesLike, prompts: Sequence[ObjectPrompt], *, fps: Optional[float] = None, video_ref: Optional[str] = None) -> TrackSet:
        raise NotImplementedError


def iter_frames(frames: FramesLike) -> Tuple[List[np.ndarray], Optional[float]]:
    """Materialise frames (BGR uint8) from a list or a video path. Returns (frames, fps)."""
    if isinstance(frames, (str, os.PathLike)):
        from ._video import read_video

        return read_video(str(frames))
    out = [np.ascontiguousarray(f) for f in frames]
    return out, None
