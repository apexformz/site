import json
import pathlib
import sys

import numpy as np

ML = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

from datasets import propagate_tracks as pt  # noqa: E402
from apexformz_perception.tracking import PointTracker, TrackerInfo, iter_frames, make_trackset, points_to_track, provenance, registry  # noqa: E402


class FakeTracker(PointTracker):
    info = TrackerInfo(name="fake", kind="point", repo="local", license="MIT", commercial_ok=True, online=False, description="test double")

    def available(self):
        return True, "ok"

    def track(self, frames, queries, *, fps=None, video_ref=None, labels=None):
        fl, _ = iter_frames(frames)
        T = len(fl)
        tracks = [points_to_track(f"t{n}", np.tile([[x, y]], (T, 1)) + np.array([[0.001 * t, 0.0] for t in range(T)]), np.ones(T, bool), np.full(T, 0.9), None, label=labels[n] if labels else None, query=(f, x, y)) for n, (f, x, y) in enumerate(queries)]
        return make_trackset(source=provenance("fake", "1"), kind="point", tracks=tracks, frame_count=T, image_size=(fl[0].shape[1], fl[0].shape[0]), fps=fps, retrospective=True, video_ref=video_ref)


def test_queries_from_keyframes_and_poseframes():
    qs, labels = pt.queries_from_keyframes([{"frame_id": 3, "points": [{"label": "implement_head", "x": 0.4, "y": 0.5}, {"x": 0.1, "y": 0.2}]}])
    assert qs == [(3, 0.4, 0.5), (3, 0.1, 0.2)] and labels == ["implement_head", None]
    frames = [{"frame_id": i, "normalized_landmarks": [{"id": 25, "x": 0.3, "y": 0.6, "visibility": 0.9 if i >= 2 else 0.1}]} for i in range(5)]
    qs, labels = pt.queries_from_poseframes(frames, [25])
    assert qs == [(2, 0.3, 0.6)] and labels == ["landmark:25"]


def test_propagate_with_fake_tracker_validates_and_marks_proposal():
    frames = [np.zeros((40, 30, 3), np.uint8) for _ in range(8)]
    ts = pt.propagate(frames, [(0, 0.5, 0.5)], ["implement_head"], FakeTracker(), fps=30.0, video_ref="clip://x")
    assert ts.frame_count == 8 and ts.tracks[0].label == "implement_head"
    assert any("annotation_propagation_proposal" in n for n in ts.notes)


def test_cli_end_to_end(tmp_path, monkeypatch):
    import cv2

    video = tmp_path / "clip.mp4"
    w = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10.0, (32, 24))
    for i in range(6):
        w.write(np.full((24, 32, 3), i * 20, np.uint8))
    w.release()
    kf = tmp_path / "kf.json"
    kf.write_text(json.dumps([{"frame_id": 0, "points": [{"label": "implement_head", "x": 0.5, "y": 0.5}]}]))
    monkeypatch.setitem(registry._FACTORIES, "fake", lambda **kw: FakeTracker())
    monkeypatch.setitem(registry.INFOS, "fake", FakeTracker.info)
    out = tmp_path / "tracks.json"
    rc = pt.main(["--video", str(video), "--keyframes", str(kf), "--tracker", "fake", "--out", str(out)])
    assert rc == 0
    d = json.loads(out.read_text())
    from apexformz_contracts.validate import validate

    assert validate("trackSet", d) == [] and d["frame_count"] == 6 and d["tracks"][0]["label"] == "implement_head"
