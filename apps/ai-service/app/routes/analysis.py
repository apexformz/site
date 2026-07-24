from fastapi import APIRouter, Request
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from app.services.pose_analyzer import analyze_pose

router = APIRouter()

class Keypoint(BaseModel):
    x: float
    y: float
    score: float
    name: str

class PoseKeypoints(BaseModel):
    keypoints: List[Keypoint]
    score: float
    timestamp_ms: int

class AnalyzeRequest(BaseModel):
    keypoints: PoseKeypoints
    sport: str

# ... 
@router.post("/analyze")
async def analyze_frame(request: Request):
    """
    Receives current video frame keypoints, calculates angles, compares to reference,
    and returns immediate score and actionable feedback.
    Bypasses Pydantic for maximum performance on the hot path.
    """
    data = await request.json()
    sport = data.get("sport", "cricket")
    keypoints = data.get("keypoints", [])
    hands = data.get("hands", [])
    
    analysis_result = analyze_pose(sport, keypoints, data.get("pose_name"), hands)
    return analysis_result

@router.get("/poses/{sport}")
async def get_sport_poses(sport: str):
    """
    Returns available reference poses for a given sport.
    """
    from app.services.pose_analyzer import REFERENCE_POSES
    if sport not in REFERENCE_POSES:
        return {"success": False, "error": "Sport not found"}
    return {"success": True, "poses": list(REFERENCE_POSES[sport].keys())}

@router.post("/analyze/batch")
async def analyze_batch(requests: List[AnalyzeRequest]):
    """
    Batch processing for entire sessions at once.
    """
    results = []
    for req in requests:
        kp_dicts = [kp.dict() for kp in req.keypoints.keypoints]
        results.append(analyze_pose(req.sport, kp_dicts))
    return {"batch_results": results}


# ============================================================
# DYNAMIC MOVEMENT ANALYSIS ENDPOINTS (Parallel System)
# These endpoints handle multi-phase temporal analysis for
# dynamic sports. The static /analyze endpoint above is
# completely untouched.
# ============================================================

@router.post("/analyze/dynamic")
async def analyze_dynamic_frame(request: Request):
    """
    Dynamic movement analysis for multi-phase sports (cricket shots,
    running strides, boxing combos, tennis strokes, football kicks).
    
    Requires a session_key for temporal state tracking across frames.
    Uses phase detection, kinetic chain validation, and fluidity scoring.
    """
    from app.services.dynamic.movement_registry import analyze_dynamic_frame as _analyze_dynamic

    data = await request.json()
    sport = data.get("sport", "cricket")
    keypoints = data.get("keypoints", [])
    pose_name = data.get("pose_name", "")
    session_key = data.get("session_key", "default")
    
    result = _analyze_dynamic(session_key, sport, pose_name, keypoints)
    return result


@router.get("/movements/{sport}")
async def get_dynamic_movements(sport: str):
    """
    Returns available dynamic movements for a given sport.
    """
    from app.services.dynamic.movement_registry import get_dynamic_movements as _get_movements
    
    movements = _get_movements(sport)
    if not movements:
        return {"success": False, "error": "No dynamic movements found for this sport"}
    return {"success": True, "movements": movements}


@router.post("/analyze/dynamic/cleanup")
async def cleanup_dynamic_session(request: Request):
    """
    Clean up a dynamic analysis session to free memory.
    Called when a training session ends.
    """
    from app.services.dynamic.movement_registry import cleanup_session
    
    data = await request.json()
    session_key = data.get("session_key", "")
    if session_key:
        cleanup_session(session_key)
    return {"success": True}
