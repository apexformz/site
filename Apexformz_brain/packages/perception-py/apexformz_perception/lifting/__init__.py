"""Offline 2D -> 3D lifting adapters (retrospective; estimated_world coordinates only)."""
from .base import H36M_17, LiftedSequence, Lifter3D, pose_frames_to_coco17  # noqa: F401


def create_lifter(name: str, **kwargs) -> Lifter3D:
    if name == "videopose3d":
        from .videopose3d_lifter import VideoPose3DLifter
        return VideoPose3DLifter(**kwargs)
    if name == "motionbert":
        from .motionbert_lifter import MotionBERTLifter
        return MotionBERTLifter(**kwargs)
    raise ValueError(f"unknown lifter {name}")
