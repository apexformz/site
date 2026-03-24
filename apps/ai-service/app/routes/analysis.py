from fastapi import APIRouter
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

@router.post("/analyze")
async def analyze_frame(request: AnalyzeRequest):
    """
    Receives current video frame keypoints, calculates angles, compares to reference,
    and returns immediate score and actionable feedback.
    """
    # Convert Pydantic to dict list for the analyzer
    kp_dicts = [kp.dict() for kp in request.keypoints.keypoints]
    
    analysis_result = analyze_pose(request.sport, kp_dicts)
    return analysis_result

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
