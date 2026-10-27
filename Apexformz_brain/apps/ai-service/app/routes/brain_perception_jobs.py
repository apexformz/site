"""Perception jobs (TRD 02/12/13): video -> PoseFrame JSONL extraction and offline 2D->3D lifting.

Same lifecycle as brain_jobs: QUEUED -> RUNNING -> COMPLETED | FAILED, in-memory state,
consent_scope required, structured error codes, idempotent by job_id. Outputs are
written under APEXFORMZ_JOBS_DIR (default ./jobs) and referenced, never inlined raw.
"""
from __future__ import annotations

import logging
import os
import pathlib
import threading
import time
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Response
from pydantic import BaseModel, Field

log = logging.getLogger("apexformz.perception.jobs")
router = APIRouter(prefix="/v1/perception", tags=["Brain perception"])

CONSENT_SCOPES = {"deep_analysis", "quality_improvement"}
_JOBS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


class PerceptionError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def jobs_dir() -> pathlib.Path:
    d = pathlib.Path(os.environ.get("APEXFORMZ_JOBS_DIR", pathlib.Path.cwd() / "jobs"))
    d.mkdir(parents=True, exist_ok=True)
    return d


class PerceptionJobRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    kind: Literal["pose_extract", "lift_3d"]
    consent_scope: str
    session_id: str = Field(default="offline", min_length=1, max_length=128)
    # pose_extract
    video_path: Optional[str] = None
    asset_ref: Optional[str] = None
    backend: str = "mediapipe"
    backend_options: Dict[str, Any] = Field(default_factory=dict)
    max_frames: Optional[int] = Field(default=None, ge=1, le=100000)
    stride: int = Field(default=1, ge=1, le=30)
    mirror: bool = False
    canonical: bool = True
    # lift_3d
    pose_jsonl_path: Optional[str] = None
    lifter: str = "videopose3d"
    allow_noncommercial: bool = False


def _set(job_id: str, **fields):
    with _LOCK:
        _JOBS[job_id].update(fields)


def _run_pose_extract(req: PerceptionJobRequest) -> Dict[str, Any]:
    from apexformz_perception.io import write_jsonl
    from apexformz_perception.pose import ModelUnavailable, create_backend
    from apexformz_perception.pose.extract import extract_pose_sequence

    if not req.video_path:
        raise PerceptionError("MODEL_UNAVAILABLE", "asset_ref decoding is not available in this service; provide video_path")
    if not pathlib.Path(req.video_path).exists():
        raise PerceptionError("SCHEMA_INVALID", f"video not found: {req.video_path}")
    try:
        backend = create_backend(req.backend, **req.backend_options)
    except ModelUnavailable as e:
        raise PerceptionError("MODEL_UNAVAILABLE", str(e)) from e
    try:
        result = extract_pose_sequence(req.video_path, backend, req.session_id, camera_id="video", max_frames=req.max_frames,
                                       stride=req.stride, mirror=req.mirror, canonical=req.canonical)
    finally:
        backend.close()
    out = jobs_dir() / f"{req.job_id}.pose.jsonl"
    header = {"kind": "pose_frames", "provenance": result.provenance, "video": {k: v for k, v in result.video.items() if k != "path"}, "stats": result.stats}
    n = write_jsonl(out, result.frames, header=header)
    return {"output_ref": str(out), "frame_count": n, "provenance": result.provenance, "stats": result.stats,
            "landmark_set": result.frames[0]["landmark_set"] if result.frames else None, "retrospective": True}


def _run_lift_3d(req: PerceptionJobRequest) -> Dict[str, Any]:
    from apexformz_perception.io import read_jsonl
    from apexformz_perception.lifting import create_lifter, pose_frames_to_coco17
    from apexformz_perception.pose import ModelUnavailable

    if not req.pose_jsonl_path or not pathlib.Path(req.pose_jsonl_path).exists():
        raise PerceptionError("SCHEMA_INVALID", "pose_jsonl_path is required and must exist")
    try:
        lifter = create_lifter(req.lifter)
    except ModelUnavailable as e:
        raise PerceptionError("MODEL_UNAVAILABLE", str(e)) from e
    if not lifter.commercial_ok and not req.allow_noncommercial:
        raise PerceptionError("LICENSE_RESTRICTED", f"{lifter.name} is licensed {lifter.license} (non-commercial); set allow_noncommercial=true for research use")
    frames = read_jsonl(req.pose_jsonl_path)
    if len(frames) < 2:
        raise PerceptionError("SCHEMA_INVALID", "need at least 2 frames")
    xy, sc, size = pose_frames_to_coco17(frames)
    lifted = lifter.lift(xy, sc, size)
    out = jobs_dir() / f"{req.job_id}.lift3d.json"
    import json
    payload = lifted.to_dict()
    payload["license"] = lifter.license
    payload["commercial_ok"] = lifter.commercial_ok
    out.write_text(json.dumps(payload), encoding="utf-8")
    return {"output_ref": str(out), "frame_count": int(lifted.joints_xyz.shape[0]), "valid_frames": int(lifted.valid.sum()),
            "provenance": lifted.provenance, "coordinate_system": lifted.coordinate_system, "retrospective": True, "license": lifter.license}


def _run(req: PerceptionJobRequest):
    _set(req.job_id, status="RUNNING", started_at=time.time())
    try:
        output = _run_pose_extract(req) if req.kind == "pose_extract" else _run_lift_3d(req)
        _set(req.job_id, status="COMPLETED", output=output, finished_at=time.time(), error=None)
    except PerceptionError as e:
        _set(req.job_id, status="FAILED", error={"code": e.code, "message": str(e), "retryable": e.retryable}, finished_at=time.time())
    except Exception as e:  # noqa: BLE001
        log.exception("perception job %s failed", req.job_id)
        _set(req.job_id, status="FAILED", error={"code": "INTERNAL", "message": str(e), "retryable": True}, finished_at=time.time())


@router.post("/jobs", status_code=202)
def create_job(req: PerceptionJobRequest, background: BackgroundTasks, response: Response):
    if req.consent_scope not in CONSENT_SCOPES:
        raise HTTPException(status_code=422, detail={"code": "CONSENT_REQUIRED", "message": f"consent_scope must be one of {sorted(CONSENT_SCOPES)}"})
    if req.kind == "pose_extract" and not (req.video_path or req.asset_ref):
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": "video_path or asset_ref required"})
    if req.kind == "lift_3d" and not req.pose_jsonl_path:
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": "pose_jsonl_path required"})
    with _LOCK:
        existing = _JOBS.get(req.job_id)
        if existing:
            response.headers["Retry-After"] = "2"
            return {"job_id": req.job_id, "status": existing["status"], "idempotent": True, "retry_after_s": 2}
        _JOBS[req.job_id] = {"job_id": req.job_id, "kind": req.kind, "status": "QUEUED", "created_at": time.time(),
                             "consent_scope": req.consent_scope, "output": None, "error": None}
    background.add_task(_run, req)
    response.headers["Retry-After"] = "2"
    return {"job_id": req.job_id, "status": "QUEUED", "retry_after_s": 2}


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": "unknown job"})
    return job


@router.get("/backends")
def list_backends():
    """Which pose backends and lifters this service can construct (import-level check only)."""
    out: Dict[str, Any] = {"pose": {}, "lifters": {}}
    for name, mod in (("mediapipe", "mediapipe"), ("rtmlib", "rtmlib")):
        try:
            __import__(mod)
            out["pose"][name] = {"importable": True}
        except Exception as e:  # noqa: BLE001
            out["pose"][name] = {"importable": False, "error": str(e)[:120]}
    out["lifters"]["videopose3d"] = {"license": "CC-BY-NC-4.0", "commercial_ok": False, "weights": "auto-download"}
    out["lifters"]["motionbert"] = {"license": "Apache-2.0", "commercial_ok": True, "weights": "APEXFORMZ_MOTIONBERT_CKPT required",
                                    "configured": bool(os.environ.get("APEXFORMZ_MOTIONBERT_CKPT"))}
    return out
