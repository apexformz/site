"""/v1/tracking jobs: registry listing, consent and license gates, and a point_track job run with a fake tracker."""
from __future__ import annotations

import base64
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from apexformz_perception.tracking import PointTracker, TrackerInfo, iter_frames, make_trackset, points_to_track, provenance, registry
from main import app

client = TestClient(app)


class FakeTracker(PointTracker):
    info = TrackerInfo(name="fake_point", kind="point", repo="local", license="MIT", commercial_ok=True, online=False, description="test double")

    def available(self):
        return True, "ok"

    def track(self, frames, queries, *, fps=None, video_ref=None, labels=None):
        fl, _ = iter_frames(frames)
        T = len(fl)
        H, W = fl[0].shape[:2]
        tracks = [points_to_track(f"f{n}", np.tile([[x, y]], (T, 1)), np.ones(T, bool), np.full(T, 0.95), None, label=labels[n] if labels else None, query=q) for n, q in enumerate(queries) for (_, x, y) in [q]]
        return make_trackset(source=provenance("fake", "1"), kind="point", tracks=tracks, frame_count=T, image_size=(W, H), fps=fps, retrospective=True, video_ref=video_ref)


@pytest.fixture(autouse=True)
def fake_registry(monkeypatch):
    monkeypatch.setitem(registry._FACTORIES, "fake_point", lambda **kw: FakeTracker())
    monkeypatch.setitem(registry.INFOS, "fake_point", FakeTracker.info)
    yield


def _frames_b64(n=6):
    out = []
    for i in range(n):
        img = np.full((32, 24, 3), i * 10, dtype=np.uint8)
        ok, buf = cv2.imencode(".png", img)
        out.append(base64.b64encode(buf.tobytes()).decode("ascii"))
    return out


def _wait(job_id, timeout=10.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get(f"/v1/tracking/jobs/{job_id}")
        if r.json()["status"] in ("COMPLETED", "FAILED"):
            return r.json()
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_trackers_listing_exposes_license_gates():
    r = client.get("/v1/tracking/trackers", params={"probe": "false"})
    assert r.status_code == 200
    names = {t["name"]: t for t in r.json()["trackers"]}
    assert names["cotracker3_offline"]["commercial_ok"] is False and names["cotracker3_offline"]["license_gate"] is True
    assert names["bootstapir_offline"]["license"] == "Apache-2.0"
    assert any(f["name"] == "sam3" for f in r.json()["future"])


def test_consent_required():
    r = client.post("/v1/tracking/jobs", json={"job_id": "c1", "kind": "point_track", "consent_scope": "marketing", "tracker": "fake_point", "frames_b64": _frames_b64(), "queries": [{"frame_id": 0, "x": 0.5, "y": 0.5}]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "CONSENT_REQUIRED"


def test_noncommercial_tracker_refused_without_opt_in():
    body = {"job_id": "lic1", "kind": "point_track", "consent_scope": "deep_analysis", "tracker": "cotracker3_offline", "frames_b64": _frames_b64(), "queries": [{"frame_id": 0, "x": 0.5, "y": 0.5}]}
    r = client.post("/v1/tracking/jobs", json=body)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "LICENSE_GATE"


def test_unknown_tracker_and_kind_mismatch():
    r = client.post("/v1/tracking/jobs", json={"job_id": "u1", "kind": "point_track", "consent_scope": "deep_analysis", "tracker": "nope", "frames_b64": _frames_b64(), "queries": [{"frame_id": 0, "x": 0.5, "y": 0.5}]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "UNKNOWN_MODEL_ID"
    r = client.post("/v1/tracking/jobs", json={"job_id": "u2", "kind": "object_track", "consent_scope": "deep_analysis", "tracker": "fake_point", "frames_b64": _frames_b64(), "prompts": [{"frame_id": 0, "label": "x", "box": [0.1, 0.1, 0.5, 0.5]}]})
    assert r.status_code == 422


def test_point_track_job_lifecycle_and_idempotency():
    body = {"job_id": "pt1", "kind": "point_track", "consent_scope": "quality_improvement", "tracker": "fake_point", "frames_b64": _frames_b64(), "session_id": "sess-x",
            "queries": [{"frame_id": 0, "x": 0.5, "y": 0.5, "label": "implement_head"}, {"frame_id": 0, "x": 0.2, "y": 0.3}]}
    r = client.post("/v1/tracking/jobs", json=body)
    assert r.status_code == 202 and r.headers["Retry-After"] == "2" and r.json()["status"] in ("QUEUED", "RUNNING", "COMPLETED")
    job = _wait("pt1")
    assert job["status"] == "COMPLETED", job
    out = job["output"]
    from apexformz_contracts.validate import validate

    assert validate("trackSet", out) == []
    assert out["frame_count"] == 6 and len(out["tracks"]) == 2 and out["tracks"][0]["label"] == "implement_head" and out["session_id"] == "sess-x"
    r2 = client.post("/v1/tracking/jobs", json=body)
    assert r2.status_code == 202 and r2.json()["idempotent"] is True


def test_missing_media_fails_with_structured_error():
    body = {"job_id": "nm1", "kind": "point_track", "consent_scope": "deep_analysis", "tracker": "fake_point", "video_path": "C:/definitely/missing.mp4", "queries": [{"frame_id": 0, "x": 0.5, "y": 0.5}]}
    r = client.post("/v1/tracking/jobs", json=body)
    assert r.status_code == 202
    job = _wait("nm1")
    assert job["status"] == "FAILED" and job["error"]["code"] == "SCHEMA_INVALID" and job["error"]["retryable"] is False
