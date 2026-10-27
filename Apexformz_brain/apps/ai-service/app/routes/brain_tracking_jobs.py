"""Tracking jobs (TRD 02 equipment adapters / TRD 12 annotation propagation): point and object
tracking over consented clips with the open-source trackers in ``apexformz_perception.tracking``.

QUEUED -> RUNNING -> COMPLETED | FAILED, 202 + polling, idempotent by job_id, like brain_jobs.py.
Non-commercial trackers (CoTracker3, CC-BY-NC) are refused unless the request sets
``allow_noncommercial=true`` (logged as a warning); the registry endpoint exposes the license gate.
"""
from __future__ import annotations

import logging
import os
import pathlib
import threading
import time
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, BackgroundTasks, HTTPException, Response
from pydantic import BaseModel, Field

log = logging.getLogger("apexformz.tracking")
router = APIRouter(prefix="/v1/tracking", tags=["Tracking"])

CONSENT_SCOPES = {"deep_analysis", "quality_improvement"}
_JOBS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()
MAX_FRAMES = int(os.environ.get("APEXFORMZ_TRACKING_MAX_FRAMES", "600"))


class PointQuery(BaseModel):
    frame_id: int = Field(ge=0)
    x: float = Field(ge=0.0, le=1.0)
    y: float = Field(ge=0.0, le=1.0)
    label: Optional[str] = None


class BoxPrompt(BaseModel):
    frame_id: int = Field(ge=0)
    label: str = Field(min_length=1)
    box: Optional[Tuple[float, float, float, float]] = None
    points: Optional[List[Tuple[float, float]]] = None


class TrackingJobRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    kind: Literal["point_track", "object_track"]
    consent_scope: str
    tracker: str = "bootstapir_offline"
    video_ref: Optional[str] = None
    video_path: Optional[str] = None
    frames_b64: Optional[List[str]] = None  # optional small payload path for tests/tools (JPEG/PNG base64)
    queries: Optional[List[PointQuery]] = None
    prompts: Optional[List[BoxPrompt]] = None
    allow_noncommercial: bool = False
    max_frames: Optional[int] = Field(default=None, ge=1, le=MAX_FRAMES)
    stride: int = Field(default=1, ge=1, le=10)
    resolution: Optional[int] = None
    device: Optional[str] = None
    session_id: Optional[str] = None


def _set(job_id: str, **fields):
    with _LOCK:
        _JOBS[job_id].update(fields)


def _decode_frames(req: TrackingJobRequest):
    import numpy as np

    if req.frames_b64:
        import base64

        import cv2

        frames = []
        for s in req.frames_b64:
            buf = np.frombuffer(base64.b64decode(s), dtype=np.uint8)
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if img is None:
                raise ValueError("frames_b64 contains an undecodable image")
            frames.append(img)
        return frames[: req.max_frames or MAX_FRAMES], None
    if req.video_path:
        from apexformz_perception.tracking._video import read_video

        p = pathlib.Path(req.video_path)
        root = os.environ.get("APEXFORMZ_MEDIA_ROOT")
        if root and not str(p.resolve()).startswith(str(pathlib.Path(root).resolve())):
            raise PermissionError("video_path outside APEXFORMZ_MEDIA_ROOT")
        if not p.exists():
            raise FileNotFoundError(str(p))
        return read_video(str(p), max_frames=req.max_frames or MAX_FRAMES, stride=req.stride)
    raise ValueError("video_path or frames_b64 required (asset_ref decoding is not available in this service)")


def _run(req: TrackingJobRequest):
    from apexformz_perception.tracking import ModelUnavailable, ObjectPrompt, registry

    _set(req.job_id, status="RUNNING", started_at=time.time())
    try:
        frames, fps = _decode_frames(req)
        kwargs: Dict[str, Any] = {"allow_noncommercial": req.allow_noncommercial}
        if req.resolution:
            kwargs["resolution"] = req.resolution
        if req.device:
            kwargs["device"] = req.device
        tracker = registry.create(req.tracker, **kwargs)
        ok, why = tracker.available()
        if not ok:
            raise ModelUnavailable(why, reason="LICENSE_GATE" if "LICENSE_GATE" in why else "MODEL_UNAVAILABLE")
        if req.kind == "point_track":
            qs = [(q.frame_id, q.x, q.y) for q in (req.queries or [])]
            labels = [q.label for q in (req.queries or [])]
            if hasattr(tracker, "track_clip"):
                ts = tracker.track_clip(frames, qs, fps=fps, video_ref=req.video_ref, labels=labels)
            else:
                ts = tracker.track(frames, qs, fps=fps, video_ref=req.video_ref, labels=labels)
        else:
            prompts = [ObjectPrompt(frame_id=p.frame_id, label=p.label, box=p.box, points=p.points) for p in (req.prompts or [])]
            ts = tracker.track(frames, prompts, fps=fps, video_ref=req.video_ref)
        if req.session_id:
            ts.session_id = req.session_id
        from apexformz_perception.tracking import trackset_dict

        out = trackset_dict(ts)
        _set(req.job_id, status="COMPLETED", output=out, finished_at=time.time(), error=None, frame_count=len(frames))
    except ModelUnavailable as e:
        _set(req.job_id, status="FAILED", error={"code": e.reason, "message": str(e), "retryable": False}, finished_at=time.time())
    except (FileNotFoundError, PermissionError, ValueError) as e:
        _set(req.job_id, status="FAILED", error={"code": "SCHEMA_INVALID", "message": str(e), "retryable": False}, finished_at=time.time())
    except Exception as e:  # noqa: BLE001
        log.exception("tracking job %s failed", req.job_id)
        _set(req.job_id, status="FAILED", error={"code": "INTERNAL", "message": str(e), "retryable": True}, finished_at=time.time())


@router.get("/trackers")
def trackers(allow_noncommercial: bool = False, probe: bool = True):
    from apexformz_perception.tracking import registry

    return registry.describe_all(allow_noncommercial=allow_noncommercial, probe=probe)


@router.post("/jobs", status_code=202)
def create_job(req: TrackingJobRequest, background: BackgroundTasks, response: Response):
    from apexformz_perception.tracking import registry

    if req.consent_scope not in CONSENT_SCOPES:
        raise HTTPException(status_code=422, detail={"code": "CONSENT_REQUIRED", "message": f"consent_scope must be one of {sorted(CONSENT_SCOPES)}"})
    if req.tracker not in registry.names():
        raise HTTPException(status_code=422, detail={"code": "UNKNOWN_MODEL_ID", "message": f"unknown tracker {req.tracker}; see GET /v1/tracking/trackers"})
    if req.kind == "point_track" and not req.queries:
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": "point_track requires queries"})
    if req.kind == "object_track" and not req.prompts:
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": "object_track requires prompts"})
    if req.kind == "object_track" and registry.INFOS[req.tracker].kind != "object":
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": f"{req.tracker} is not an object tracker"})
    if req.kind == "point_track" and registry.INFOS[req.tracker].kind != "point":
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": f"{req.tracker} is not a point tracker"})
    if not req.video_path and not req.frames_b64:
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": "video_path or frames_b64 required"})
    if registry.commercial_ok(req.tracker) is False:
        if not req.allow_noncommercial:
            raise HTTPException(status_code=403, detail={"code": "LICENSE_GATE", "message": f"{req.tracker} is licensed for non-commercial use only; set allow_noncommercial=true for research use"})
        log.warning("job %s uses non-commercial tracker %s (allow_noncommercial=true)", req.job_id, req.tracker)
    with _LOCK:
        existing = _JOBS.get(req.job_id)
        if existing:
            response.headers["Retry-After"] = "2"
            return {"job_id": req.job_id, "status": existing["status"], "idempotent": True, "retry_after_s": 2}
        _JOBS[req.job_id] = {"job_id": req.job_id, "status": "QUEUED", "kind": req.kind, "tracker": req.tracker, "consent_scope": req.consent_scope,
                             "created_at": time.time(), "output": None, "error": None}
    background.add_task(_run, req)
    response.headers["Retry-After"] = "2"
    return {"job_id": req.job_id, "status": "QUEUED", "retry_after_s": 2}


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "UNKNOWN_JOB", "message": job_id})
    return job
