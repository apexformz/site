"""Tracker interface conformance, TrackSet contract validation and fusion utilities (no model weights needed)."""
from __future__ import annotations

import numpy as np
import pytest

from apexformz_contracts.models import TrackSet
from apexformz_contracts.validate import validate
from apexformz_perception.tracking import (
    ModelUnavailable, ObjectPrompt, PointTracker, TrackerInfo, assign_tracks_to_subject, fill_landmark_gaps, iter_frames,
    make_trackset, points_to_track, provenance, registry, seed_queries_from_landmarks, track_displacement_stats,
    track_to_equipment_observations, trackset_dict,
)


class FakeTracker(PointTracker):
    """Deterministic linear-motion tracker used by tests and tooling."""

    info = TrackerInfo(name="fake", kind="point", repo="local", license="MIT", commercial_ok=True, online=False, description="test double")

    def available(self):
        return True, "ok"

    def track(self, frames, queries, *, fps=None, video_ref=None, labels=None):
        frame_list, read_fps = iter_frames(frames)
        T = len(frame_list)
        H, W = frame_list[0].shape[:2]
        tracks = []
        for n, (t0, x, y) in enumerate(queries):
            xy = np.stack([x + 0.002 * np.arange(T), np.full(T, y)], axis=1)
            vis = np.ones(T, dtype=bool)
            vis[T // 2] = False  # one occluded frame
            tracks.append(points_to_track(f"fake-{n}", xy, vis, np.where(vis, 0.9, 0.1), None, label=labels[n] if labels else None, query=(t0, x, y)))
        return make_trackset(source=provenance("fake", "1"), kind="point", tracks=tracks, frame_count=T, image_size=(W, H), fps=fps or read_fps, retrospective=True, video_ref=video_ref)


def frames(n=10, h=64, w=48):
    return [np.zeros((h, w, 3), dtype=np.uint8) for _ in range(n)]


def test_fake_tracker_emits_valid_trackset():
    ts = FakeTracker().track(frames(), [(0, 0.5, 0.5), (0, 0.2, 0.8)], fps=30.0, labels=["a", "b"])
    d = trackset_dict(ts)
    assert validate("trackSet", d) == []
    TrackSet.model_validate(d)
    assert ts.kind == "point" and ts.retrospective is True and ts.image_size == [48, 64]
    assert ts.tracks[0].label == "a" and ts.tracks[0].query.frame_id == 0
    assert sum(not p.visible for p in ts.tracks[0].points) == 1
    st = track_displacement_stats(ts)
    assert st["max_step"] < 0.01 and 0.8 < st["mean_visible_fraction"] < 1.0


def test_points_to_track_sanitises_nonfinite():
    xy = np.array([[0.1, 0.1], [np.nan, 0.2], [2.0, -1.0]])
    tr = points_to_track("t", xy, np.array([True, True, True]), None)
    assert tr.points[1].visible is False
    assert tr.points[2].x == 1.5 and tr.points[2].y == -0.5


def test_provenance_omits_unknown_digest():
    p = provenance("m", "v")
    assert "digest" not in p.model_dump(exclude_none=True)
    assert validate("trackSet", trackset_dict(make_trackset(source=p, kind="point", tracks=[], frame_count=0, image_size=(1, 1), fps=None, retrospective=True))) == []


def test_registry_lists_licenses_and_gates():
    d = registry.describe_all(probe=False)
    names = {t["name"] for t in d["trackers"]}
    assert {"bootstapir_offline", "bootstapir_online", "tapnextpp_online", "cotracker3_offline", "sam2.1_video"} <= names
    co = next(t for t in d["trackers"] if t["name"] == "cotracker3_offline")
    assert co["commercial_ok"] is False and co["license_gate"] is True and "NC" in co["license"]
    tap = next(t for t in d["trackers"] if t["name"] == "bootstapir_offline")
    assert tap["commercial_ok"] is True and tap["license"] == "Apache-2.0"
    assert any(f["name"] == "sam3" for f in d["future"])
    with pytest.raises(ModelUnavailable):
        registry.create("nope")


def test_cotracker_license_gate():
    tr = registry.create("cotracker3_offline")
    ok, why = tr.available()
    assert ok is False and why.startswith("LICENSE_GATE")
    with pytest.raises(ModelUnavailable) as ei:
        tr.track(frames(4), [(0, 0.5, 0.5)])
    assert ei.value.reason == "LICENSE_GATE"


def _pose_frames(n=12, missing=range(4, 7), subject="track-1"):
    out = []
    for i in range(n):
        lms = []
        for lid in range(33):
            vis = 0.9
            if lid == 25 and i in missing:
                vis = 0.1
            lms.append({"id": lid, "x": 0.4 + 0.01 * lid / 33 + 0.001 * i, "y": 0.3 + 0.015 * lid / 33 * 10, "visibility": vis, "presence": vis})
        out.append({"frame_id": i, "timestamp_ms": i * 40.0, "normalized_landmarks": lms, "tracked_subject_id": subject, "quality": {"framing_ok": True, "ambiguous_people": False, "missing_joints": [25] if i in missing else []}})
    return out


def test_seed_queries_and_fill_gaps():
    pf = _pose_frames()
    seeds = seed_queries_from_landmarks(pf, [25, 26])
    assert [s["label"] for s in seeds] == ["landmark:25", "landmark:26"] and seeds[0]["frame_id"] == 0
    # Track for landmark 25 covering all frames
    xy = np.stack([np.full(12, 0.42), np.full(12, 0.6)], axis=1)
    tr = points_to_track("lm25", xy, np.ones(12, bool), np.full(12, 0.9), label="landmark:25", query=(0, 0.42, 0.6))
    ts = make_trackset(source=provenance("fake", "1"), kind="point", tracks=[tr], frame_count=12, image_size=(100, 100), fps=25.0, retrospective=True)
    filled = fill_landmark_gaps(pf, ts, max_gap_frames=8)
    for i in (4, 5, 6):
        lm = next(l for l in filled[i]["normalized_landmarks"] if l["id"] == 25)
        assert lm["visibility"] == 0.4 and abs(lm["x"] - 0.42) < 1e-9
        assert filled[i]["quality"]["filled_from_tracks"] == [{"landmark_id": 25, "track_id": "lm25"}]
        assert 25 not in filled[i]["quality"]["missing_joints"]
    # input untouched, long gaps untouched
    assert next(l for l in pf[5]["normalized_landmarks"] if l["id"] == 25)["visibility"] == 0.1
    long_gap = fill_landmark_gaps(_pose_frames(missing=range(2, 11)), ts, max_gap_frames=8)
    assert "filled_from_tracks" not in long_gap[5]["quality"]


def test_assign_tracks_and_equipment_observations():
    pf = _pose_frames()
    near = points_to_track("near", np.stack([np.full(12, 0.41), np.full(12, 0.35)], 1), np.ones(12, bool), None, label="implement_head")
    far = points_to_track("far", np.stack([np.full(12, 0.95), np.full(12, 0.95)], 1), np.ones(12, bool), None, label="other")
    ts = make_trackset(source=provenance("fake", "1"), kind="point", tracks=[near, far], frame_count=12, image_size=(100, 100), fps=None, retrospective=True)
    assigned = assign_tracks_to_subject(ts, pf)
    assert assigned.tracks[0].assigned_subject_id == "track-1" and assigned.tracks[1].assigned_subject_id is None
    obs = track_to_equipment_observations(assigned)
    assert len(obs) == 24 and obs[0]["object_class"] == "implement_head" and obs[0]["assigned_subject_id"] == "track-1"
    assert set(obs[0]) >= {"object_class", "coordinate_system", "frame_id", "timestamp_ms", "confidence", "provenance", "keypoints"}


def test_object_prompt_dataclass():
    p = ObjectPrompt(frame_id=0, label="implement", box=(0.1, 0.1, 0.5, 0.5))
    assert p.points is None and p.label == "implement"
