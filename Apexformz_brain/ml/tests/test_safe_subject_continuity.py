import json
from pathlib import Path
import sys
import hashlib

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml"))
from datasets.jsonl_dataset import read_jsonl
from training.train import TrainConfig, input_contract

CASES = json.loads((ROOT / "tests/fixtures/subject_continuity_cases.json").read_text())


def pose(row, index):
    points = [{"id": i, "x": .5 + row["dx"], "y": .5, "z": 0, "visibility": .95} for i in range(33)]
    for i, (x, y) in {11: (.45, .35), 12: (.55, .35), 23: (.47, .55), 24: (.53, .55)}.items():
        points[i].update(x=x + row["dx"], y=y)
    return {"schema_version": "1.0.0", "session_id": "s", "frame_id": index, "timestamp_ms": row["t"],
            "camera_id": row.get("camera", "c"), "image_size": [1280, 720], "mirror": False,
            "orientation": "landscape", "landmark_set": "mediapipe_pose_33", "normalized_landmarks": points,
            "tracked_subject_id": row.get("track", "athlete"), "quality": {"framing_ok": True,
                "ambiguous_people": row.get("ambiguous", False), "track_changed": row.get("changed", False), "missing_joints": []},
            "provenance": {"model_id": "test", "version": "1"}}


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_safe_continuity_matches_browser_cases(case, tmp_path):
    file = tmp_path / "poses.jsonl"
    rows = [pose(row, index) for index, row in enumerate(case["rows"])]
    original = json.dumps(rows)
    file.write_text("\n".join(json.dumps(row) for row in rows))
    frames = read_jsonl(file, "mediapipe_pose_33", frame_gate="identity_only", subject_continuity="tracker_root_v1")
    assert [bool(f.valid.any()) for f in frames] == case["valid"]
    assert [f.continuity_break for f in frames] == case["breaks"]
    assert all((f.body == 0).all() for f in frames if not f.valid.any())
    assert json.dumps(rows) == original


def test_export_input_identifies_legacy_unsafe_continuity():
    for policy in ["tracker", "tracker_root_v1", "geometric"]:
        cfg = TrainConfig(classes=["capture", "UNKNOWN"], subject_continuity=policy)
        assert input_contract(cfg)["subject_continuity"] == policy


def test_safe_policy_cannot_change_unversioned_jump_thresholds(tmp_path):
    with pytest.raises(ValueError, match="versioned"):
        read_jsonl(tmp_path / "unused", "mediapipe_pose_33", subject_continuity="tracker_root_v1", max_root_jump=100)


def test_canonical_display_names_use_exact_ids_and_preserve_original_evidence(tmp_path):
    sys.path.insert(0, str(ROOT / "tools"))
    from train_squash_models import resolve_display_names, install_artifacts
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps({"movements": [{"movement_id": "squash.dynamic.0079", "name": "T \u2192 right side"}]}))
    original = {"squash.dynamic.0079": "T corrupted arrow right side", "unmatched": "T corrupted arrow right side", "UNKNOWN": "Unknown / other movement"}
    names, provenance = resolve_display_names(original, catalog)
    assert names["squash.dynamic.0079"] == "T \u2192 right side"
    assert names["unmatched"] == original["unmatched"]  # no fuzzy/name remapping
    assert provenance["original_manifest_class_names"] == original
    assert provenance["catalog_sha256"] == hashlib.sha256(catalog.read_bytes()).hexdigest()
    assert provenance["unmatched_class_ids"] == ["unmatched"]
    deployment = tmp_path / "unsafe.json"
    deployment.write_text(json.dumps({"input": {"subject_continuity": "geometric"}}))
    with pytest.raises(ValueError, match="live-incompatible"):
        install_artifacts([{"artifacts": {"deployment": str(deployment)}}], tmp_path / "public")
    assert not (tmp_path / "public").exists()
