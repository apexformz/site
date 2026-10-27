"""Meta CoTracker3 adapter (github.com/facebookresearch/co-tracker).

LICENSE: CC-BY-NC 4.0 (non-commercial). ``commercial_ok=False``; the adapter refuses to run unless
``allow_noncommercial=True`` is passed explicitly, and the registry exposes the flag so the service
can gate jobs. Loaded through ``torch.hub`` (``cotracker3_offline`` / ``cotracker3_online``).

API facts (repo README + hubconf):
  video   -> float tensor [B, T, 3, H, W] in 0..255 (no normalisation by the caller).
  queries -> float tensor [B, N, 3] as (t, x, y) in pixels of the given frames.
  offline -> ``pred_tracks [B,T,N,2]``, ``pred_visibility [B,T,N]`` (bool/float).
  online  -> ``model(video_chunk, is_first_step=True, queries=...)`` then
             ``model(video_chunk=video[:, ind:ind+step*2])`` every ``model.step`` frames.
"""
from __future__ import annotations

import time
from typing import List, Optional, Sequence, Tuple

import numpy as np

from apexformz_contracts.models import Track, TrackSet

from .base import FramesLike, ModelUnavailable, PointTracker, Query, TrackerInfo, iter_frames, make_trackset, points_to_track, provenance

REPO = "https://github.com/facebookresearch/co-tracker"
LICENSE = "CC-BY-NC-4.0"


class CoTracker3Tracker(PointTracker):
    info = TrackerInfo(
        name="cotracker3_offline", kind="point", repo=REPO, license=LICENSE, commercial_ok=False, online=False,
        description="Meta CoTracker3 offline point tracker via torch.hub (non-commercial license).",
        checkpoint_urls=["https://huggingface.co/facebook/cotracker3/resolve/main/scaled_offline.pth"],
        notes=["Requires allow_noncommercial=True; research/evaluation use only until legal review."],
    )

    def __init__(self, allow_noncommercial: bool = False, device: Optional[str] = None, variant: str = "offline", max_side: int = 512):
        self.allow_noncommercial = allow_noncommercial
        self.device_pref = device
        self.variant = variant
        self.max_side = max_side
        self._model = None
        if variant == "online":
            self.info = TrackerInfo(**{**self.info.__dict__, "name": "cotracker3_online", "online": True,
                                       "checkpoint_urls": ["https://huggingface.co/facebook/cotracker3/resolve/main/scaled_online.pth"],
                                       "description": "Meta CoTracker3 online (windowed) point tracker via torch.hub (non-commercial license)."})

    def available(self) -> Tuple[bool, str]:
        if not self.allow_noncommercial:
            return False, "LICENSE_GATE: CoTracker3 is CC-BY-NC; pass allow_noncommercial=True for research use"
        try:
            import torch  # noqa: F401
        except ImportError as e:  # pragma: no cover
            return False, f"torch missing: {e}"
        return True, "ok"

    def _load(self):
        if self._model is not None:
            return self._model
        ok, why = self.available()
        if not ok:
            raise ModelUnavailable(why, reason="LICENSE_GATE" if why.startswith("LICENSE_GATE") else "MODEL_UNAVAILABLE")
        import torch

        try:
            model = torch.hub.load("facebookresearch/co-tracker", f"cotracker3_{self.variant}", trust_repo=True)
        except Exception as e:  # noqa: BLE001
            raise ModelUnavailable(f"torch.hub load failed: {e}") from e
        self.device = self.device_pref or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model = model.to(self.device).eval()
        return self._model

    def _hub_checkpoint(self):
        """torch.hub caches CoTracker3 weights under ~/.cache/torch/hub/checkpoints; used for provenance digests."""
        import pathlib

        import torch

        name = "scaled_online.pth" if self.variant == "online" else "scaled_offline.pth"
        p = pathlib.Path(torch.hub.get_dir()) / "checkpoints" / name
        return p if p.exists() else None

    def _downscale(self, frames: Sequence[np.ndarray]) -> Tuple[np.ndarray, float]:
        import cv2

        H, W = frames[0].shape[:2]
        scale = min(1.0, self.max_side / float(max(H, W)))
        nh, nw = int(round(H * scale)), int(round(W * scale))
        nh, nw = max(8, nh - nh % 8), max(8, nw - nw % 8)
        out = np.empty((len(frames), nh, nw, 3), dtype=np.uint8)
        for i, f in enumerate(frames):
            out[i] = cv2.resize(cv2.cvtColor(f, cv2.COLOR_BGR2RGB), (nw, nh), interpolation=cv2.INTER_AREA)
        return out, (nw / W, nh / H)

    def track(self, frames: FramesLike, queries: Sequence[Query], *, fps: Optional[float] = None, video_ref: Optional[str] = None, labels: Optional[Sequence[Optional[str]]] = None) -> TrackSet:
        import torch

        model = self._load()
        frame_list, read_fps = iter_frames(frames)
        H, W = frame_list[0].shape[:2]
        video_np, (sx, sy) = self._downscale(frame_list)
        T, nh, nw = video_np.shape[:3]
        video = torch.from_numpy(video_np).permute(0, 3, 1, 2)[None].float().to(self.device)  # B T C H W, 0..255
        q = torch.tensor([[float(t), x * W * sx, y * H * sy] for (t, x, y) in queries], dtype=torch.float32, device=self.device)[None]
        t0 = time.perf_counter()
        with torch.no_grad():
            if self.variant == "online":
                model(video_chunk=video, is_first_step=True, queries=q)
                tracks = vis = None
                step = model.step
                for ind in range(0, max(1, T - step), step):
                    tracks, vis = model(video_chunk=video[:, ind: ind + step * 2])
                if tracks is None:
                    tracks, vis = model(video_chunk=video)
            else:
                tracks, vis = model(video, queries=q)
        elapsed = time.perf_counter() - t0
        tr = tracks[0].float().cpu().numpy()  # [T', N, 2]
        vi = vis[0].float().cpu().numpy().reshape(tr.shape[0], tr.shape[1])
        Tp = tr.shape[0]
        ts = None if (fps or read_fps) is None else [i * 1000.0 / float(fps or read_fps) for i in range(Tp)]
        out: List[Track] = []
        for n, qry in enumerate(queries):
            xy = np.stack([tr[:, n, 0] / nw, tr[:, n, 1] / nh], axis=1)
            out.append(points_to_track(f"cotracker3-{n}", xy, vi[:, n] > 0.5, vi[:, n], ts, label=(labels[n] if labels and n < len(labels) else None), query=qry))
        return make_trackset(
            source=provenance(f"facebookresearch/co-tracker:cotracker3_{self.variant}", "3", self._hub_checkpoint(), self.device),
            kind="point", tracks=out, frame_count=Tp, image_size=(W, H), fps=fps or read_fps, retrospective=True,
            video_ref=video_ref, notes=["LICENSE: CC-BY-NC (non-commercial)", f"processing_size={nw}x{nh}", f"inference_s={elapsed:.3f}", f"fps_equivalent={Tp / max(elapsed, 1e-6):.1f}"],
        )
