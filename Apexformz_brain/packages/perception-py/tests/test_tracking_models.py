"""Real-video smoke tests for the open-source trackers. Each test skips (with the reason) when the
model code, weights or clip are unavailable, so CI without GPU/weights stays green.

Clip: the legacy ApexFormz taekwondo front-kick recording (24 frames at stride 4, 480x864) when present.
"""
from __future__ import annotations

import os
import pathlib

import numpy as np
import pytest

from apexformz_contracts.validate import validate
from apexformz_perception.tracking import ObjectPrompt, model_cache_dir, registry, track_displacement_stats, trackset_dict

CLIP = pathlib.Path(os.environ.get(
    "APEXFORMZ_TEST_CLIP",
    r"C:\Users\ASUS\Desktop\IITK Composit\Apexformz\taekwando_training_videos\Ap_chagi_front_kick\front.mp4",
))
QUERIES = [(0, 0.72, 0.39), (0, 0.50, 0.39), (0, 0.64, 0.72), (0, 0.45, 0.69), (0, 0.61, 0.84), (0, 0.51, 0.75)]  # shoulders/knees/ankles on frame 0
LABELS = ["left_shoulder", "right_shoulder", "left_knee", "right_knee", "left_ankle", "right_ankle"]


def _ckpt(name: str) -> bool:
    return (model_cache_dir() / "checkpoints" / name).exists()


@pytest.fixture(scope="module")
def clip():
    if not CLIP.exists():
        pytest.skip(f"test clip not found: {CLIP}")
    from apexformz_perception.tracking._video import read_video

    frames, fps = read_video(str(CLIP), max_frames=24, stride=4)
    return frames, fps


def _require(name: str, ckpt: str | None = None, **kw):
    if ckpt and not _ckpt(ckpt) and os.environ.get("APEXFORMZ_DOWNLOAD_WEIGHTS") != "1":
        pytest.skip(f"{name}: checkpoint {ckpt} not in cache (set APEXFORMZ_DOWNLOAD_WEIGHTS=1 to fetch)")
    tr = registry.create(name, **kw)
    ok, why = tr.available()
    if not ok:
        pytest.skip(f"{name} unavailable: {why}")
    return tr


def _check_point_trackset(ts, expect_retro: bool, min_visible=0.6, max_step=0.12):
    assert validate("trackSet", trackset_dict(ts)) == []
    assert ts.kind == "point" and ts.retrospective is expect_retro and len(ts.tracks) == len(QUERIES)
    st = track_displacement_stats(ts)
    assert st["mean_visible_fraction"] >= min_visible, st
    assert st["max_step"] <= max_step, st  # no teleporting between consecutive frames (normalised units)
    assert ts.source.model_id and ts.source.digest, "provenance digest required for cached checkpoints"


def test_bootstapir_offline(clip):
    frames, fps = clip
    tr = _require("bootstapir_offline", "bootstapir_checkpoint_v2.pt")
    ts = tr.track(frames, QUERIES, fps=fps, labels=LABELS)
    _check_point_trackset(ts, expect_retro=True)
    assert ts.tracks[0].label == "left_shoulder"


def test_bootstapir_online_is_causal(clip):
    frames, fps = clip
    tr = _require("bootstapir_online", "causal_bootstapir_checkpoint.pt")
    tr.start(frames[0], [(x, y) for _, x, y in QUERIES], labels=LABELS)
    for f in frames[1:]:
        pts = tr.step(f)
        assert len(pts) == len(QUERIES)
    ts = tr.finish(fps=fps)
    _check_point_trackset(ts, expect_retro=False)
    # first frame tracks must stay at the query points (causal model saw nothing else yet)
    for n, (_, x, y) in enumerate(QUERIES):
        p0 = ts.tracks[n].points[0]
        assert abs(p0.x - x) < 0.05 and abs(p0.y - y) < 0.05


def test_tapnextpp_online(clip):
    frames, fps = clip
    tr = _require("tapnextpp_online", "tapnextpp_ckpt.pt")
    ts = tr.track_clip(frames, QUERIES, fps=fps, labels=LABELS)
    _check_point_trackset(ts, expect_retro=False)


def test_cotracker3_offline_research_only(clip):
    frames, fps = clip
    tr = _require("cotracker3_offline", allow_noncommercial=True)
    ts = tr.track(frames, QUERIES, fps=fps, labels=LABELS)
    _check_point_trackset(ts, expect_retro=True)
    assert any("CC-BY-NC" in n for n in ts.notes)


def test_sam2_object_track(clip):
    frames, fps = clip
    tr = _require("sam2.1_video", "sam2.1_hiera_tiny.pt")
    xs = [q[1] for q in QUERIES]
    ys = [q[2] for q in QUERIES]
    box = (min(xs) - 0.05, min(ys) - 0.05, max(xs) + 0.05, max(ys) + 0.05)
    ts = tr.track(frames, [ObjectPrompt(frame_id=0, label="athlete_body", box=box)], fps=fps)
    assert validate("trackSet", trackset_dict(ts)) == []
    assert ts.kind == "object" and len(ts.tracks) == 1 and ts.tracks[0].label == "athlete_body"
    pts = ts.tracks[0].points
    visible = [p for p in pts if p.visible]
    assert len(visible) / len(pts) >= 0.8
    assert all(p.bbox is not None and p.bbox[2] > p.bbox[0] for p in visible)
    cx = np.array([p.x for p in visible])
    assert 0.2 < cx.mean() < 0.9
