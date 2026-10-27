"""Synthetic PoseFrame fixtures (Python port of packages/signal/src/synthetic.ts)."""
import math

from apexformz_contracts.enums import MEDIAPIPE_POSE_33  # noqa: E402

DEG = math.pi / 180


def build_skeleton(right_knee_flexion=0.0, left_knee_flexion=0.0, right_arm_raise=0.0, right_elbow_flexion=0.0, trunk_lean=0.0, stance=0.32):
    """Python port of packages/signal/src/synthetic.ts (metres, hip-mid origin, +y down)."""
    torso, thigh, shank, upper, fore, hip_half, sh_half = 0.5, 0.45, 0.45, 0.3, 0.28, 0.16, 0.2
    lean = trunk_lean * DEG
    P = {}
    P["left_hip"] = (hip_half, 0.0)
    P["right_hip"] = (-hip_half, 0.0)
    sm = (math.sin(lean) * torso, -math.cos(lean) * torso)
    P["left_shoulder"] = (sm[0] + sh_half, sm[1])
    P["right_shoulder"] = (sm[0] - sh_half, sm[1])
    head_y = sm[1] - 0.22
    P["nose"] = (sm[0], head_y)
    for n in ("left_eye_inner", "left_eye", "left_eye_outer"):
        P[n] = (sm[0] + 0.03, head_y - 0.03)
    for n in ("right_eye_inner", "right_eye", "right_eye_outer"):
        P[n] = (sm[0] - 0.03, head_y - 0.03)
    P["left_ear"] = (sm[0] + 0.08, head_y - 0.02)
    P["right_ear"] = (sm[0] - 0.08, head_y - 0.02)
    P["mouth_left"] = (sm[0] + 0.02, head_y + 0.04)
    P["mouth_right"] = (sm[0] - 0.02, head_y + 0.04)
    for side, flex in (("left", left_knee_flexion), ("right", right_knee_flexion)):
        sign = 1 if side == "left" else -1
        hip = P[f"{side}_hip"]
        half = flex * DEG / 2
        off = sign * stance / 2 - hip[0]
        knee = (hip[0] + math.sin(half) * thigh + off / 2, hip[1] + math.cos(half) * thigh)
        ankle = (knee[0] - math.sin(half) * shank + off / 2, knee[1] + math.cos(half) * shank)
        P[f"{side}_knee"] = knee
        P[f"{side}_ankle"] = ankle
        P[f"{side}_heel"] = (ankle[0] - 0.04 * sign, ankle[1] + 0.04)
        P[f"{side}_foot_index"] = (ankle[0] + 0.1 * sign, ankle[1] + 0.05)
    for side, raise_, flex in (("left", 0.0, 0.0), ("right", right_arm_raise, right_elbow_flexion)):
        sign = 1 if side == "left" else -1
        sh = P[f"{side}_shoulder"]
        r = raise_ * DEG
        f = flex * DEG
        ux, uy = math.sin(r) * sign, math.cos(r)
        elbow = (sh[0] + ux * upper, sh[1] + uy * upper)
        ang = math.atan2(uy, ux) - f * sign
        wrist = (elbow[0] + math.cos(ang) * fore, elbow[1] + math.sin(ang) * fore)
        P[f"{side}_elbow"] = elbow
        P[f"{side}_wrist"] = wrist
        for n, d in (("pinky", 0.05), ("index", 0.06), ("thumb", 0.04)):
            P[f"{side}_{n}"] = (wrist[0] + d * math.cos(ang), wrist[1] + d * math.sin(ang))
    return P


def synthetic_frame(frame_id, timestamp_ms, session_id="retro-session", mirror=False, visibility=0.95, **opts):
    W, H = 1280, 720
    scale = 0.38
    P = build_skeleton(**opts)
    lms = []
    for i, name in enumerate(MEDIAPIPE_POSE_33):
        x, y = P.get(name, (0.0, 0.0))
        lms.append({"id": i, "x": 0.5 + x * scale * H / W, "y": 0.42 + y * scale, "z": 0.0, "visibility": visibility, "presence": visibility})
    return {
        "schema_version": "1.0.0", "session_id": session_id, "frame_id": frame_id, "timestamp_ms": timestamp_ms, "camera_id": "synthetic",
        "image_size": [W, H], "mirror": mirror, "orientation": "landscape", "landmark_set": "mediapipe_pose_33", "normalized_landmarks": lms,
        "tracked_subject_id": "subject-1", "quality": {"framing_ok": True, "ambiguous_people": False, "missing_joints": [], "person_count": 1, "detection_confidence": 0.95},
        "provenance": {"model_id": "synthetic", "version": "1.0.0"},
    }


