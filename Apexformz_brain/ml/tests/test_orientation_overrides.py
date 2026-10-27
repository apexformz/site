import copy
import json
from pathlib import Path

import numpy as np
import pytest

from tools.apply_capture_orientation_overrides import derive_manifest
from tools.prepare_capture_dataset import decode_capture_image, digest, load_orientation_overrides, record_extraction_options


def audit(tmp_path):
    import cv2
    # Distinct corners make rotation direction observable, independent of pose inference.
    image = np.zeros((4, 2, 3), dtype=np.uint8)
    image[0, 0] = [10, 20, 30]
    image[-1, -1] = [40, 50, 60]
    path = tmp_path / "still.png"
    cv2.imwrite(str(path), image)
    record = {"record_id": "r", "media_kind": "image", "source": {"uri": "s3://apexformz-datacapture-test/raw/squash/still.png"}}
    row = {"record_id": "r", "source_sha256": digest(path), "source_uri": record["source"]["uri"],
           "encoded_size": [2, 4], "rotate_degrees_ccw": 90, "reason": "Visually verified floor on left"}
    doc = {"kind": "apexformz.source_orientation_overrides", "schema_version": "1.0.0", "review_status": "visually_verified",
           "reviewer_id": "orientation-reviewer", "records": [row]}
    pin = tmp_path / "overrides.json"
    pin.write_text(json.dumps(doc), encoding="utf-8")
    return image, path, record, pin, doc


def test_exact_reviewed_source_rotates_ccw_without_modifying_media(tmp_path):
    original, path, record, pin, _ = audit(tmp_path)
    before = digest(path)
    options = record_extraction_options(record, before, {"orientation_policy": "encoded", "orientation_overrides": str(pin)})
    decoded = decode_capture_image(path, "encoded", options["orientation_override"])
    np.testing.assert_array_equal(decoded, np.rot90(original))
    assert digest(path) == before
    assert options["orientation_override"]["audit_document_sha256"] == digest(pin)


def test_portrait_shape_does_not_authorize_rotation(tmp_path):
    original, path, record, pin, _ = audit(tmp_path)
    record["record_id"] = "not-audited"
    options = record_extraction_options(record, digest(path), {"orientation_policy": "encoded", "orientation_overrides": str(pin)})
    assert "orientation_override" not in options
    np.testing.assert_array_equal(decode_capture_image(path, "encoded"), original)


@pytest.mark.parametrize("change", ["checksum", "uri", "video", "metadata"])
def test_override_fails_closed_for_other_source_or_decode_policy(tmp_path, change):
    _, path, record, pin, _ = audit(tmp_path)
    checksum = digest(path)
    options = {"orientation_policy": "encoded", "orientation_overrides": str(pin)}
    if change == "checksum": checksum = "0" * 64
    if change == "uri": record["source"]["uri"] += "-other"
    if change == "video": record["media_kind"] = "video"
    if change == "metadata": options["orientation_policy"] = "metadata"
    with pytest.raises(ValueError, match="exact encoded image"):
        record_extraction_options(record, checksum, options)


def test_audit_requires_review_and_exact_dimensions(tmp_path):
    _, path, _, pin, doc = audit(tmp_path)
    override = load_orientation_overrides(pin)["r"]
    override["encoded_size"] = [4, 2]
    with pytest.raises(ValueError, match="dimensions"):
        decode_capture_image(path, "encoded", override)
    doc["review_status"] = "pending"
    pin.write_text(json.dumps(doc), encoding="utf-8")
    with pytest.raises(ValueError, match="visual audit"):
        load_orientation_overrides(pin)


def test_derived_manifest_preserves_source_identity_splits_attestations_and_parent():
    parent = {"dataset_version": "old", "pose_model": {"digest": "pose-model"},
              "cameras": [{"camera_id": "c", "resolution": [720, 1280]}],
              "view_streams": [{"source_record_id": "r", "camera_id": "c", "sha256": "source", "pose_path": "old.jsonl",
                                "pose_sha256": "old-pose", "extraction": {"orientation_policy": "encoded"}}],
              "provenance": {"processing_config": {"dataset_identity": {"old": "identity"}}},
              "executions": [{"execution_id": "capture-r", "athlete_id": "ATH_0005", "movement_id": "squash.static.0001"}],
              "splits": {"assignments": {"capture-r": "train"}}, "athletes": [{"athlete_id": "ATH_0005", "handedness": "right"}],
              "owner_attestations": {"sha256": "attestation"}}
    original = copy.deepcopy(parent)
    meta = {"source_sha256": "source", "pose_model": parent["pose_model"], "frames": 1, "start_ms": 0, "end_ms": 0,
            "video": {"width": 1280, "height": 720}, "pose_path": "new.jsonl", "pose_sha256": "new-pose",
            "extraction": {"orientation_policy": "encoded", "orientation_override": {"rotate_degrees_ccw": 90}}, "extractor_sha256": "code"}
    updated = derive_manifest(parent, {"r": meta}, parent_sha256="parent", audit_sha256="audit", snapshot="archived.json")
    assert parent == original
    for field in ("executions", "splits", "athletes", "owner_attestations"):
        assert updated[field] == parent[field]
    assert updated["view_streams"][0]["orientation_lineage"]["parent_pose_sha256"] == "old-pose"
    assert updated["cameras"][0]["resolution"] == [1280, 720]
    assert updated["dataset_version"] != parent["dataset_version"]
    meta["source_sha256"] = "wrong"
    with pytest.raises(ValueError, match="source/model"):
        derive_manifest(parent, {"r": meta}, parent_sha256="parent", audit_sha256="audit", snapshot="archived.json")


@pytest.mark.parametrize("validation", ["provisional", "approved"])
def test_reference_refresh_preserves_rules_and_cannot_rewrite_approved_model(tmp_path, validation):
    from tools.refresh_squash_references import refresh
    pack = tmp_path / "pack"
    models = pack / "models/reference"
    models.mkdir(parents=True)
    frozen = ["phase_graphs.json", "technique_criteria.json", "movement_catalog.json", "feedback_templates.json"]
    for name in frozen:
        (pack / name).write_text('{"keep":"exact bytes"}', encoding="utf-8")
    model_path = models / "squash.static.0001.json"
    model_path.write_text(json.dumps({"features": ["angle"], "weights": [1], "reference_vectors": [[10], [11]],
        "validation_status": validation, "threshold": 17, "tolerance": 4}), encoding="utf-8")
    before = model_path.read_bytes()
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"dataset_version": "corrected"}), encoding="utf-8")
    vectors = tmp_path / "vectors.json"
    vectors.write_text(json.dumps({"features": ["angle"], "captures_used": 2, "captures_skipped": 0, "rejected_frames": {},
        "vectors": {"squash.static.0001": [{"values": [20], "view": "front"}, {"values": [21], "view": "right"}]}}), encoding="utf-8")
    if validation == "approved":
        with pytest.raises(ValueError, match="provisional"):
            refresh(manifest, vectors, pack, tmp_path / "report.json")
        assert model_path.read_bytes() == before
    else:
        refresh(manifest, vectors, pack, tmp_path / "report.json")
        updated = json.loads(model_path.read_text(encoding="utf-8"))
        assert updated["reference_vectors"] == [[20], [21]]
        assert (updated["threshold"], updated["tolerance"], updated["validation_status"]) == (17, 4, "provisional")
    assert all((pack / name).read_text(encoding="utf-8") == '{"keep":"exact bytes"}' for name in frozen)
