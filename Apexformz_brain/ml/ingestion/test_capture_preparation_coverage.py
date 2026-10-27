import json

import pytest

from tools.capture_preparation_coverage import annotate_source_coverage
from tools.prepare_capture_dataset import digest


def fixture(tmp_path):
    records = [{"record_id": rid, "source_movement_id": label, "source_movement_name": name,
                "movement_type": "static", "media_kind": "image", "local_path": "capture.jpg",
                "validation": {"eligible_media": True}} for rid, label, name in
               [("good", "squash.static.001", "Ready"), ("bad", "squash.static.002", "Missing torso")]]
    inventory = tmp_path / "inventory.json"
    inventory.write_text(json.dumps({"records": records}))
    report = {"source_inventory_sha256": digest(inventory), "failures": [{"record_id": "bad", "reason": "no visible torso"}],
              "datasets": {"static_pose": {}}}
    (tmp_path / "preparation_report.json").write_text(json.dumps(report))
    manifest = {"view_streams": [{"source_record_id": "good"}],
                "provenance": {"processing_config": {"inventory_sha256": digest(inventory)}}}
    (tmp_path / "dataset_static_pose.json").write_text(json.dumps(manifest))
    return inventory


def test_failed_source_class_remains_visible_even_without_prepared_stream(tmp_path):
    inventory = fixture(tmp_path)
    result = annotate_source_coverage(inventory, tmp_path)
    catalog = result["static_pose"]
    assert catalog["squash.static.001"]["prepared_capture_count"] == 1
    assert catalog["squash.static.002"] == {"name": "Missing torso", "source_capture_count": 1,
                                            "prepared_capture_count": 0, "exclusion_reasons": {"no visible torso": 1}}
    manifest = json.loads((tmp_path / "dataset_static_pose.json").read_text())
    report = json.loads((tmp_path / "preparation_report.json").read_text())
    assert manifest["source_label_catalog"] == catalog
    assert report["source_label_catalog"] == result


def test_other_inventory_cannot_relabel_existing_preparation(tmp_path):
    inventory = fixture(tmp_path)
    manifest = tmp_path / "dataset_static_pose.json"
    before = manifest.read_bytes()
    inventory.write_text(inventory.read_text() + "\n")
    with pytest.raises(ValueError, match="does not match"):
        annotate_source_coverage(inventory, tmp_path)
    assert manifest.read_bytes() == before
