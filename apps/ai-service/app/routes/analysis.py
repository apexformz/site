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
