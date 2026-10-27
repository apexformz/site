"""Deep-analysis job endpoints (TRD 13): QUEUED -> RUNNING -> COMPLETED | FAILED.

Jobs accept consented asset references or validated feature bundles. State is
in-memory for this service; the Node backend owns the durable job table and
polls/mirrors this status.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Response
from pydantic import BaseModel, Field

from app.brain.packs import PackError, list_packs, load_pack
from app.brain.retrospective import AnalysisError, analyze_feature_bundle
from app.brain.assets import AssetDescriptor, decode_asset

log = logging.getLogger("apexformz.jobs")
router = APIRouter(prefix="/v1", tags=["Brain"])

CONSENT_SCOPES = {"deep_analysis", "quality_improvement"}
_JOBS: Dict[str, Dict[str, Any]] = {}
_LOCK = threading.Lock()


def expire_results():
    with _LOCK:
        for key, value in list(_JOBS.items()):
            if value.get("finished_at", float("inf")) < time.time() - 900:
                del _JOBS[key]


class JobRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    sport_pack_id: str
    sport_pack_version: str
    movement_id: str
    consent_scope: str
    feature_bundle: Optional[List[dict]] = None
    asset_ref: Optional[str] = None
    asset: Optional[AssetDescriptor] = None
    handedness: Literal["left", "right", "unknown"] = "right"
    view: str = "front"
    capabilities: List[str] = Field(default_factory=lambda: ["body_pose"])


def _set(job_id: str, **fields):
    with _LOCK:
        if job_id in _JOBS and _JOBS[job_id]["status"] != "DELETED":
            _JOBS[job_id].update(fields)


def _run(req: JobRequest):
    _set(req.job_id, status="RUNNING", started_at=time.time())
    try:
        pack = load_pack(req.sport_pack_id, req.sport_pack_version)
        if req.feature_bundle is None and req.asset is None:
            raise AnalysisError("ASSET_FORBIDDEN", "A backend-authorized S3 asset descriptor is required")
        frames = req.feature_bundle if req.feature_bundle is not None else decode_asset(req.asset, req.job_id)
        output = analyze_feature_bundle(frames, pack, req.movement_id, req.handedness, req.view, req.capabilities)
        _set(req.job_id, status="COMPLETED", output=output, finished_at=time.time(), error=None)
    except (PackError, AnalysisError) as e:
        _set(req.job_id, status="FAILED", error={"code": e.code, "message": str(e), "retryable": False}, finished_at=time.time())
    except Exception as e:  # noqa: BLE001
        log.exception("job %s failed", req.job_id)
        _set(req.job_id, status="FAILED", error={"code": "INTERNAL", "message": str(e), "retryable": True}, finished_at=time.time())


@router.post("/analysis/jobs", status_code=202)
def create_job(req: JobRequest, background: BackgroundTasks, response: Response):
    if req.consent_scope not in CONSENT_SCOPES:
        raise HTTPException(status_code=422, detail={"code": "CONSENT_REQUIRED", "message": f"consent_scope must be one of {sorted(CONSENT_SCOPES)}"})
    if req.feature_bundle is None and not req.asset_ref:
        raise HTTPException(status_code=422, detail={"code": "SCHEMA_INVALID", "message": "feature_bundle or asset_ref required"})
    with _LOCK:
        # Remote results are a short-lived transport cache; PostgreSQL owns durable state.
        for key, value in list(_JOBS.items()):
            if value.get("finished_at", float("inf")) < time.time() - 900:
                del _JOBS[key]
        existing = _JOBS.get(req.job_id)
        if existing and not (existing["status"] == "FAILED" and (existing.get("error") or {}).get("retryable")):
            response.headers["Retry-After"] = "2"
            return {"job_id": req.job_id, "status": existing["status"], "idempotent": True, "retry_after_s": 2}
        _JOBS[req.job_id] = {"job_id": req.job_id, "status": "QUEUED", "created_at": time.time(), "consent_scope": req.consent_scope,
                             "sport_pack_id": req.sport_pack_id, "sport_pack_version": req.sport_pack_version, "movement_id": req.movement_id,
                             "output": None, "error": None}
    background.add_task(_run, req)
    response.headers["Retry-After"] = "2"
    return {"job_id": req.job_id, "status": "QUEUED", "retry_after_s": 2}


@router.get("/analysis/jobs/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail={"code": "UNKNOWN_JOB", "message": job_id})
    return job


@router.delete("/analysis/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    with _LOCK:
        # Tombstone fences an in-flight worker from recreating a deleted result.
        _JOBS[job_id] = {"job_id": job_id, "status": "DELETED", "output": None, "error": None, "finished_at": time.time()}
    return Response(status_code=204)


@router.get("/sport-packs")
def packs():
    try:
        return {"packs": list_packs()}
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail={"code": "UNKNOWN_SPORT_PACK", "message": str(e)})
