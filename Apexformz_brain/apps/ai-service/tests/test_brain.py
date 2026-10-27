import json
import shutil
import time

import pytest
from fastapi.testclient import TestClient

from app.brain.packs import PackError, load_pack
from app.brain.retrospective import AnalysisError, analyze_feature_bundle, body_relative, canonicalize
from _synthetic import synthetic_frame
from main import app

client = TestClient(app)


def test_health_reports_contract_version():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["contract_version"] == "1.0.0"


def test_pack_loads_with_verified_digests():
    pack = load_pack("badminton", "1.0.0")
    assert pack["manifest"]["id"] == "badminton"
    assert any(m["id"] == "badminton.lunge" for m in pack["movement_catalog"]["movements"])


def test_pack_hash_mismatch_rejected_closed(tmp_path, repo):
    shutil.copytree(repo / "sport-packs" / "shooting", tmp_path / "shooting")
    p = tmp_path / "shooting" / "feedback_templates.json"
    p.write_text(p.read_text(encoding="utf-8").replace("Set your feet", "Set yer feet"), encoding="utf-8")
    with pytest.raises(PackError) as e:
        load_pack("shooting", root=tmp_path)
    assert e.value.code == "ASSET_HASH_MISMATCH"


def test_canonicalize_mirror_swaps_sides():
    f = synthetic_frame(0, 0, mirror=True)
    out = canonicalize(f)
    lk, rk = 25, 26
    assert out[lk]["x"] == pytest.approx(1 - f["normalized_landmarks"][rk]["x"])
    body, valid, reason = body_relative(out, (1280, 720))
    assert reason is None and body is not None
    # hip midpoint at origin, torso length one
    assert abs((body[23] + body[24])[0]) < 1e-9 and abs((body[23] + body[24])[1]) < 1e-9
    sm = (body[11] + body[12]) / 2
    assert (sm[0] ** 2 + sm[1] ** 2) ** 0.5 == pytest.approx(1.0)


def test_body_relative_reports_missing_root():
    f = synthetic_frame(0, 0)
    f["normalized_landmarks"][23]["visibility"] = 0.1
    body, valid, reason = body_relative(f["normalized_landmarks"], (1280, 720))
    assert body is None and reason == "MISSING_JOINT"


def test_retrospective_lunge_segments_and_abstains(lunge_bundle):
    pack = load_pack("badminton", "1.0.0")
    out = analyze_feature_bundle(lunge_bundle, pack, "badminton.lunge", capabilities=["body_pose", "optional_implement"])
    assert out["retrospective"] is True
    assert out["model_version"] == "retrospective_segmenter@1.0.0"
    states = [e["state"] for e in out["movement_events"]]
    assert "EXECUTING" in states and "COMPLETE" in states
    assert all(e["retrospective"] for e in out["movement_events"])
    assert out["executions"] and out["executions"][0]["completed"]
    phase_ids = [p["phase_id"] for p in out["executions"][0]["phases"]]
    assert phase_ids == ["ready", "drive", "bottom", "recovery"]
    aset = out["assessments"][0]
    assert aset["retrospective"] is True and aset["score"] is None
    by_id = {c["criterion_id"]: c for c in aset["criteria"]}
    # provisional rubric => never a verdict, measurement still filled
    depth = by_id["badminton.lunge.lead_knee_depth"]
    assert depth["state"] == "UNCERTAIN" and depth["measurement"]["reason"] == "RUBRIC_UNVALIDATED"
    assert depth["measurement"]["value"] is not None and abs(depth["measurement"]["value"] - 110) < 4
    contact = by_id["badminton.lunge.racket_contact_height"]
    assert contact["state"] == "NOT_ASSESSABLE" and contact["measurement"]["reason"] == "CONTACT_UNOBSERVED"
    lean = by_id["badminton.lunge.trunk_forward_lean"]
    assert lean["state"] == "NOT_ASSESSABLE" and lean["measurement"]["reason"] == "VIEW_INVALID"
    assert not any(c["state"] in ("PASS", "IMPROVE") for c in aset["criteria"])


def test_retrospective_rejects_unknown_movement(lunge_bundle):
    pack = load_pack("badminton", "1.0.0")
    with pytest.raises(AnalysisError) as e:
        analyze_feature_bundle(lunge_bundle, pack, "badminton.nope")
    assert e.value.code == "UNKNOWN_SPORT_PACK"


def test_job_lifecycle(lunge_bundle):
    body = {"job_id": "job-1", "sport_pack_id": "badminton", "sport_pack_version": "1.0.0", "movement_id": "badminton.lunge",
            "consent_scope": "deep_analysis", "feature_bundle": lunge_bundle, "capabilities": ["body_pose", "optional_implement"]}
    r = client.post("/v1/analysis/jobs", json=body)
    assert r.status_code == 202
    assert r.headers.get("retry-after") == "2"
    for _ in range(50):
        job = client.get("/v1/analysis/jobs/job-1").json()
        if job["status"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(0.05)
    assert job["status"] == "COMPLETED", job.get("error")
    assert job["output"]["retrospective"] is True
    # idempotent resubmission
    r2 = client.post("/v1/analysis/jobs", json=body)
    assert r2.status_code == 202 and r2.json()["idempotent"] is True


def test_job_rejects_missing_consent(lunge_bundle):
    body = {"job_id": "job-2", "sport_pack_id": "badminton", "sport_pack_version": "1.0.0", "movement_id": "badminton.lunge",
            "consent_scope": "marketing", "feature_bundle": lunge_bundle}
    r = client.post("/v1/analysis/jobs", json=body)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "CONSENT_REQUIRED"


def test_job_fails_closed_on_unknown_pack_version(lunge_bundle):
    body = {"job_id": "job-3", "sport_pack_id": "badminton", "sport_pack_version": "9.9.9", "movement_id": "badminton.lunge",
            "consent_scope": "deep_analysis", "feature_bundle": lunge_bundle}
    client.post("/v1/analysis/jobs", json=body)
    for _ in range(50):
        job = client.get("/v1/analysis/jobs/job-3").json()
        if job["status"] in ("COMPLETED", "FAILED"):
            break
        time.sleep(0.05)
    assert job["status"] == "FAILED" and job["error"]["code"] == "UNKNOWN_SPORT_PACK"


def test_unknown_job_404():
    assert client.get("/v1/analysis/jobs/nope").status_code == 404


def test_list_packs():
    ids = {p["id"] for p in client.get("/v1/sport-packs").json()["packs"]}
    assert {"badminton", "shooting", "pickleball", "table_tennis"} <= ids
