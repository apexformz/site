"""Preparation regressions with generated metadata; no AWS or model downloads."""
import copy
import hashlib
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from tools import prepare_capture_dataset as prepare


MODEL = {"model_id": "mediapipe_pose_landmarker", "version": "full/float16/1/mediapipe-test", "digest": "f" * 64, "delegate": "CPU"}
OPTIONS = {"variant": "full", "sample_hz": 30, "max_side": 1280, "canonical": True, "mirror": False}


def execution(identity, athlete="ATH_0001", label="squash.static.ready", **changes):
    ex = {"execution_id": identity, "athlete_id": athlete, "movement_id": label,
          "capture_session_id": f"session-{athlete}", "split_group_id": f"group-{identity}",
          "view_stream_ids": [f"stream-{identity}"], "source_sha256": hashlib.sha256(identity.encode()).hexdigest()}
    ex.update(changes)
    return ex


def record(identity="rec1", athlete="ATH_0001", mode="static", view="front"):
    return {"record_id": identity, "athlete_id": athlete, "capture_id": f"CAP_{identity}", "capture_session_id": f"session-{athlete}",
            "source_movement_id": f"squash.{mode}.ready", "source_movement_name": "Original capture name", "movement_type": mode,
            "view": view, "media_kind": "image" if mode == "static" else "video", "handedness": "unknown", "split_group_id": f"group-{athlete}",
            "captured_at": "2026-10-25T10:00:00Z", "source": {"uri": f"s3://bucket/raw/squash/session/front/CAP_{identity}/{identity}.jpg",
                "bucket": "bucket", "key": f"raw/squash/session/front/CAP_{identity}/{identity}.jpg", "version_id": "v1", "etag": "e1", "encryption": "AES256"},
            "consent": {"status": "GRANTED", "purpose": [], "retention_until": None}, "metadata_sources": [{"uri": "s3://labels/manifest.json", "version_id": "mv1"}],
            "validation": {"eligible_media": True, "warnings": [], "blockers": []}, "local_path": f"{identity}.jpg"}


def extracted(identity="rec1", frames=1):
    return {"pose_path": f"poses/{identity}.jsonl", "pose_sha256": hashlib.sha256(identity.encode()).hexdigest(),
            "source_sha256": hashlib.sha256(f"source-{identity}".encode()).hexdigest(), "pose_model": copy.deepcopy(MODEL),
            "frames": frames, "usable_frames": frames, "start_ms": 0, "end_ms": (frames - 1) * 33.3,
            "duration_ms": 0 if frames == 1 else frames * 33.3, "video": {"width": 640, "height": 480, "fps": 0 if frames == 1 else 30},
            "extraction": OPTIONS, "extractor_sha256": "c" * 64}


def test_single_athlete_never_leaks_across_development_capture_groups():
    result = prepare.assign_splits([execution(f"ex-{i}") for i in range(6)], 42)
    assert set(result["assignments"].values()) == {"train"}
    assert result["groups"] == 1
    assert not result["athlete_disjoint"]
    assert result["warnings"]


def test_three_independent_athletes_can_supply_disjoint_holdouts():
    result = prepare.assign_splits([execution(f"ex-{i}", athlete=f"ATH_{i}") for i in range(3)], 42)
    assert set(result["assignments"].values()) == {"train", "val", "test"}
    assert result["athlete_disjoint"]


def test_unknown_identity_is_one_shared_group():
    ex = [execution(f"ex-{i}", athlete="unknown", capture_session_id=f"unknown-session-{i}") for i in range(8)]
    result = prepare.assign_splits(ex, 42)
    assert result["groups"] == 1 and result["known_athletes"] == 0
    assert set(result["assignments"].values()) == {"train"}


def test_duplicate_media_and_related_capture_groups_cannot_cross_partitions():
    ex = [execution(f"ex-{i}", athlete=f"ATH_{i}") for i in range(5)]
    ex[1]["source_sha256"] = ex[0]["source_sha256"]
    ex[2]["split_group_id"] = ex[1]["split_group_id"]
    ex[3]["view_stream_ids"] = ex[2]["view_stream_ids"]
    result = prepare.assign_splits(ex, 42)
    assert len({result["assignments"][f"ex-{i}"] for i in range(4)}) == 1


def test_pose_cache_key_includes_model_bytes_version_source_identity_and_view(monkeypatch):
    monkeypatch.setattr(prepare, "extraction_code_digest", lambda: "extract-code")
    monkeypatch.setattr(prepare, "package_version", lambda package: "1.0")
    base = prepare.pose_cache_id(record(), "a" * 64, OPTIONS, MODEL)
    changes = [({**MODEL, "digest": "b" * 64}, record()), ({**MODEL, "version": "new-version"}, record()),
               (MODEL, record("different-record")), (MODEL, record(view="back"))]
    assert all(prepare.pose_cache_id(rec, "a" * 64, OPTIONS, model) != base for model, rec in changes)
    assert prepare.pose_cache_id(record(), "a" * 64, {**OPTIONS, "orientation_policy": "encoded"}, MODEL) != base


def test_image_policy_preserves_encoded_pixels_and_defaults_metadata_on_request(tmp_path):
    import cv2
    import numpy as np
    import struct

    path = tmp_path / "rotated-tag.jpg"
    ok, encoded = cv2.imencode(".jpg", np.full((12, 24, 3), (0, 0, 255), dtype=np.uint8))
    assert ok
    # A one-entry TIFF IFD embeds the EXIF rotate-90 tag without a new test dependency.
    exif = b"Exif\0\0II*\0\x08\0\0\0" + struct.pack("<H", 1) + struct.pack("<HHI", 274, 3, 1) + struct.pack("<H", 6) + b"\0" * 6
    jpeg = encoded.tobytes()
    path.write_bytes(jpeg[:2] + b"\xff\xe1" + struct.pack(">H", len(exif) + 2) + exif + jpeg[2:])
    assert prepare.decode_capture_image(path, "encoded").shape[:2] == (12, 24)
    assert prepare.decode_capture_image(path, "metadata").shape[:2] == (24, 12)
    with pytest.raises(ValueError, match="orientation_policy"):
        prepare.decode_capture_image(path, "guess-from-pose")


def test_encoded_video_disables_rotation_before_dimensions_or_frame_read(monkeypatch):
    import numpy as np
    from apexformz_perception.io import video

    captures = []

    class Capture:
        def __init__(self, path):
            self.auto = True
            self.read_count = 0
            self.events = []
            captures.append(self)

        def isOpened(self):
            return True

        def set(self, prop, value):
            self.events.append(("set", prop, value))
            assert prop == video.cv2.CAP_PROP_ORIENTATION_AUTO
            self.auto = bool(value)
            return True

        def get(self, prop):
            self.events.append(("get", prop))
            return {video.cv2.CAP_PROP_FRAME_WIDTH: 12 if self.auto else 24,
                    video.cv2.CAP_PROP_FRAME_HEIGHT: 24 if self.auto else 12,
                    video.cv2.CAP_PROP_FPS: 30, video.cv2.CAP_PROP_FRAME_COUNT: 1,
                    video.cv2.CAP_PROP_POS_MSEC: 0}[prop]

        def read(self):
            self.events.append(("read",))
            self.read_count += 1
            shape = (24, 12, 3) if self.auto else (12, 24, 3)
            return (True, np.zeros(shape, dtype=np.uint8)) if self.read_count == 1 else (False, None)

        def release(self):
            pass

    monkeypatch.setattr(video.cv2, "VideoCapture", Capture)
    encoded = video.probe("fixture", honor_orientation=False)
    assert (encoded.width, encoded.height) == (24, 12)
    frames = list(video.read_frames("fixture", honor_orientation=False))
    assert frames[0][2].shape[:2] == (12, 24)
    assert all(cap.events[0] == ("set", video.cv2.CAP_PROP_ORIENTATION_AUTO, 0) for cap in captures)
    metadata = video.probe("fixture")
    assert (metadata.width, metadata.height) == (12, 24)
    assert not any(event[0] == "set" for event in captures[-1].events)


def test_still_subject_matches_video_dominance_and_ambiguity_policy():
    import numpy as np
    from apexformz_perception.pose.base import PersonPose

    def person(bbox):
        return PersonPose("mediapipe_pose_33", np.zeros((33, 2)), np.ones(33), bbox=np.array(bbox))

    athlete = person([0.3, 0.1, 0.7, 0.9])
    bystander = person([0.75, 0.7, 0.85, 0.9])
    selected, selection = prepare.select_still_subject([bystander, athlete])
    assert selected is athlete and not selection.ambiguous and selection.person_count == 2
    competitor = person([0.4, 0.15, 0.8, 0.9])
    selected, selection = prepare.select_still_subject([athlete, competitor])
    # Same policy as video and live (SubjectSelector / subject_tracker.ts): a comparable nearby competitor makes the
    # identity ambiguous, so no subject is chosen rather than guessing; the frame is kept with the ambiguity flag.
    assert selected is None and selection.ambiguous and selection.index is None and selection.person_count == 2
    selected, selection = prepare.select_still_subject([])
    assert selected is None and selection.person_count == 0


def test_manifest_is_schema_valid_and_preserves_object_and_label_provenance(tmp_path):
    rec = record()
    output = prepare.build_manifest([rec], {rec["record_id"]: extracted()}, "static_pose", tmp_path, 42, "a" * 64)
    schema = json.loads((prepare.ROOT / "ml/datasets/dataset_manifest.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(output)
    assert output["view_streams"][0]["source_metadata"] == rec["metadata_sources"]
    assert output["view_streams"][0]["source"]["version_id"] == "v1"
    assert output["executions"][0]["movement_id"] == "squash.static.ready"
    assert output["annotations"][0]["review_status"] == "unreviewed"
    assert "phases" not in output["annotations"][0]["labels"]
    assert output["capture_sessions"][0]["captured_at"] == rec["captured_at"]
    assert output["release_blockers"]


def test_dataset_version_changes_with_extracted_artifact_or_split_seed(tmp_path):
    rec = record()
    meta = extracted()
    first = prepare.build_manifest([rec], {"rec1": meta}, "static_pose", tmp_path, 42, "a" * 64)
    changed = prepare.build_manifest([rec], {"rec1": {**meta, "pose_sha256": "9" * 64}}, "static_pose", tmp_path, 42, "a" * 64)
    different_seed = prepare.build_manifest([rec], {"rec1": meta}, "static_pose", tmp_path, 43, "a" * 64)
    assert len({first["dataset_version"], changed["dataset_version"], different_seed["dataset_version"]}) == 3


def test_manifest_rejects_mixed_pose_models_and_conflicting_known_session_identity(tmp_path):
    a, b = record("one"), record("two", "ATH_0002")
    meta_a, meta_b = extracted("one"), extracted("two")
    meta_b["pose_model"]["digest"] = "0" * 64
    with pytest.raises(ValueError, match="one pinned pose model"):
        prepare.build_manifest([a, b], {"one": meta_a, "two": meta_b}, "static_pose", tmp_path, 1, "hash")
    meta_b["pose_model"] = meta_a["pose_model"]
    b["capture_session_id"] = a["capture_session_id"]
    with pytest.raises(ValueError, match="Conflicting athlete"):
        prepare.build_manifest([a, b], {"one": meta_a, "two": meta_b}, "static_pose", tmp_path, 1, "hash")


def test_prepare_rejects_foreign_scope_before_extraction(tmp_path, monkeypatch):
    path = tmp_path / "inventory.json"
    monkeypatch.setattr(prepare, "extract_record", lambda *args: pytest.fail("must not extract foreign scope"))
    value = {"kind": "apexformz.capture_inventory", "source": {"sport": "badminton", "prefix": "raw/badminton/"}, "records": []}
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError, match="squash DataCapture"):
        prepare.prepare(path, tmp_path, OPTIONS, 42)
    value["source"] = {"sport": "squash", "prefix": "raw/squash/"}
    rec = record()
    rec["source"]["key"] = "sorted/squash/static/record.jpg"
    value["records"] = [rec]
    path.write_text(json.dumps(value), encoding="utf-8")
    with pytest.raises(ValueError, match="outside squash"):
        prepare.prepare(path, tmp_path, OPTIONS, 42)


def test_prepare_emits_both_task_manifests_without_synthetic_motion(tmp_path, monkeypatch):
    records = [record("photo"), record("video", mode="dynamic")]
    value = {"kind": "apexformz.capture_inventory", "source": {"sport": "squash", "prefix": "raw/squash/"}, "records": records}
    path = tmp_path / "inventory.json"
    path.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setattr(prepare, "extract_record", lambda rec, out, opts: extracted(rec["record_id"], 1 if rec["media_kind"] == "image" else 10))
    result = prepare.prepare(path, tmp_path, OPTIONS, 42)
    assert set(result["datasets"]) == {"static_pose", "dynamic_movement"}
    static = json.loads((tmp_path / "dataset_static_pose.json").read_text(encoding="utf-8"))
    assert static["executions"][0]["start_ms"] == static["executions"][0]["end_ms"] == 0
    assert not static["splits"]["athlete_disjoint"]


def test_parallel_dispatch_uses_bounded_spawn_pool_and_accounts_for_failures(tmp_path, monkeypatch):
    from concurrent.futures import Future

    records = [record("good"), record("bad")]
    path = tmp_path / "inventory.json"
    path.write_text(json.dumps({"kind": "apexformz.capture_inventory", "source": {"sport": "squash", "prefix": "raw/squash/"}, "records": records}), encoding="utf-8")
    observed = {}

    class Pool:
        def __init__(self, **kwargs):
            observed.update(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def submit(self, fn, rec, out_dir, options):
            future = Future()
            if rec["record_id"] == "bad":
                future.set_exception(ValueError("Undecodable image"))
            else:
                future.set_result(extracted(rec["record_id"]))
            return future

    monkeypatch.setattr(prepare, "ProcessPoolExecutor", Pool)
    monkeypatch.setattr(prepare, "pose_model_identity", lambda variant: MODEL)
    report = prepare.prepare(path, tmp_path, OPTIONS, 42, workers=2)
    assert observed["max_workers"] == 2
    assert observed["mp_context"].get_start_method() == "spawn"
    assert report["processed"] == 1
    assert report["failures"] == [{"record_id": "bad", "reason": "Undecodable image"}]
