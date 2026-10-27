"""2D -> 3D lifting interface (offline, retrospective). Outputs are model-estimated,
uncalibrated metres in a root-relative frame: never claim calibrated_world."""
from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np

from ..pose.base import ModelUnavailable  # noqa: F401  (re-exported for callers)
from ..pose.keypoint_sets import COCO17_TO_MP33, COCO_17

H36M_17 = ["pelvis", "right_hip", "right_knee", "right_ankle", "left_hip", "left_knee", "left_ankle", "spine", "thorax", "neck",
           "head", "left_shoulder", "left_elbow", "left_wrist", "right_shoulder", "right_elbow", "right_wrist"]


@dataclass
class LiftedSequence:
    joints_xyz: np.ndarray            # (T, J, 3) root-relative, model-estimated metres
    joint_names: List[str]
    valid: np.ndarray                 # (T,) bool: enough 2D input to trust the frame
    provenance: Dict[str, Any]
    coordinate_system: str = "estimated_world"
    retrospective: bool = True
    notes: List[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"coordinate_system": self.coordinate_system, "retrospective": self.retrospective, "joint_names": self.joint_names,
                "provenance": self.provenance, "frames": [
                    {"t": int(t), "valid": bool(self.valid[t]), "joints": [[round(float(c), 5) for c in j] for j in self.joints_xyz[t]]}
                    for t in range(self.joints_xyz.shape[0])],
                "notes": self.notes or []}


class Lifter3D(abc.ABC):
    name = "abstract"
    license = "unknown"
    commercial_ok = False

    @abc.abstractmethod
    def provenance(self) -> Dict[str, Any]: ...

    @abc.abstractmethod
    def lift(self, keypoints_2d: np.ndarray, scores: np.ndarray, image_size) -> LiftedSequence:
        """keypoints_2d: (T, 17, 2) COCO-17 normalized 0..1; scores: (T, 17)."""


def pose_frames_to_coco17(frames: List[dict]):
    """Contract PoseFrames (mediapipe_pose_33 or coco_17) -> (T,17,2) normalized xy and (T,17) scores."""
    T = len(frames)
    xy = np.zeros((T, 17, 2))
    sc = np.zeros((T, 17))
    size = None
    for t, fr in enumerate(frames):
        size = size or fr["image_size"]
        lms = {l["id"]: l for l in fr["normalized_landmarks"]}
        if fr["landmark_set"] == "coco_17":
            for i in range(17):
                l = lms.get(i)
                if l:
                    xy[t, i] = (l["x"], l["y"])
                    sc[t, i] = l.get("visibility") or 0.0
        else:
            for ci, mi in COCO17_TO_MP33.items():
                l = lms.get(mi)
                if l:
                    xy[t, ci] = (l["x"], l["y"])
                    sc[t, ci] = l.get("visibility") or 0.0
    return xy, sc, tuple(size or (1, 1))


__all__ = ["Lifter3D", "LiftedSequence", "H36M_17", "COCO_17", "pose_frames_to_coco17", "ModelUnavailable"]
