"""Real-video smoke tests for the pose backends (skipped when a model cannot be obtained)."""
import json
import os
import pathlib
import time

import numpy as np
import pytest

from apexformz_perception.io import iter_jsonl, probe, read_frames, write_jsonl
from apexformz_perception.lifting import pose_frames_to_coco17
from apexformz_perception.pose import ModelUnavailable, create_backend
from apexformz_perception.pose.extract import extract_pose_sequence

try:
    from apexformz_contracts import validate
except ImportError:  # pragma: no cover
    validate = None

RESULTS = pathlib.Path(__file__).resolve().parent / "_bench_results.json"


def _record(name: str, fps: float, extra: dict):
    data = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    data[name] = {"fps": round(fps, 1), **extra}
    RESULTS.write_text(json.dumps(data, indent=2))


def test_video_reader_timestamps_monotonic(sample_video):
    info = probe(str(sample_video))
    assert info.width > 0 and info.fps > 0
    ts = [t for _, t, _ in read_frames(str(sample_video), max_frames=30)]
    assert len(ts) == 30 and all(b > a for a, b in zip(ts, ts[1:]))


def _extract(name, kwargs, sample_video, n=40):
    try:
        backend = create_backend(name, **kwargs)
    except ModelUnavailable as e:
        pytest.skip(f"{name} unavailable: {e}")
    try:
        t0 = time.perf_counter()
        res = extract_pose_sequence(str(sample_video), backend, "test", max_frames=n)
    finally:
        backend.close()
    assert res.stats["frames"] == n
    if validate:
        for fr in res.frames:
            assert validate("poseFrame", fr) == []
    assert res.stats["framing_ok_ratio"] > 0.8
    assert all(fr["tracked_subject_id"] for fr in res.frames)
    assert res.provenance["model_id"] and res.provenance["version"]
    _record(name, res.stats["fps"], {"delegate": res.provenance.get("delegate"), "framing_ok_ratio": res.stats["framing_ok_ratio"], "frames": n,
                                      "wall_s": round(time.perf_counter() - t0, 1)})
    return res


def test_mediapipe_extraction(sample_video, tmp_path):
    res = _extract("mediapipe", {"variant": "full"}, sample_video)
    assert res.frames[0]["landmark_set"] == "mediapipe_pose_33"
    assert "world_landmarks" in res.frames[0]
    out = tmp_path / "seq.jsonl"
    write_jsonl(out, res.frames, header={"provenance": res.provenance})
    back = list(iter_jsonl(out))
    assert len(back) == len(res.frames) and back[0]["frame_id"] == res.frames[0]["frame_id"]
    xy, sc, size = pose_frames_to_coco17(back)
    assert xy.shape == (len(back), 17, 2) and (sc > 0.5).mean() > 0.8 and size == (res.frames[0]["image_size"][0], res.frames[0]["image_size"][1])


def test_rtmo_extraction(sample_video):
    res = _extract("rtmlib_rtmo", {"mode": "balanced"}, sample_video)
    assert res.frames[0]["landmark_set"] == "mediapipe_pose_33"
    # COCO-17 can never supply inner-eye landmarks; they must be absent (visibility 0) but not counted as missing core joints
    lm = {l["id"]: l for l in res.frames[0]["normalized_landmarks"]}
    assert lm[1]["visibility"] == 0.0 and lm[25]["visibility"] > 0.5


def test_rtmpose_body_extraction(sample_video):
    _extract("rtmlib_body", {"mode": "balanced"}, sample_video, n=30)


def test_rtmlib_wholebody_native_custom_set(sample_video):
    try:
        backend = create_backend("rtmlib_wholebody", mode="lightweight")
    except ModelUnavailable as e:
        pytest.skip(str(e))
    try:
        res = extract_pose_sequence(str(sample_video), backend, "test", max_frames=10, canonical=False)
    finally:
        backend.close()
    fr = res.frames[0]
    assert fr["landmark_set"] == "custom" and len(fr["normalized_landmarks"]) == 133
    if validate:
        assert validate("poseFrame", fr) == []
