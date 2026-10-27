"""Frame gate, geometric continuity, camera-independent body frame, hierarchy loss, speed warp and attestations."""
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

ML = Path(__file__).resolve().parents[1]
ROOT = ML.parent
sys.path.insert(0, str(ML))
sys.path.insert(0, str(ROOT / "tools"))

from datasets.jsonl_dataset import frame_from_json, normalize_world_bodyframe, read_jsonl  # noqa: E402


def frame(ts, dx=0.0, mirror=False, missing=False, subject="track-1", ambiguous=False, world_yaw=0.0):
    rng = np.random.default_rng(3)
    lms = [{"id": i, "x": float(0.45 + dx + 0.1 * rng.random()), "y": float(0.3 + 0.4 * rng.random()), "z": 0.0, "visibility": 0.95} for i in range(33)]
    # torso landmarks at fixed positions so the root is well defined
    for i, (x, y) in {11: (0.45, 0.35), 12: (0.55, 0.35), 23: (0.47, 0.55), 24: (0.53, 0.55)}.items():
        lms[i].update({"x": x + dx, "y": y})
    world = []
    for i in range(33):
        x, y, z = float(rng.normal(0, .3)), float(rng.normal(0, .4)), float(rng.normal(0, .3))
        c, s = math.cos(world_yaw), math.sin(world_yaw)
        world.append({"id": i, "x": c * x - s * z, "y": y, "z": s * x + c * z})
    return {"schema_version": "1.0.0", "session_id": "s", "frame_id": int(ts), "timestamp_ms": float(ts), "camera_id": "c", "image_size": [1280, 720],
            "mirror": mirror, "orientation": "landscape", "landmark_set": "mediapipe_pose_33", "normalized_landmarks": lms, "world_landmarks": world,
            "tracked_subject_id": subject,
            "quality": {"framing_ok": not missing, "ambiguous_people": ambiguous, "missing_joints": [27] if missing else [], "person_count": 2 if ambiguous else 1},
            "provenance": {"model_id": "m", "version": "1"}}


def test_strict_gate_blanks_frames_with_a_missing_joint_identity_only_keeps_them():
    f = frame(0, missing=True)
    assert not frame_from_json(f, validate=False, frame_gate="strict").valid.any()
    kept = frame_from_json(f, validate=False, frame_gate="identity_only")
    assert kept.normalization_valid and kept.valid.sum() > 20
    # identity problems still blank the frame under identity_only
    assert not frame_from_json(frame(0, ambiguous=True), validate=False, frame_gate="identity_only").valid.any()
    with pytest.raises(ValueError):
        frame_from_json(f, validate=False, frame_gate="nope")


def test_geometric_continuity_ignores_tracker_churn_and_masks_a_jump_to_another_person(tmp_path):
    rows = [frame(0), frame(33, subject="track-2"), frame(66, subject="track-1"), frame(99, dx=0.4, subject="track-3"), frame(132)]
    p = tmp_path / "s.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    tracker = read_jsonl(p, "mediapipe_pose_33", frame_gate="identity_only", subject_continuity="tracker")
    assert sum(f.continuity_break for f in tracker) >= 3
    geo = read_jsonl(p, "mediapipe_pose_33", frame_gate="identity_only", subject_continuity="geometric")
    assert sum(f.continuity_break for f in geo) == 0
    assert not geo[3].normalization_valid  # the far jump (a reflection or bystander) is masked
    assert geo[4].normalization_valid  # the athlete is picked up again


def test_world_bodyframe_is_invariant_to_camera_yaw_and_mirrors_consistently():
    a = frame_from_json(frame(0), validate=False, frame_gate="identity_only", normalization="world_bodyframe_v1")
    b = frame_from_json(frame(0, world_yaw=1.2), validate=False, frame_gate="identity_only", normalization="world_bodyframe_v1")
    assert a.normalization_valid and b.normalization_valid
    np.testing.assert_allclose(a.body, b.body, atol=1e-5)
    lh, rh = 23, 24
    assert a.body[lh, 0] > 0 > a.body[rh, 0]  # right-hip -> left-hip along +x
    w = np.zeros((33, 3)); v = np.zeros(33, dtype=bool)
    assert normalize_world_bodyframe(w, v, "mediapipe_pose_33")[2] is False


def test_hierarchy_loss_rewards_mass_inside_the_true_group():
    import torch
    from training.train import hierarchy_nll
    groups, families = [0, 0, 1, -1], [0, 0, 0, -1]  # classes a, b (group 0), c (group 1), UNKNOWN
    y = torch.tensor([0])
    inside = torch.tensor([[2.0, 2.0, -2.0, -2.0]])  # mass split between a and b (same group)
    outside = torch.tensor([[2.0, -2.0, 2.0, -2.0]])  # mass split between a and c (different groups)
    assert hierarchy_nll(inside, y, groups, families) < hierarchy_nll(outside, y, groups, families)
    assert float(hierarchy_nll(torch.tensor([[0.0, 0, 0, 5]]), torch.tensor([3]), groups, families)) == 0.0  # UNKNOWN target skipped


def test_speed_warp_keeps_length_and_the_causal_right_edge():
    from training.train import speed_warp
    x = np.arange(10, dtype=np.float32)[:, None].repeat(3, 1)
    m = np.ones((10, 2), dtype=np.float32)
    xf, mf = speed_warp(x, m, 1.5)
    assert xf.shape == x.shape and xf[-1, 0] == 9  # last frame unchanged
    assert mf[0].sum() == 0  # faster playback reaches before the window start: left padding is masked
    xs, ms = speed_warp(x, m, 0.5)
    assert ms.all() and xs[0, 0] >= 4


def test_attestations_set_handedness_and_consent_with_audit_trail():
    from athlete_attestations import apply_attestations
    manifest = {"athletes": [{"athlete_id": "A", "handedness": "unknown", "consent": {"purpose": [], "retention_until": "unknown", "source_status": "unknown"}}],
                "executions": [{"execution_id": "e", "athlete_id": "A", "view_stream_ids": ["s"]}], "view_streams": [{"view_stream_id": "s", "handedness": "unknown"}],
                "annotations": [{"execution_id": "e", "labels": {"handedness": "unknown"}}], "release_blockers": ["Capture metadata does not establish training-purpose/retention fields; retain for review before model release."]}
    att = {"A": {"handedness": "right", "consent": {"status": "GRANTED", "purpose": ["training"], "retention_until": "per signed consent document"}, "attested_by": "owner", "attested_at": "2026-10-25"}}
    apply_attestations(manifest, att)
    a = manifest["athletes"][0]
    assert a["handedness"] == "right" and a["recorded_handedness"] == "unknown" and a["handedness_source"] == "owner_attestation"
    assert a["consent"]["source_status"] == "GRANTED" and a["consent"]["recorded_source_status"] == "unknown"
    assert manifest["view_streams"][0]["handedness"] == "right" and manifest["annotations"][0]["labels"]["handedness"] == "right"
    assert manifest["release_blockers"] == []
    other = {"athletes": [{"athlete_id": "B", "handedness": "unknown"}]}
    apply_attestations(other, att)
    assert other["athletes"][0]["handedness"] == "unknown"


def test_simulation_keeps_the_body_frame_and_changes_proportions_not_angles():
    from training.simulate import simulate_window
    rng = np.random.default_rng(0)
    f = frame_from_json(frame(0), validate=False, frame_gate="identity_only", normalization="world_bodyframe_v1")
    x = np.repeat(f.body.reshape(1, -1), 5, axis=0).astype(np.float32)
    m = np.repeat(f.valid.reshape(1, -1), 5, axis=0).astype(np.float32)
    xs, ms = simulate_window(x.copy(), m.copy(), rng, {"bone_scale": 0.12, "tilt_deg": 0.0, "depth_noise": 0.0})
    b = xs.reshape(5, 33, 3)
    hip = (b[:, 23] + b[:, 24]) / 2
    sh = (b[:, 11] + b[:, 12]) / 2
    np.testing.assert_allclose(hip, 0, atol=1e-5)  # re-normalised: hip centre at origin
    np.testing.assert_allclose(np.linalg.norm(sh - hip, axis=1), 1, atol=1e-5)  # unit torso
    # a limb keeps its direction (joint angle preserved) while its length changes
    o = x.reshape(5, 33, 3)
    u0, u1 = o[0, 25] - o[0, 23], b[0, 25] - b[0, 23]
    assert np.dot(u0, u1) / (np.linalg.norm(u0) * np.linalg.norm(u1)) > 0.97
    assert (ms == m).all()
    # masked joints stay masked and zero
    m2 = m.copy(); m2[:, 27] = 0; x2 = x.copy(); x2.reshape(5, 33, 3)[:, 27] = 0
    xs2, ms2 = simulate_window(x2, m2, rng, {})
    assert (ms2[:, 27] == 0).all() and np.allclose(xs2.reshape(5, 33, 3)[:, 27], 0)
