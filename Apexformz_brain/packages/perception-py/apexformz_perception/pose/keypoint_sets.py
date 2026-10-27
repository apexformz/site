"""Keypoint set definitions and mappings onto the canonical MediaPipe-33 contract.

All sets are generic human body models (no sport knowledge). The contract
`landmark_set` enum only knows `mediapipe_pose_33`, `coco_17` and `custom`, so
richer sets (Halpe-26, COCO-WholeBody-133) are emitted either natively as
`custom` frames or re-mapped onto the 33-slot canonical frame.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

MEDIAPIPE_POSE_33: List[str] = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
    "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow",
    "right_elbow", "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index",
    "left_thumb", "right_thumb", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_heel", "right_heel", "left_foot_index", "right_foot_index",
]
MP_INDEX: Dict[str, int] = {n: i for i, n in enumerate(MEDIAPIPE_POSE_33)}

COCO_17: List[str] = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder",
    "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
]

# Halpe-26 = COCO-17 + head, neck, hip(pelvis), feet (big toe, small toe, heel).
HALPE_26: List[str] = COCO_17 + [
    "head", "neck", "pelvis",
    "left_big_toe", "right_big_toe", "left_small_toe", "right_small_toe", "left_heel", "right_heel",
]

# COCO-WholeBody-133 = body 17 + feet 6 + face 68 + left hand 21 + right hand 21.
_FEET_6 = ["left_big_toe", "left_small_toe", "left_heel", "right_big_toe", "right_small_toe", "right_heel"]
_FACE_68 = [f"face_{i}" for i in range(68)]
_HAND_21 = ["wrist", "thumb_cmc", "thumb_mcp", "thumb_ip", "thumb_tip", "index_mcp", "index_pip", "index_dip", "index_tip",
            "middle_mcp", "middle_pip", "middle_dip", "middle_tip", "ring_mcp", "ring_pip", "ring_dip", "ring_tip",
            "pinky_mcp", "pinky_pip", "pinky_dip", "pinky_tip"]
COCO_WHOLEBODY_133: List[str] = COCO_17 + _FEET_6 + _FACE_68 + [f"left_hand_{n}" for n in _HAND_21] + [f"right_hand_{n}" for n in _HAND_21]
assert len(COCO_WHOLEBODY_133) == 133

SETS: Dict[str, List[str]] = {
    "mediapipe_pose_33": MEDIAPIPE_POSE_33,
    "coco_17": COCO_17,
    "halpe_26": HALPE_26,
    "coco_wholebody_133": COCO_WHOLEBODY_133,
}

# Name of the set in the *contract* enum (richer sets become `custom`).
CONTRACT_LANDMARK_SET: Dict[str, str] = {
    "mediapipe_pose_33": "mediapipe_pose_33",
    "coco_17": "coco_17",
    "halpe_26": "custom",
    "coco_wholebody_133": "custom",
}

# Source set name -> MediaPipe-33 name for landmarks that correspond directly.
_ALIAS_TO_MP: Dict[str, str] = {
    "left_big_toe": "left_foot_index",
    "right_big_toe": "right_foot_index",
    "left_hand_index_tip": "left_index",
    "right_hand_index_tip": "right_index",
    "left_hand_pinky_tip": "left_pinky",
    "right_hand_pinky_tip": "right_pinky",
    "left_hand_thumb_tip": "left_thumb",
    "right_hand_thumb_tip": "right_thumb",
}


def mapping_to_mediapipe33(set_name: str) -> Dict[int, int]:
    """Return {source_index: mediapipe33_index} for a keypoint set."""
    names = SETS[set_name]
    out: Dict[int, int] = {}
    for i, n in enumerate(names):
        target = _ALIAS_TO_MP.get(n, n)
        if target in MP_INDEX and MP_INDEX[target] not in out.values():
            out[i] = MP_INDEX[target]
    return out


# COCO-17 -> MediaPipe-33 (the mapping the TRD-style adapters use).
COCO17_TO_MP33: Dict[int, int] = mapping_to_mediapipe33("coco_17")

CORE_BODY_NAMES: Tuple[str, ...] = (
    "left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle",
)
CORE_BODY_MP_IDS: Tuple[int, ...] = tuple(MP_INDEX[n] for n in CORE_BODY_NAMES)


def unsupported_mediapipe_ids(set_name: str) -> List[int]:
    """MediaPipe-33 ids a set can never provide (not missing joints, just absent)."""
    provided = set(mapping_to_mediapipe33(set_name).values())
    return [i for i in range(33) if i not in provided]
