"""Pose backend interface and PersonPose -> contract PoseFrame conversion.

Backends wrap third-party models; this module owns the contract semantics:
normalized image coordinates, typed missingness (visibility 0 + missing_joints),
framing checks on the core body joints, and mandatory provenance.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from .keypoint_sets import (CONTRACT_LANDMARK_SET, CORE_BODY_MP_IDS, MEDIAPIPE_POSE_33, SETS, mapping_to_mediapipe33,
                            unsupported_mediapipe_ids)

CONTRACT_VERSION = "1.0.0"


class ModelUnavailable(RuntimeError):
    """Raised when a backend's dependency or weights are not available (TRD: MODEL_UNAVAILABLE, fail closed)."""

    code = "MODEL_UNAVAILABLE"


@dataclass
class PersonPose:
    """One detected person. Coordinates are normalized to the image (0..1, origin top-left)."""

    landmark_set: str
    xy: np.ndarray                       # (K, 2) normalized
    scores: np.ndarray                   # (K,) 0..1 per keypoint
    z: Optional[np.ndarray] = None       # (K,) optional model depth (MediaPipe convention)
    world_xyz: Optional[np.ndarray] = None  # (K, 3) model-estimated metres (uncalibrated)
    bbox: Optional[np.ndarray] = None    # (4,) normalized x0,y0,x1,y1
    detection_score: float = 1.0
    extras: Dict[str, Any] = field(default_factory=dict)

    @property
    def num_keypoints(self) -> int:
        return int(self.xy.shape[0])

    def bbox_or_from_keypoints(self, min_score: float = 0.3) -> np.ndarray:
        if self.bbox is not None:
            return self.bbox
        ok = self.scores >= min_score
        if not ok.any():
            return np.array([0.0, 0.0, 0.0, 0.0])
        pts = self.xy[ok]
        return np.array([pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()])

    def confidence(self) -> float:
        return float(np.clip(self.scores.mean() if self.scores.size else 0.0, 0.0, 1.0))


def _framing(landmarks: List[dict], min_visibility: float, margin: float = 0.02) -> Dict[str, Any]:
    missing: List[int] = []
    out_of_frame: List[int] = []
    by_id = {l["id"]: l for l in landmarks}
    for lid in CORE_BODY_MP_IDS:
        l = by_id.get(lid)
        if l is None or (l.get("visibility") or 0.0) < min_visibility:
            missing.append(lid)
        elif not (margin <= l["x"] <= 1 - margin and margin <= l["y"] <= 1 - margin):
            out_of_frame.append(lid)
    return {"framing_ok": not missing and not out_of_frame, "missing_joints": missing, "out_of_frame": out_of_frame}


def person_to_mediapipe33_landmarks(person: PersonPose) -> List[dict]:
    """Re-map any supported set onto the 33-slot canonical frame. Unprovided ids get visibility 0."""
    mapping = mapping_to_mediapipe33(person.landmark_set)
    lms = [{"id": i, "x": 0.0, "y": 0.0, "z": 0.0, "visibility": 0.0, "presence": 0.0} for i in range(33)]
    for src, dst in mapping.items():
        if src >= person.num_keypoints:
            continue
        s = float(np.clip(person.scores[src], 0.0, 1.0))
        lms[dst] = {
            "id": dst,
            "x": float(person.xy[src, 0]),
            "y": float(person.xy[src, 1]),
            "z": float(person.z[src]) if person.z is not None else 0.0,
            "visibility": s,
            "presence": s,
        }
    return lms


def person_to_native_landmarks(person: PersonPose) -> List[dict]:
    out = []
    for i in range(person.num_keypoints):
        s = float(np.clip(person.scores[i], 0.0, 1.0))
        out.append({"id": i, "x": float(person.xy[i, 0]), "y": float(person.xy[i, 1]),
                    "z": float(person.z[i]) if person.z is not None else 0.0, "visibility": s, "presence": s})
    return out


def build_pose_frame(
    person: Optional[PersonPose],
    *,
    session_id: str,
    frame_id: int,
    timestamp_ms: float,
    camera_id: str,
    image_size: Sequence[int],
    mirror: bool,
    orientation: str,
    provenance: Dict[str, Any],
    tracked_subject_id: Optional[str],
    person_count: int,
    ambiguous: bool = False,
    track_changed: bool = False,
    canonical: bool = True,
    min_visibility: float = 0.5,
) -> Dict[str, Any]:
    """Build a contract PoseFrame dict. `canonical=True` emits the 33-slot frame for any set."""
    if person is None:
        landmarks: List[dict] = []
        world = None
        landmark_set = "mediapipe_pose_33" if canonical else "custom"
        quality = {"framing_ok": False, "ambiguous_people": ambiguous, "missing_joints": list(range(33)),
                   "person_count": person_count, "detection_confidence": 0.0, "track_changed": track_changed}
    else:
        if canonical or person.landmark_set == "mediapipe_pose_33":
            landmarks = person_to_mediapipe33_landmarks(person) if person.landmark_set != "mediapipe_pose_33" else person_to_native_landmarks(person)
            landmark_set = "mediapipe_pose_33"
            framing = _framing(landmarks, min_visibility)
            unsupported = set(unsupported_mediapipe_ids(person.landmark_set))
            # Landmarks the set can never provide are not "missing joints" unless they are core joints.
            missing = [i for i in framing["missing_joints"] if i not in unsupported or i in CORE_BODY_MP_IDS]
        else:
            landmarks = person_to_native_landmarks(person)
            landmark_set = CONTRACT_LANDMARK_SET.get(person.landmark_set, "custom")
            framing = _framing(person_to_mediapipe33_landmarks(person), min_visibility)
            missing = framing["missing_joints"]
        world = None
        if person.world_xyz is not None and person.landmark_set == "mediapipe_pose_33":
            world = [{"id": i, "x": float(w[0]), "y": float(w[1]), "z": float(w[2]), "confidence": float(np.clip(person.scores[i], 0, 1))}
                     for i, w in enumerate(person.world_xyz)]
        quality = {
            "framing_ok": bool(framing["framing_ok"]) and not missing,
            "ambiguous_people": ambiguous,
            "missing_joints": missing,
            "person_count": person_count,
            "detection_confidence": person.confidence(),
            "track_changed": track_changed,
        }
    frame: Dict[str, Any] = {
        "schema_version": CONTRACT_VERSION,
        "session_id": session_id,
        "frame_id": int(frame_id),
        "timestamp_ms": float(max(0.0, timestamp_ms)),
        "camera_id": camera_id,
        "image_size": [int(image_size[0]), int(image_size[1])],
        "mirror": bool(mirror),
        "orientation": orientation,
        "landmark_set": landmark_set,
        "normalized_landmarks": landmarks,
        "tracked_subject_id": tracked_subject_id,
        "quality": quality,
        "provenance": {"model_id": provenance["model_id"], "version": provenance["version"],
                       **({"delegate": provenance["delegate"]} if provenance.get("delegate") else {}),
                       **({"digest": provenance["digest"]} if provenance.get("digest") else {})},
    }
    if world is not None:
        frame["world_landmarks"] = world
    if person is not None and person.landmark_set != "mediapipe_pose_33" and not canonical:
        frame["provenance"]["model_id"] = f"{provenance['model_id']}:{person.landmark_set}"
    return frame


class PoseBackend(abc.ABC):
    """Common interface for 2D(+depth) human pose backends."""

    name: str = "abstract"
    landmark_set: str = "mediapipe_pose_33"

    @abc.abstractmethod
    def provenance(self) -> Dict[str, Any]:
        """ModelProvenance dict: model_id, version, delegate, optional digest."""

    @abc.abstractmethod
    def detect(self, frame_bgr: np.ndarray, timestamp_ms: float, frame_id: int, meta: Optional[Dict[str, Any]] = None) -> List[PersonPose]:
        """Detect all persons in a BGR frame. Coordinates normalized to the frame size."""

    def close(self) -> None:  # pragma: no cover - trivial default
        return None

    @property
    def keypoint_names(self) -> List[str]:
        return SETS[self.landmark_set]

    def to_pose_frame(self, person: Optional[PersonPose], **kwargs: Any) -> Dict[str, Any]:
        """Native-set frame (`coco_17` or `custom` for richer sets)."""
        return build_pose_frame(person, provenance=self.provenance(), canonical=False, **kwargs)

    def to_mediapipe33_pose_frame(self, person: Optional[PersonPose], **kwargs: Any) -> Dict[str, Any]:
        """Canonical 33-slot frame; unprovided landmarks have visibility 0."""
        return build_pose_frame(person, provenance=self.provenance(), canonical=True, **kwargs)


__all__ = ["PoseBackend", "PersonPose", "ModelUnavailable", "build_pose_frame", "MEDIAPIPE_POSE_33"]
