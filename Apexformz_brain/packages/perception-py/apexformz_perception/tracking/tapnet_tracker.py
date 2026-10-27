"""Google DeepMind TAPNet adapters (Apache-2.0, github.com/google-deepmind/tapnet).

Three models behind the Brain tracker interfaces:

* ``BootsTapirTracker``        offline BootsTAPIR v2 (``tapnet.torch.tapir_model.TAPIR``), whole clip in
                               one pass, ``retrospective=True``.
* ``CausalBootsTapirTracker``  online/causal BootsTAPIR (``use_casual_conv=True``) fed frame by frame
                               with a recurrent causal state, ``retrospective=False``.
* ``TapNextPPTracker``         TAPNext++ (CVPR 2026 Findings), recurrent online tracker via the repo's
                               ``TAPNextPP`` wrapper, ``retrospective=False``.

API facts (from the repo's torch colabs and ``tapnet/torch/tapir_model.py``):
  frames  -> uint8 [T,H,W,3] RGB resized to 256x256 (or 512), scaled to [-1,1] float, batch dim added.
  queries -> float [N,3] in (t, y, x) order, pixel coordinates of the resized frame, batch dim added.
  outputs -> ``tracks`` [B,N,T,2] as (x, y) pixels of the resized frame; ``occlusion`` and
             ``expected_dist`` logits [B,N,T]; visible = (1-sigmoid(occ))*(1-sigmoid(dist)) > 0.5.
  online  -> ``get_feature_grids`` + ``get_query_features`` once; per frame ``estimate_trajectories``
             with ``causal_context`` from ``construct_initial_causal_state(num_points, num_resolutions)``.
"""
from __future__ import annotations

import time
from typing import List, Optional, Sequence, Tuple

import numpy as np

from apexformz_contracts.models import Track, TrackPoint, TrackSet

from .base import (
    FramesLike, ModelUnavailable, OnlineTracker, PointTracker, Query, TrackerInfo, ensure_checkpoint, iter_frames,
    make_trackset, points_to_track, provenance,
)

BOOTSTAPIR_URL = "https://storage.googleapis.com/dm-tapnet/bootstap/bootstapir_checkpoint_v2.pt"
CAUSAL_BOOTSTAPIR_URL = "https://storage.googleapis.com/dm-tapnet/bootstap/causal_bootstapir_checkpoint.pt"
TAPNEXTPP_256_URL = "https://storage.googleapis.com/dm-tapnet/tapnextpp/tapnextpp_ckpt.pt"
TAPNEXTPP_512_URL = "https://storage.googleapis.com/gresearch/tapnextpp/tapnextpp_512.ckpt"

REPO = "https://github.com/google-deepmind/tapnet"
LICENSE = "Apache-2.0"


def _torch():
    try:
        import torch  # noqa: WPS433
    except ImportError as e:  # pragma: no cover
        raise ModelUnavailable("torch is not installed") from e
    return torch


def _device(prefer: Optional[str]) -> str:
    torch = _torch()
    if prefer:
        return prefer
    return "cuda" if torch.cuda.is_available() else "cpu"


def _resize_rgb(frames: Sequence[np.ndarray], size: int) -> np.ndarray:
    import cv2

    out = np.empty((len(frames), size, size, 3), dtype=np.uint8)
    for i, f in enumerate(frames):
        rgb = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
        out[i] = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA)
    return out


def _tapir_available() -> Tuple[bool, str]:
    try:
        import torch  # noqa: F401
        from tapnet.torch import tapir_model  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return False, f"tapnet torch modules not importable: {e}"
    return True, "ok"


class BootsTapirTracker(PointTracker):
    """Offline BootsTAPIR v2 (best accuracy of the TAPIR family; whole clip per call)."""

    info = TrackerInfo(
        name="bootstapir_offline", kind="point", repo=REPO, license=LICENSE, commercial_ok=True, online=False,
        description="BootsTAPIR v2 offline point tracker (TAPIR + bootstrapped training).",
        checkpoint_urls=[BOOTSTAPIR_URL],
        notes=["Best at 512x512 according to the repo; 256 default here for speed/memory."],
    )

    def __init__(self, resolution: int = 256, device: Optional[str] = None, checkpoint: Optional[str] = None):
        self.resolution = resolution
        self.device_pref = device
        self.checkpoint = checkpoint
        self._model = None
        self._ckpt_path = None

    def available(self) -> Tuple[bool, str]:
        return _tapir_available()

    def _load(self):
        if self._model is not None:
            return self._model
        ok, why = self.available()
        if not ok:
            raise ModelUnavailable(why)
        torch = _torch()
        from tapnet.torch import tapir_model

        self._ckpt_path = ensure_checkpoint(BOOTSTAPIR_URL) if self.checkpoint is None else __import__("pathlib").Path(self.checkpoint)
        model = tapir_model.TAPIR(pyramid_level=1)
        model.load_state_dict(torch.load(str(self._ckpt_path), map_location="cpu"))
        self.device = _device(self.device_pref)
        model = model.to(self.device).eval()
        self._model = model
        return model

    def track(self, frames: FramesLike, queries: Sequence[Query], *, fps: Optional[float] = None, video_ref: Optional[str] = None, labels: Optional[Sequence[Optional[str]]] = None) -> TrackSet:
        torch = _torch()
        model = self._load()
        frame_list, read_fps = iter_frames(frames)
        if not frame_list:
            raise ValueError("no frames")
        H, W = frame_list[0].shape[:2]
        res = self.resolution
        video = _resize_rgb(frame_list, res)
        q = np.array([[float(t), y * res, x * res] for (t, x, y) in queries], dtype=np.float32)  # (t, y, x) pixels
        t0 = time.perf_counter()
        with torch.no_grad():
            v = torch.from_numpy(video).to(self.device).float() / 255.0 * 2.0 - 1.0
            out = model(v[None], torch.from_numpy(q).to(self.device)[None])
            tracks = out["tracks"][0].float().cpu().numpy()  # [N, T, 2] x,y in resized pixels
            occ = out["occlusion"][0].float()
            dist = out["expected_dist"][0].float()
            vis_prob = ((1 - torch.sigmoid(occ)) * (1 - torch.sigmoid(dist))).cpu().numpy()
        elapsed = time.perf_counter() - t0
        T = len(frame_list)
        ts = None if (fps or read_fps) is None else [i * 1000.0 / float(fps or read_fps) for i in range(T)]
        tracks_norm = tracks / float(res)
        out_tracks: List[Track] = []
        for n, qry in enumerate(queries):
            out_tracks.append(points_to_track(
                f"tapir-{n}", tracks_norm[n], vis_prob[n] > 0.5, vis_prob[n], ts,
                label=(labels[n] if labels and n < len(labels) else None), query=qry,
            ))
        return make_trackset(
            source=provenance("google-deepmind/tapnet:bootstapir", "v2", self._ckpt_path, self.device),
            kind="point", tracks=out_tracks, frame_count=T, image_size=(W, H), fps=fps or read_fps, retrospective=True,
            video_ref=video_ref,
            notes=[f"resolution={res}", f"inference_s={elapsed:.3f}", f"fps_equivalent={T / max(elapsed, 1e-6):.1f}"],
        )


class CausalBootsTapirTracker(OnlineTracker):
    """Online BootsTAPIR: causal convolutions, recurrent causal state, one frame per step."""

    info = TrackerInfo(
        name="bootstapir_online", kind="point", repo=REPO, license=LICENSE, commercial_ok=True, online=True,
        description="Causal BootsTAPIR for live point tracking (frame-by-frame with causal context).",
        checkpoint_urls=[CAUSAL_BOOTSTAPIR_URL],
    )

    def __init__(self, resolution: int = 256, device: Optional[str] = None, checkpoint: Optional[str] = None):
        self.resolution = resolution
        self.device_pref = device
        self.checkpoint = checkpoint
        self._model = None
        self._ckpt_path = None
        self._reset_state()

    def _reset_state(self):
        self._query_features = None
        self._causal_state = None
        self._queries: List[Tuple[float, float]] = []
        self._frames_seen = 0
        self._collected: List[List[TrackPoint]] = []
        self._image_size: Tuple[int, int] = (0, 0)
        self._labels: Optional[Sequence[Optional[str]]] = None
        self._step_times: List[float] = []

    def available(self) -> Tuple[bool, str]:
        return _tapir_available()

    def _load(self):
        if self._model is not None:
            return self._model
        ok, why = self.available()
        if not ok:
            raise ModelUnavailable(why)
        torch = _torch()
        from tapnet.torch import tapir_model

        self._ckpt_path = ensure_checkpoint(CAUSAL_BOOTSTAPIR_URL) if self.checkpoint is None else __import__("pathlib").Path(self.checkpoint)
        model = tapir_model.TAPIR(pyramid_level=1, use_casual_conv=True)
        model.load_state_dict(torch.load(str(self._ckpt_path), map_location="cpu"))
        self.device = _device(self.device_pref)
        self._model = model.to(self.device).eval()
        return self._model

    def _prep(self, frame: np.ndarray):
        torch = _torch()
        rgb = _resize_rgb([frame], self.resolution)
        v = torch.from_numpy(rgb).to(self.device).float() / 255.0 * 2.0 - 1.0
        return v[None]  # [1, 1, H, W, 3]

    def start(self, first_frame: np.ndarray, queries_xy_norm: Sequence[Tuple[float, float]], labels: Optional[Sequence[Optional[str]]] = None) -> List[TrackPoint]:
        torch = _torch()
        model = self._load()
        self._reset_state()
        self._labels = labels
        H, W = first_frame.shape[:2]
        self._image_size = (W, H)
        self._queries = [(float(x), float(y)) for x, y in queries_xy_norm]
        res = self.resolution
        q = torch.tensor([[0.0, y * res, x * res] for (x, y) in self._queries], dtype=torch.float32, device=self.device)[None]
        with torch.no_grad():
            frames = self._prep(first_frame)
            grids = model.get_feature_grids(frames, is_training=False)
            self._query_features = model.get_query_features(frames, is_training=False, query_points=q, feature_grids=grids)
            self._causal_state = model.construct_initial_causal_state(len(self._queries), len(self._query_features.resolutions) - 1)
            for i in range(len(self._causal_state)):
                for k, v in self._causal_state[i].items():
                    self._causal_state[i][k] = v.to(self.device)
        return self.step(first_frame)

    def step(self, frame: np.ndarray) -> List[TrackPoint]:
        torch = _torch()
        if self._query_features is None:
            raise RuntimeError("call start() first")
        model = self._model
        t0 = time.perf_counter()
        with torch.no_grad():
            frames = self._prep(frame)
            grids = model.get_feature_grids(frames, is_training=False)
            traj = model.estimate_trajectories(
                frames.shape[-3:-1], is_training=False, feature_grids=grids, query_features=self._query_features,
                query_points_in_video=None, query_chunk_size=64, causal_context=self._causal_state, get_causal_context=True,
            )
            self._causal_state = traj["causal_context"]
            tracks = traj["tracks"][-1][0, :, 0].float().cpu().numpy()  # [N, 2] x,y resized px
            occ = traj["occlusion"][-1][0, :, 0].float()
            dist = traj["expected_dist"][-1][0, :, 0].float()
            vis = ((1 - torch.sigmoid(occ)) * (1 - torch.sigmoid(dist))).cpu().numpy()
        self._step_times.append(time.perf_counter() - t0)
        pts = []
        for n in range(len(self._queries)):
            x, y = float(tracks[n, 0] / self.resolution), float(tracks[n, 1] / self.resolution)
            pts.append(TrackPoint(frame_id=self._frames_seen, timestamp_ms=None, x=min(max(x, -0.5), 1.5), y=min(max(y, -0.5), 1.5), visible=bool(vis[n] > 0.5), confidence=float(np.clip(vis[n], 0, 1))))
        self._collected.append(pts)
        self._frames_seen += 1
        return pts

    def finish(self, fps: Optional[float] = None, video_ref: Optional[str] = None) -> TrackSet:
        tracks: List[Track] = []
        for n, (qx, qy) in enumerate(self._queries):
            pts = [row[n] for row in self._collected]
            if fps:
                pts = [p.model_copy(update={"timestamp_ms": p.frame_id * 1000.0 / fps}) for p in pts]
            tracks.append(Track(track_id=f"causal-tapir-{n}", label=(self._labels[n] if self._labels and n < len(self._labels) else None), query={"frame_id": 0, "x": qx, "y": qy}, points=pts))
        mean_step = float(np.mean(self._step_times)) if self._step_times else 0.0
        return make_trackset(
            source=provenance("google-deepmind/tapnet:causal_bootstapir", "v1", self._ckpt_path, getattr(self, "device", None)),
            kind="point", tracks=tracks, frame_count=self._frames_seen, image_size=self._image_size, fps=fps, retrospective=False,
            video_ref=video_ref, notes=[f"resolution={self.resolution}", f"mean_step_s={mean_step:.4f}", f"online_fps={1.0 / max(mean_step, 1e-6):.1f}"],
        )

    def track_clip(self, frames: FramesLike, queries: Sequence[Query], *, fps: Optional[float] = None, video_ref: Optional[str] = None, labels: Optional[Sequence[Optional[str]]] = None) -> TrackSet:
        """Convenience: run the online tracker over a whole clip (queries must be on frame 0)."""
        frame_list, read_fps = iter_frames(frames)
        if any(int(q[0]) != 0 for q in queries):
            raise ValueError("online trackers only accept queries on the first frame")
        self.start(frame_list[0], [(x, y) for (_, x, y) in queries], labels=labels)
        for f in frame_list[1:]:
            self.step(f)
        return self.finish(fps=fps or read_fps, video_ref=video_ref)


class TapNextPPTracker(OnlineTracker):
    """TAPNext++ recurrent online tracker through the repo's ``TAPNextPP`` wrapper (BGR in, display px out)."""

    info = TrackerInfo(
        name="tapnextpp_online", kind="point", repo=REPO, license=LICENSE, commercial_ok=True, online=True,
        description="TAPNext++ (tracking as next-token prediction), strictly causal per-frame tracker.",
        checkpoint_urls=[TAPNEXTPP_256_URL, TAPNEXTPP_512_URL],
        notes=["256 checkpoint is 2.5 GB (training checkpoint with extra state); the 512 checkpoint is lighter."],
    )

    def __init__(self, resolution: int = 256, device: Optional[str] = None, checkpoint: Optional[str] = None):
        self.resolution = resolution
        self.device_pref = device
        self.checkpoint = checkpoint
        self._model = None
        self._ckpt_path = None
        self._reset()

    def _reset(self):
        self._state = None
        self._collected: List[List[TrackPoint]] = []
        self._queries: List[Tuple[float, float]] = []
        self._frames_seen = 0
        self._image_size = (0, 0)
        self._labels = None
        self._step_times: List[float] = []

    def available(self) -> Tuple[bool, str]:
        try:
            import torch  # noqa: F401
            from tapnet.tapnextpp.votsp2026.model import TAPNextPP  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return False, f"TAPNext++ torch wrapper not importable: {e}"
        return True, "ok"

    def _load(self):
        if self._model is not None:
            return self._model
        ok, why = self.available()
        if not ok:
            raise ModelUnavailable(why)
        from tapnet.tapnextpp.votsp2026.model import TAPNextPP

        url = TAPNEXTPP_512_URL if self.resolution == 512 else TAPNEXTPP_256_URL
        self._ckpt_path = ensure_checkpoint(url) if self.checkpoint is None else __import__("pathlib").Path(self.checkpoint)
        self.device = _device(self.device_pref)
        self._model = TAPNextPP.from_checkpoint(str(self._ckpt_path), device=self.device, input_resolution=self.resolution)
        return self._model

    def start(self, first_frame: np.ndarray, queries_xy_norm: Sequence[Tuple[float, float]], labels: Optional[Sequence[Optional[str]]] = None) -> List[TrackPoint]:
        model = self._load()
        self._reset()
        self._labels = labels
        H, W = first_frame.shape[:2]
        self._image_size = (W, H)
        self._queries = [(float(x), float(y)) for x, y in queries_xy_norm]
        q = np.array([[x * W, y * H] for (x, y) in self._queries], dtype=np.float32)
        t0 = time.perf_counter()
        pos, vis, self._state = model.track_frame(first_frame, query_points_xy=q)
        self._step_times.append(time.perf_counter() - t0)
        return self._emit(pos, vis)

    def step(self, frame: np.ndarray) -> List[TrackPoint]:
        if self._state is None:
            raise RuntimeError("call start() first")
        t0 = time.perf_counter()
        pos, vis, self._state = self._model.track_frame(frame, state=self._state)
        self._step_times.append(time.perf_counter() - t0)
        return self._emit(pos, vis)

    def _emit(self, pos: np.ndarray, vis: np.ndarray) -> List[TrackPoint]:
        W, H = self._image_size
        pts = [TrackPoint(frame_id=self._frames_seen, timestamp_ms=None, x=float(np.clip(pos[n, 0] / W, -0.5, 1.5)), y=float(np.clip(pos[n, 1] / H, -0.5, 1.5)), visible=bool(vis[n]), confidence=1.0 if vis[n] else 0.0) for n in range(len(self._queries))]
        self._collected.append(pts)
        self._frames_seen += 1
        return pts

    def finish(self, fps: Optional[float] = None, video_ref: Optional[str] = None) -> TrackSet:
        tracks = []
        for n, (qx, qy) in enumerate(self._queries):
            pts = [row[n] for row in self._collected]
            if fps:
                pts = [p.model_copy(update={"timestamp_ms": p.frame_id * 1000.0 / fps}) for p in pts]
            tracks.append(Track(track_id=f"tapnextpp-{n}", label=(self._labels[n] if self._labels and n < len(self._labels) else None), query={"frame_id": 0, "x": qx, "y": qy}, points=pts))
        mean_step = float(np.mean(self._step_times)) if self._step_times else 0.0
        return make_trackset(
            source=provenance("google-deepmind/tapnet:tapnextpp", f"{self.resolution}", self._ckpt_path, getattr(self, "device", None)),
            kind="point", tracks=tracks, frame_count=self._frames_seen, image_size=self._image_size, fps=fps, retrospective=False,
            video_ref=video_ref, notes=[f"resolution={self.resolution}", f"mean_step_s={mean_step:.4f}", f"online_fps={1.0 / max(mean_step, 1e-6):.1f}"],
        )

    def track_clip(self, frames: FramesLike, queries: Sequence[Query], *, fps: Optional[float] = None, video_ref: Optional[str] = None, labels: Optional[Sequence[Optional[str]]] = None) -> TrackSet:
        frame_list, read_fps = iter_frames(frames)
        if any(int(q[0]) != 0 for q in queries):
            raise ValueError("online trackers only accept queries on the first frame")
        self.start(frame_list[0], [(x, y) for (_, x, y) in queries], labels=labels)
        for f in frame_list[1:]:
            self.step(f)
        return self.finish(fps=fps or read_fps, video_ref=video_ref)
