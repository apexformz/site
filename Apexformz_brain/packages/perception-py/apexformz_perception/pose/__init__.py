"""Pose backends: MediaPipe PoseLandmarker, rtmlib (RTMPose/RTMO/RTMW), plus contract conversion and extraction."""
from .base import ModelUnavailable, PersonPose, PoseBackend, build_pose_frame  # noqa: F401
from .keypoint_sets import COCO17_TO_MP33, COCO_17, COCO_WHOLEBODY_133, HALPE_26, MEDIAPIPE_POSE_33, SETS  # noqa: F401


def create_backend(name: str, **kwargs):
    """Factory: 'mediapipe' | 'rtmlib_body' | 'rtmlib_rtmo' | 'rtmlib_wholebody'."""
    if name == "mediapipe":
        from .mediapipe_backend import MediaPipePoseBackend
        return MediaPipePoseBackend(**kwargs)
    if name.startswith("rtmlib_"):
        from .rtmlib_backend import RTMLibBackend
        return RTMLibBackend(solution=name.split("_", 1)[1], **kwargs)
    raise ValueError(f"unknown pose backend {name}")
