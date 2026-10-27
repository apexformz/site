import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("squash_annotation_review", ROOT / "tools/squash_annotation_review.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def fixture():
    bundle = {"sources": {"capture-1": {
        "static": False, "start_ms": 0, "end_ms": 1000, "split": "val", "athlete_id": "athlete-1",
        "capture_session_id": "session-1", "streams": {"stream-1": {"view": "back", "source_sha256": "abc"}},
    }}}
    rubric = {"movements": [{"id": "squash.dynamic.0001", "type": "dynamic", "criteria": ["squash.dynamic.0001.balance"]}],
              "graphs": [{"movement_id": "squash.dynamic.0001", "phases": [{"id": "ready"}, {"id": "swing"}],
                          "edges": [{"from": "ready", "to": "swing"}, {"from": "swing", "to": "ready"}]}]}
    row = {"execution_id": "rep-1", "source_execution_id": "capture-1", "stream_id": "stream-1",
           "movement_id": "squash.dynamic.0001", "review_status": "reviewed", "annotator_id": "coach-1",
           "annotation_version": 1, "disagreement": None, "view": "back", "handedness": "unknown",
           "static": False, "start_ms": 100, "end_ms": 500,
           "phases": [{"phase_id": "ready", "start_ms": 100, "end_ms": 200},
                      {"phase_id": "swing", "start_ms": 200, "end_ms": 500}],
           "criteria": {"squash.dynamic.0001.balance": "NOT_ASSESSABLE"}}
    return bundle, rubric, row


def test_repetitions_inherit_source_holdout_and_identity():
    bundle, rubric, row = fixture()
    second = {**row, "execution_id": "rep-2", "start_ms": 500, "end_ms": 1000, "phases": [], "split": "train", "athlete_id": "spoof"}
    rows, splits = review.validate_reviews(bundle, rubric, [row, second])
    assert splits["assignments"] == {"rep-1": "val", "rep-2": "val"}
    assert rows[1]["athlete_id"] == "athlete-1"
    assert rows[0]["handedness"] == "unknown"
    assert rows[1]["phases"] == []  # no phase labels invented


@pytest.mark.parametrize("change, message", [
    ({"review_status": "pending"}, "review_status"),
    ({"annotator_id": "importer:source"}, "annotator_id"),
    ({"annotation_version": True}, "annotation_version"),
    ({"source_execution_id": "missing"}, "source_execution_id"),
    ({"stream_id": "other-camera"}, "stream"),
    ({"view": "front"}, "view"),
    ({"end_ms": 1001}, "exceed"),
    ({"start_ms": float("nan")}, "finite"),
    ({"criteria": {}}, "exactly"),
    ({"criteria": {"squash.dynamic.0001.balance": None}}, "outcome"),
    ({"disagreement": {"outcome": "disputed"}}, "disagreement"),
    ({"phases": [{"phase_id": "contact_observed", "start_ms": 200, "end_ms": 300}]}, "phase ID"),
    ({"phases": [{"phase_id": "ready", "start_ms": 100, "end_ms": 300}, {"phase_id": "swing", "start_ms": 200, "end_ms": 500}]}, "overlap"),
])
def test_invalid_reviews_never_become_fit_inputs(change, message):
    bundle, rubric, row = fixture()
    with pytest.raises(ValueError, match=message):
        review.validate_reviews(bundle, rubric, [{**row, **change}])


def test_duplicate_or_overlapping_executions_rejected():
    bundle, rubric, row = fixture()
    with pytest.raises(ValueError, match="unique execution_id"):
        review.validate_reviews(bundle, rubric, [row, row])
    with pytest.raises(ValueError, match="overlapping"):
        review.validate_reviews(bundle, rubric, [row, {**row, "execution_id": "rep-2"}])


def test_legal_phase_cycles_are_retained_but_illegal_transitions_rejected():
    bundle, rubric, row = fixture()
    row["phases"][-1]["end_ms"] = 300
    row["phases"].append({"phase_id": "ready", "start_ms": 300, "end_ms": 500})
    rows, _ = review.validate_reviews(bundle, rubric, [row])
    assert [p["phase_id"] for p in rows[0]["phases"]] == ["ready", "swing", "ready"]
    rubric["graphs"][0]["edges"] = [{"from": "ready", "to": "swing"}]
    with pytest.raises(ValueError, match="transition"):
        review.validate_reviews(bundle, rubric, [row])


def test_unknown_is_independently_reviewed_without_invented_technique():
    bundle, rubric, row = fixture()
    unknown = {**row, "movement_id": "UNKNOWN", "phases": [], "criteria": {}}
    rows, _ = review.validate_reviews(bundle, rubric, [unknown])
    assert rows[0]["movement_id"] == "UNKNOWN"
    with pytest.raises(ValueError, match="cannot supply temporal phases"):
        review.validate_reviews(bundle, rubric, [{**unknown, "phases": row["phases"]}])


def test_photo_has_no_fabricated_duration():
    bundle, rubric, row = fixture()
    source = bundle["sources"]["capture-1"]
    source.update(static=True, start_ms=0, end_ms=0)
    rubric["movements"][0]["type"] = "static"
    row.update(static=True, start_ms=0, end_ms=0, phases=[])
    rows, _ = review.validate_reviews(bundle, rubric, [row])
    assert rows[0]["end_ms"] == 0


@pytest.mark.parametrize("orientation_override", [None, {"rotate_degrees_ccw": 90, "source_sha256": "abc", "audit_document_sha256": "audited"}])
def test_export_pins_sources_and_leaves_labels_pending(tmp_path, orientation_override):
    pack = tmp_path / "pack"
    pack.mkdir()
    bundle, rubric, row = fixture()
    review.write_json(pack / "movement_catalog.json", {"sport_id": "squash", "movements": rubric["movements"]})
    review.write_json(pack / "phase_graphs.json", {"graphs": rubric["graphs"]})
    review.write_json(pack / "technique_criteria.json", {"criteria": []})
    pose_path, media_path = tmp_path / "pose.jsonl", tmp_path / "clip.mp4"
    pose_path.write_text('{}\n', encoding="utf-8")
    media_path.write_bytes(b"source media fixture")
    stream = {"view_stream_id": "stream-1", "object_uri": "s3://apexformz-datacapture-test-media/raw/squash/clip.mp4",
              "sha256": review.digest(media_path), "view": "back", "pose_path": "pose.jsonl", "pose_sha256": review.digest(pose_path),
              "source_record_id": "record-1",
              "extraction": {"orientation_policy": "encoded", "orientation_override": orientation_override}}
    execution = {k: v for k, v in bundle["sources"]["capture-1"].items() if k not in {"streams", "split"}}
    execution.update(execution_id="capture-1", movement_id="squash.dynamic.0001", view_stream_ids=["stream-1"])
    manifest = {"sport_pack_id": "squash", "view_streams": [stream], "executions": [execution], "splits": {"assignments": {"capture-1": "val"}}}
    manifest_path = tmp_path / "manifest.json"
    review.write_json(manifest_path, manifest)
    inventory = tmp_path / "inventory.json"
    review.write_json(inventory, {"records": [{"record_id": "record-1", "local_path": str(media_path)}]})
    target = tmp_path / "review"
    assert review.export_review([manifest_path], pack, target, inventory)["reviewed"] == 0
    verified = review.verify_bundle(target / "bundle.json", verify_local_files=True)
    assert verified["pose_files_verified"] == verified["media_files_verified"] == 1
    assert verified["human_labels_validated"] is False
    for source_path in (pose_path, media_path):
        original = source_path.read_bytes()
        source_path.write_bytes(b"tampered")
        with pytest.raises(ValueError, match="digest mismatch"):
            review.verify_bundle(target / "bundle.json", verify_local_files=True)
        source_path.write_bytes(original)
    task = json.loads((target / "tasks.template.jsonl").read_text())
    assert task["review_status"] == "pending" and task["start_ms"] is None and task["phases"] == []
    assert set(task["criteria"].values()) == {None}
    with pytest.raises(FileExistsError):
        review.export_review([manifest_path], pack, target)
    labels = tmp_path / "reviewed.jsonl"
    review.write_jsonl(labels, [row])
    output = tmp_path / "validated"
    review.validate_files(target / "bundle.json", labels, output)
    assert review.read_json(output / "splits.json")["assignments"] == {"rep-1": "val"}
    pinned_bundle = review.read_json(target / "bundle.json")
    assert pinned_bundle["sources"]["capture-1"]["streams"]["stream-1"]["orientation_override"] == orientation_override
    pinned_bundle["sources"]["capture-1"]["streams"]["stream-1"]["orientation_override"] = {"rotate_degrees_ccw": 180}
    review.write_json(target / "bundle.json", pinned_bundle)
    with pytest.raises(ValueError, match="stream differs"):
        review.validate_files(target / "bundle.json", labels, tmp_path / "rotated")
    pinned_bundle["sources"]["capture-1"]["streams"]["stream-1"]["orientation_override"] = orientation_override
    pinned_bundle["sources"]["capture-1"]["split"] = "train"
    review.write_json(target / "bundle.json", pinned_bundle)
    with pytest.raises(ValueError, match="source differs"):
        review.validate_files(target / "bundle.json", labels, tmp_path / "tampered")
    manifest["splits"]["assignments"]["capture-1"] = "train"
    review.write_json(manifest_path, manifest)
    with pytest.raises(ValueError, match="manifest changed"):
        review.validate_files(target / "bundle.json", labels, tmp_path / "wrong")
    assert not (tmp_path / "wrong").exists()
    manifest["view_streams"][0]["object_uri"] = "s3://unrelated-source/raw/squash/clip.mp4"
    review.write_json(manifest_path, manifest)
    with pytest.raises(ValueError, match="not squash Data Capture"):
        review.export_review([manifest_path], pack, tmp_path / "out")
    assert not (tmp_path / "out").exists()
