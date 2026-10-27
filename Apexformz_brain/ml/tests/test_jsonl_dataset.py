import json
import pathlib
import sys

import numpy as np
import pytest

ML = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

from datasets.jsonl_dataset import PoseJsonlDataset, frame_from_json, label_for_window, read_jsonl, resample  # noqa: E402

NAMES33 = 33


def _frame(frame_id, t, mirror=False, drop_hip=False, knee_x=0.55):
    lms = []
    for i in range(NAMES33):
        x, y = 0.5, 0.3 + i * 0.012
        if i == 11: x, y = 0.56, 0.35  # left_shoulder
        if i == 12: x, y = 0.44, 0.35  # right_shoulder
        if i == 23: x, y = 0.54, 0.55  # left_hip
        if i == 24: x, y = 0.46, 0.55  # right_hip
        if i == 25: x, y = knee_x, 0.75  # left_knee
        if i == 26: x, y = 0.45, 0.75
        vis = 0.1 if (drop_hip and i == 23) else 0.95
        lms.append({"id": i, "x": x, "y": y, "z": 0.0, "visibility": vis, "presence": vis})
    return {"schema_version": "1.0.0", "session_id": "s", "frame_id": frame_id, "timestamp_ms": t, "camera_id": "c", "image_size": [1280, 720], "mirror": mirror,
            "orientation": "landscape", "landmark_set": "mediapipe_pose_33", "normalized_landmarks": lms,
            "quality": {"framing_ok": True, "ambiguous_people": False, "missing_joints": []}, "provenance": {"model_id": "synthetic", "version": "1"}}


def test_normalization_hip_origin_and_unit_torso():
    f = frame_from_json(_frame(0, 0))
    assert f.normalization_valid
    hip_mid = (f.body[23] + f.body[24]) / 2
    assert np.allclose(hip_mid[:2], 0, atol=1e-6)
    sh_mid = (f.body[11] + f.body[12]) / 2
    assert np.isclose(np.hypot(sh_mid[0], sh_mid[1]), 1.0, atol=1e-6)


def test_mirror_canonicalization_consistent():
    plain = frame_from_json(_frame(0, 0))
    m = _frame(0, 0, mirror=True)
    # selfie-view image of the same athlete: flip x and swap left/right labels
    for p in m["normalized_landmarks"]:
        p["x"] = 1 - p["x"]
    by_id = {p["id"]: p for p in m["normalized_landmarks"]}
    for l, r in [(11, 12), (23, 24), (25, 26)]:
        by_id[l], by_id[r] = dict(by_id[r], id=l), dict(by_id[l], id=r)
    m["normalized_landmarks"] = [by_id[i] for i in range(33)]
    mir = frame_from_json(m)
    assert np.allclose(mir.body[25], plain.body[25], atol=1e-5)


def test_missing_root_is_invalid_not_invented():
    f = frame_from_json(_frame(0, 0, drop_hip=True))
    assert not f.normalization_valid
    assert not f.valid.any()


def test_resample_masks_gaps_and_holds(tmp_path):
    p = tmp_path / "seq.jsonl"
    frames = [_frame(i, i * 40) for i in range(10)] + [_frame(20, 2000)] + [_frame(21, 2040)]
    p.write_text("\n".join(json.dumps(f) for f in frames))
    fr = read_jsonl(p, "mediapipe_pose_33")
    ts, x, mask = resample(fr, hz=25, max_hold_ms=100)
    assert x.shape[1] == 99 and mask.shape[1] == 33
    assert mask[0].sum() == 33
    # gap between 360 ms and 2000 ms must be padded (mask 0), not interpolated
    gap = (ts > 500) & (ts < 1900)
    assert gap.any() and mask[gap].sum() == 0 and np.all(x[gap] == 0)


def test_labels_and_windows(tmp_path):
    p = tmp_path / "seq.jsonl"
    p.write_text("\n".join(json.dumps(_frame(i, i * 40)) for i in range(60)))
    labels = tmp_path / "labels.json"
    labels.write_text(json.dumps([{"sequence_id": "seq", "movement_id": "x.kick", "start_ms": 800, "end_ms": 1600}]))
    classes = ["x.kick", "UNKNOWN"]
    ds = PoseJsonlDataset({"seq": p}, {"seq": json.loads(labels.read_text())}, classes, window_frames=10, stride=10, hz=25)
    assert len(ds) > 0
    counts = ds.class_counts()
    assert counts["x.kick"] >= 1 and counts["UNKNOWN"] >= 1
    x, m, y = ds[0]
    assert tuple(x.shape) == (10, 99) and tuple(m.shape) == (10, 33)
    assert label_for_window(np.array([0, 100]), [], classes) == 1


def test_from_manifest_respects_split(tmp_path):
    p = tmp_path / "a.jsonl"
    p.write_text("\n".join(json.dumps(_frame(i, i * 40)) for i in range(30)))
    man = tmp_path / "manifest.json"
    man.write_text(json.dumps({"sequences": [{"sequence_id": "a", "path": "a.jsonl", "execution_id": "e1"}, {"sequence_id": "b", "path": "a.jsonl", "execution_id": "e2"}]}))
    split = tmp_path / "split.json"
    split.write_text(json.dumps({"assignments": {"e1": "train", "e2": "test"}}))
    train = PoseJsonlDataset.from_manifest(man, None, ["x", "UNKNOWN"], split_manifest=split, split="train", window_frames=10, stride=10, hz=25)
    test = PoseJsonlDataset.from_manifest(man, None, ["x", "UNKNOWN"], split_manifest=split, split="test", window_frames=10, stride=10, hz=25)
    assert len(train) == len(test) > 0
    assert {it[3] for it in train.items} == {"a"} and {it[3] for it in test.items} == {"b"}
