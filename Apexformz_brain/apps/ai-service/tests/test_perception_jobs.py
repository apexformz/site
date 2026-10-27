import json
import pathlib
import sys
import time

import pytest
from fastapi.testclient import TestClient

REPO = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "packages" / "perception-py"))

from main import app  # noqa: E402

client = TestClient(app)
VIDEO = REPO.parent / "Apexformz" / "taekwando_training_videos" / "Ap_chagi_front_kick" / "front.mp4"


def _wait(job_id: str, timeout: float = 240.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        job = client.get(f"/v1/perception/jobs/{job_id}").json()
        if job["status"] in ("COMPLETED", "FAILED"):
            return job
        time.sleep(0.2)
    raise AssertionError("job did not finish")


def test_backends_endpoint():
    r = client.get("/v1/perception/backends")
    assert r.status_code == 200
    assert "mediapipe" in r.json()["pose"] and r.json()["lifters"]["videopose3d"]["commercial_ok"] is False


def test_consent_required_and_validation():
    r = client.post("/v1/perception/jobs", json={"job_id": "p-bad", "kind": "pose_extract", "consent_scope": "nope", "video_path": "x.mp4"})
    assert r.status_code == 422
    r = client.post("/v1/perception/jobs", json={"job_id": "p-bad2", "kind": "pose_extract", "consent_scope": "deep_analysis"})
    assert r.status_code == 422
    r = client.post("/v1/perception/jobs", json={"job_id": "p-bad3", "kind": "lift_3d", "consent_scope": "deep_analysis"})
    assert r.status_code == 422
    assert client.get("/v1/perception/jobs/does-not-exist").status_code == 404


def test_missing_video_fails_closed():
    r = client.post("/v1/perception/jobs", json={"job_id": "p-missing", "kind": "pose_extract", "consent_scope": "deep_analysis", "video_path": "C:/nope/none.mp4"})
    assert r.status_code == 202
    job = _wait("p-missing")
    assert job["status"] == "FAILED" and job["error"]["code"] == "SCHEMA_INVALID"


def test_unknown_backend_reports_model_unavailable_or_invalid():
    r = client.post("/v1/perception/jobs", json={"job_id": "p-unknown", "kind": "pose_extract", "consent_scope": "deep_analysis",
                                                 "video_path": str(VIDEO) if VIDEO.exists() else "C:/nope.mp4", "backend": "rtmlib_nonexistent"})
    assert r.status_code == 202
    job = _wait("p-unknown")
    assert job["status"] == "FAILED"


@pytest.mark.skipif(not VIDEO.exists(), reason="sample video missing")
def test_pose_extract_then_lift_requires_license_opt_in(tmp_path, monkeypatch):
    monkeypatch.setenv("APEXFORMZ_JOBS_DIR", str(tmp_path))
    r = client.post("/v1/perception/jobs", json={"job_id": "p-extract", "kind": "pose_extract", "consent_scope": "deep_analysis",
                                                 "video_path": str(VIDEO), "backend": "mediapipe", "backend_options": {"variant": "lite"}, "max_frames": 30})
    assert r.status_code == 202 and r.headers.get("Retry-After") == "2"
    job = _wait("p-extract")
    if job["status"] == "FAILED" and job["error"]["code"] == "MODEL_UNAVAILABLE":
        pytest.skip(f"model unavailable: {job['error']['message']}")
    assert job["status"] == "COMPLETED", job
    out = job["output"]
    assert out["frame_count"] == 30 and out["retrospective"] is True and out["provenance"]["model_id"] == "mediapipe_pose_landmarker"
    assert pathlib.Path(out["output_ref"]).exists()
    # idempotent re-post
    r2 = client.post("/v1/perception/jobs", json={"job_id": "p-extract", "kind": "pose_extract", "consent_scope": "deep_analysis", "video_path": str(VIDEO)})
    assert r2.json()["idempotent"] is True

    # lift_3d with a non-commercial lifter is refused unless opted in
    r = client.post("/v1/perception/jobs", json={"job_id": "p-lift-refused", "kind": "lift_3d", "consent_scope": "deep_analysis",
                                                 "pose_jsonl_path": out["output_ref"], "lifter": "videopose3d"})
    job = _wait("p-lift-refused")
    assert job["status"] == "FAILED" and job["error"]["code"] in ("LICENSE_RESTRICTED", "MODEL_UNAVAILABLE")

    r = client.post("/v1/perception/jobs", json={"job_id": "p-lift", "kind": "lift_3d", "consent_scope": "deep_analysis",
                                                 "pose_jsonl_path": out["output_ref"], "lifter": "videopose3d", "allow_noncommercial": True})
    job = _wait("p-lift")
    if job["status"] == "FAILED" and job["error"]["code"] == "MODEL_UNAVAILABLE":
        pytest.skip(f"lifter weights unavailable: {job['error']['message']}")
    assert job["status"] == "COMPLETED", job
    lifted = json.loads(pathlib.Path(job["output"]["output_ref"]).read_text())
    assert lifted["coordinate_system"] == "estimated_world" and lifted["retrospective"] is True and lifted["commercial_ok"] is False
    assert len(lifted["frames"]) == 30 and len(lifted["frames"][0]["joints"]) == 17
