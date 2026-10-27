"""Integration checks for capture -> train -> evaluate -> deployment metadata.

Tiny geometric fixtures exercise real-data code paths; their metrics are never
claimed as sport-validation evidence.
"""
import json
import hashlib
import pathlib
import sys

import numpy as np
import pytest
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from datasets.jsonl_dataset import PoseJsonlDataset, load_labels, frame_from_json
from evaluation.evaluate import evaluate_run
from evaluation.open_set import apply_thresholds, calibrate
from training.augment import mirror
from training.train import TrainConfig, load_run, train


def frame(i=0, ts=0):
    pts = [{"id": j, "x": 0.5, "y": 0.5, "z": 0, "visibility": 0.95} for j in range(33)]
    for j, x, y in ((11, .4, .3), (12, .6, .3), (23, .4, .6), (24, .6, .6)):
        pts[j].update(x=x, y=y)
    return {"schema_version": "1.0.0", "session_id": "fixture", "frame_id": i, "timestamp_ms": ts,
            "camera_id": "front", "image_size": [640, 480], "mirror": False, "orientation": "landscape",
            "landmark_set": "mediapipe_pose_33", "normalized_landmarks": pts,
            "quality": {"framing_ok": True, "ambiguous_people": False, "missing_joints": []},
            "provenance": {"model_id": "analytic-fixture", "version": "1"}}


def write_capture(tmp_path, label="Coach Original Ready"):
    streams, executions, assignments = [], [], {}
    for split in ("train", "val", "test"):
        path = tmp_path / f"{split}.jsonl"
        path.write_text(json.dumps({"_header": {"source": "fixture"}}) + "\n" + json.dumps(frame()) + "\n")
        streams.append({"view_stream_id": split, "camera_id": "front", "pose_path": path.name})
        executions.append({"execution_id": split, "capture_session_id": split, "athlete_id": f"ath-{split}",
                           "movement_id": label, "view_stream_ids": [split], "start_ms": 0, "end_ms": 0})
        assignments[split] = split
    manifest = {"view_streams": streams, "executions": executions, "cameras": [{"camera_id": "front", "view": "front"}],
                "splits": {"assignments": assignments}}
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps(manifest))
    return path, label


def test_capture_header_single_photo_label_and_causal_padding(tmp_path):
    path, label = write_capture(tmp_path)
    ds = PoseJsonlDataset.from_manifest(path, None, [label, "UNKNOWN"], window_frames=5, min_observed_fraction=0)
    assert len(ds) == 1 and ds.items[0][2] == 0
    x, mask, _ = ds[0]
    assert not mask[:-1].any() and mask[-1].sum() == 33
    assert not x[:-1].any()
    assert ds.metadata[0]["view"] == "front"
    assert ds.split_evidence["athlete_disjoint"] is True
    one = PoseJsonlDataset.from_manifest(path, None, [label, "UNKNOWN"], window_frames=1)
    assert one[0][0].shape == (1, 99)
    gated = PoseJsonlDataset.from_manifest(path, None, [label, "UNKNOWN"], window_frames=5)
    assert len(gated) == 0 and gated.class_counts()[label] == 0
    assert gated.rejected_windows["below_min_observed_fraction"] == 1


def test_labels_stream_alias_and_unknown_mapping_rejected(tmp_path):
    path, label = write_capture(tmp_path)
    labels = tmp_path / "labels.jsonl"
    labels.write_text(json.dumps({"stream_id": "train", "execution_id": "train", "movement_id": label, "start_ms": 0, "end_ms": 1}))
    assert "train" in load_labels(labels)
    with pytest.raises(ValueError, match="unmapped movement"):
        PoseJsonlDataset.from_manifest(path, labels, ["some invented mapping", "UNKNOWN"])


def test_observed_fraction_gate_counts_landmarks_and_preserves_zero_support(tmp_path):
    frames = [frame(0, 0), frame(1, 100)]
    # Both have valid torso roots, but 19/33 is below the runtime gate and 20/33 above it.
    ordered_ids = [11, 12, 23, 24] + [j for j in range(33) if j not in {11, 12, 23, 24}]
    for f, count in zip(frames, (19, 20)):
        for point in f["normalized_landmarks"]:
            point["visibility"] = .95 if point["id"] in ordered_ids[:count] else .1
    path = tmp_path / "sparse.jsonl"
    path.write_text("\n".join(json.dumps(f) for f in frames))
    labels = {"s": [{"movement_id": "sparse", "start_ms": 0, "end_ms": 1},
                    {"movement_id": "supported", "start_ms": 100, "end_ms": 101}]}
    ds = PoseJsonlDataset({"s": path}, labels, ["sparse", "supported", "UNKNOWN"], window_frames=1, stride=1, hz=10)
    assert ds.class_counts() == {"sparse": 0, "supported": 1, "UNKNOWN": 0}
    assert ds.rejected_windows == {"empty": 0, "current_frame_unusable": 0,
                                   "below_min_observed_fraction": 1, "excluded_class": 0}
    assert ds.rejected_by_sequence == {"s": 1}
    assert ds.metadata[0]["observed_fraction"] == pytest.approx(20 / 33)
    permissive = PoseJsonlDataset({"s": path}, labels, ds.classes, window_frames=1, stride=1, hz=10, min_observed_fraction=.5)
    assert len(permissive) == 2


def test_known_athlete_leakage_rejected(tmp_path):
    path, label = write_capture(tmp_path)
    m = json.loads(path.read_text())
    for e in m["executions"]:
        e["athlete_id"] = "same-athlete"
    path.write_text(json.dumps(m))
    with pytest.raises(ValueError, match="split leakage"):
        PoseJsonlDataset.from_manifest(path, None, [label, "UNKNOWN"])
    ds = PoseJsonlDataset.from_manifest(path, None, [label, "UNKNOWN"], allow_development_split=True)
    assert ds.split_evidence["athlete_disjoint"] is False


def test_single_athlete_training_partition_has_no_holdout_evidence(tmp_path):
    path, label = write_capture(tmp_path)
    manifest = json.loads(path.read_text())
    for ex in manifest["executions"]:
        ex["athlete_id"] = "ATH_0005"
    manifest["splits"]["assignments"] = {ex["execution_id"]: "train" for ex in manifest["executions"]}
    path.write_text(json.dumps(manifest))
    ds = PoseJsonlDataset.from_manifest(path, None, [label, "UNKNOWN"], window_frames=1)
    assert len(ds) == 3
    assert ds.split_evidence["athlete_disjoint"] is None
    assert ds.split_evidence["problems"] == []
    assert ds.split_evidence["partitions"] == ["train"]
    assert "no independent holdout" in ds.split_evidence["reason"]


def test_execution_ranges_are_applied_before_windows(tmp_path):
    p = tmp_path / "stream.jsonl"
    p.write_text("\n".join(json.dumps(frame(i, i * 100)) for i in range(11)))
    manifest = {"view_streams": [{"view_stream_id": "v", "camera_id": "front", "pose_path": p.name}],
                "executions": [{"execution_id": "first", "athlete_id": "unknown", "capture_session_id": "s", "view_stream_ids": ["v"], "movement_id": "A", "start_ms": 0, "end_ms": 200},
                               {"execution_id": "last", "athlete_id": "unknown", "capture_session_id": "s", "view_stream_ids": ["v"], "movement_id": "B", "start_ms": 800, "end_ms": 1000}],
                "splits": {"assignments": {"first": "train", "last": "test"}}}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="split leakage"):
        PoseJsonlDataset.from_manifest(path, None, ["A", "B", "UNKNOWN"], split="test")
    ds = PoseJsonlDataset.from_manifest(path, None, ["A", "B", "UNKNOWN"], split="test", hz=10, window_frames=2, stride=1, allow_development_split=True)
    assert all(m["start_ms"] >= 800 for m in ds.metadata)
    assert all(item[2] == 1 for item in ds.items)
    assert ds.split_evidence["athlete_disjoint"] is None


def test_coco_mirror_uses_coco_pairs_and_is_reversible():
    x = np.arange(3 * 17 * 3).reshape(3, 51).astype(float)
    m = np.ones((3, 17))
    mx, mm, hand = mirror(x, m, "right", "coco_17")
    assert np.array_equal(mx.reshape(3, 17, 3)[:, 15, 0], -x.reshape(3, 17, 3)[:, 16, 0])
    xx, _, hand = mirror(mx, mm, hand, "coco_17")
    assert np.array_equal(xx, x) and hand == "right"


def test_no_unknown_samples_keeps_calibration_provisional_and_abstaining():
    result = calibrate(np.array([[5., 0.], [4., 0.]]), np.array([0, 0]), ["A", "UNKNOWN"])
    assert result["thresholds"] == {"A": 1.0}
    assert result["evaluation"]["unknown_false_acceptance"] is None
    assert result["status"] == "provisional"
    assert apply_thresholds(np.array([[.7, .3]]), ["A", "UNKNOWN"], {"A": .6}).tolist() == [0]
    assert apply_thresholds(np.array([[1., 0.]]), ["A", "UNKNOWN"], {"A": 1.}).tolist() == [1]


@pytest.mark.parametrize("quality", [{"ambiguous_people": True}, {"track_changed": True}, {"framing_ok": False}, {"missing_joints": [27]}])
def test_unusable_frame_quality_masks_only_that_frame(tmp_path, quality):
    bad = frame(0, 0)
    bad["quality"].update(quality)
    normalized = frame_from_json(bad)
    assert not normalized.normalization_valid and not normalized.valid.any()
    p = tmp_path / "quality.jsonl"
    p.write_text(json.dumps(bad) + "\n" + json.dumps(frame(1, 100)))
    ds = PoseJsonlDataset({"s": p}, {"s": [{"movement_id": "A", "start_ms": 0, "end_ms": 101}]},
                         ["A", "UNKNOWN"], hz=10, window_frames=1, stride=1)
    assert len(ds) == 1 and ds.metadata[0]["start_ms"] == 100


def test_history_windows_do_not_mix_subject_ids(tmp_path):
    frames = [frame(i, i * 100) for i in range(6)]
    for i, f in enumerate(frames):
        f["tracked_subject_id"] = "a" if i < 3 else "b"
    p = tmp_path / "subjects.jsonl"
    p.write_text("\n".join(json.dumps(f) for f in frames))
    ds = PoseJsonlDataset({"s": p}, {"s": [{"movement_id": "A", "start_ms": 0, "end_ms": 501}]},
                         ["A", "UNKNOWN"], hz=10, window_frames=5, stride=1)
    assert len(ds) == 2
    assert ds.metadata[0]["end_ms"] == 200 and ds.metadata[1]["start_ms"] == 300


def test_bad_current_frame_skips_prediction_but_transient_framing_preserves_history(tmp_path):
    frames = [frame(i, i * 100) for i in range(5)]
    frames[3]["quality"]["framing_ok"] = False
    path = tmp_path / "transient.jsonl"
    path.write_text("\n".join(json.dumps(f) for f in frames))
    ds = PoseJsonlDataset({"s": path}, {"s": [{"movement_id": "A", "start_ms": 0, "end_ms": 501}]},
                         ["A", "UNKNOWN"], hz=10, window_frames=4, stride=1)
    assert len(ds) == 1 and ds.metadata[0]["end_ms"] == 400
    assert ds.metadata[0]["observed_fraction"] == .75
    assert ds.rejected_windows["current_frame_unusable"] == 1
    ambiguous = frame()
    ambiguous["quality"]["ambiguous_people"] = True
    assert frame_from_json(ambiguous).continuity_break


def test_orchestrator_preflight_preserves_ids_names_and_has_no_training_side_effect(tmp_path):
    import importlib.util
    script = pathlib.Path(__file__).resolve().parents[2] / "tools/train_squash_models.py"
    spec = importlib.util.spec_from_file_location("squash_train_tool", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    path, label = write_capture(tmp_path, "original-source-id")
    m = json.loads(path.read_text())
    m.update(sport_pack_id="squash", model_task="static_pose", class_names={label: "Coach's original ready position"})
    m["pose_model"] = {"model_id": "mediapipe_pose_landmarker", "version": "full/float16/1/mediapipe-fixture", "digest": "a" * 64}
    target = tmp_path / "dataset_static_pose.json"
    target.write_text(json.dumps(m))
    plan = module.task_plan(tmp_path, "static_pose", tmp_path / "runs", epochs=2)
    assert plan["classes"] == [label, "UNKNOWN"]
    assert plan["class_names"][label] == "Coach's original ready position"
    assert plan["config"]["window_frames"] == 1 and plan["config"]["steps"] == 2
    assert plan["splits"]["test"]["windows"] == 1
    assert not (tmp_path / "runs").exists()


def test_partial_coverage_requires_flag_and_never_relabels_excluded_captures(tmp_path):
    import importlib.util
    from training.train import make_dataset
    spec = importlib.util.spec_from_file_location("squash_coverage_tool", pathlib.Path(__file__).resolve().parents[2] / "tools/train_squash_models.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    path, label = write_capture(tmp_path, "supported")
    manifest = json.loads(path.read_text())
    for split in ("train", "val"):
        sid = f"excluded-{split}"
        f = frame()
        if split == "train":
            f["quality"]["framing_ok"] = False
        (tmp_path / f"{sid}.jsonl").write_text(json.dumps(f))
        manifest["view_streams"].append({"view_stream_id": sid, "camera_id": "front", "pose_path": f"{sid}.jsonl"})
        manifest["executions"].append({"execution_id": sid, "athlete_id": f"ath-{split}", "capture_session_id": split,
                                      "movement_id": "unusable", "view_stream_ids": [sid], "start_ms": 0, "end_ms": 0})
        manifest["splits"]["assignments"][sid] = split
    manifest.update(sport_pack_id="squash", model_task="static_pose",
                    pose_model={"model_id": "mediapipe_pose_landmarker", "version": "full/float16/1/fixture", "digest": "a" * 64},
                    source_label_catalog={"supported": {"name": "Original supported", "source_capture_count": 3, "prepared_capture_count": 3},
                                          "unusable": {"name": "Original unusable", "source_capture_count": 2, "prepared_capture_count": 2},
                                          "lost": {"name": "Original lost", "source_capture_count": 4, "prepared_capture_count": 0,
                                                   "exclusion_reasons": {"no unambiguous torso": 4}}})
    target = tmp_path / "dataset_static_pose.json"
    target.write_text(json.dumps(manifest))
    original = target.read_bytes()
    with pytest.raises(ValueError, match="--allow-partial-coverage"):
        module.task_plan(tmp_path, "static_pose", tmp_path / "runs")
    plan = module.task_plan(tmp_path, "static_pose", tmp_path / "runs", allow_partial_coverage=True)
    assert target.read_bytes() == original
    assert plan["classes"] == ["supported", "UNKNOWN"]
    assert plan["config"]["excluded_classes"] == ["lost", "unusable"]
    assert plan["coverage"]["source_class_count"] == 3 and plan["coverage"]["modeled_class_count"] == 1
    excluded = {entry["class_id"]: entry for entry in plan["coverage"]["excluded_classes"]}
    assert excluded["lost"]["class_name"] == "Original lost"
    assert excluded["lost"]["preparation_exclusion_reasons"] == {"no unambiguous torso": 4}
    assert excluded["unusable"]["usable_windows"] == {"train": 0, "val": 1, "test": 0}
    val = make_dataset(TrainConfig(**plan["config"]), "val")
    assert val.class_counts() == {"supported": 1, "UNKNOWN": 0}
    assert val.excluded_executions == ["excluded-val"]
    assert plan["splits"]["val"]["windows"] == 1 and plan["splits"]["val"]["excluded_windows"] == 1


def test_pose_checkpoint_digest_and_variant_are_verified_without_downloading(tmp_path, monkeypatch):
    import importlib.util
    script = pathlib.Path(__file__).resolve().parents[2] / "tools/train_squash_models.py"
    spec = importlib.util.spec_from_file_location("squash_pose_model_tool", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = tmp_path / "fixture.task"
    source.write_bytes(b"test-checkpoint-bytes")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    full = {"model_id": "mediapipe_pose_landmarker", "version": "full/float16/1/mediapipe-fixture", "digest": digest}
    assert module.validate_pose_model(full)["digest"] == f"sha256:{digest}"
    with pytest.raises(ValueError, match="--variant full"):
        module.validate_pose_model({**full, "version": "lite/float16/1/mediapipe-fixture"})
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "packages/perception-py"))
    from apexformz_perception.pose import mediapipe_backend
    calls = []
    def cached_model(variant):
        calls.append(variant)
        return source
    monkeypatch.setattr(mediapipe_backend, "ensure_model", cached_model)
    assert module.resolve_pose_checkpoint(full) == source
    assert calls == ["full"]
    with pytest.raises(ValueError, match="differs from prepared"):
        module.resolve_pose_checkpoint({**full, "digest": "b" * 64})
    rejected_public = tmp_path / "rejected/squash"
    with pytest.raises(ValueError, match="differs from prepared"):
        module.install_artifacts([{"pose_model": {**full, "digest": "b" * 64}}], rejected_public)
    assert not rejected_public.exists()


def test_small_real_training_evaluation_and_export_restore_config(tmp_path, monkeypatch):
    monkeypatch.setenv("APEXFORMZ_DEVICE", "cpu")
    torch.set_num_threads(1)
    path, label = write_capture(tmp_path)
    cfg = TrainConfig(classes=[label, "UNKNOWN"], model_task="static_pose", window_frames=1,
                      channels=[4], kernel=1, steps=2, batch_size=16, augment=False,
                      dataset_manifest=str(path), out_dir=str(tmp_path / "run"))
    cfg.class_coverage = {"partial": False, "source_classes": [label], "modeled_classes": [label], "excluded_classes": []}
    record = train(cfg)
    assert record["dataset"]["class_counts"] == {label: 1, "UNKNOWN": 0}
    restored, restored_cfg, _ = load_run(record["record_path"])
    assert restored_cfg.channels == [4]
    assert restored(torch.zeros(1, 1, 99), torch.ones(1, 1, 33)).shape == (1, 1, 2)
    result = evaluate_run(record["record_path"], split="test", out=tmp_path / "report.json", logits_out=tmp_path / "test.npz")
    assert result["n_windows"] == 1 and result["per_view"]["front"]["n"] == 1
    assert result["unknown_false_acceptance"] is None and result["boundary_mae_ms"] is None
    assert np.load(tmp_path / "test.npz")["classes"].tolist() == [label, "UNKNOWN"]
    pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")
    from export.export_onnx import export_run
    artifacts = export_run(pathlib.Path(record["record_path"]), tmp_path / "static_pose.onnx", class_names={label: "Original Ready"})
    assert artifacts["equivalence_max_abs_diff"] < 1e-3
    dep = json.loads(pathlib.Path(artifacts["deployment"]).read_text())
    assert dep["input"]["window_frames"] == 1 and dep["model_task"] == "static_pose"
    assert dep["classes"] == [label, "UNKNOWN"]
    assert dep["class_names"] == {label: "Original Ready"}
    assert dep["calibration"]["thresholds"] == {label: 1.0}
    assert not dep["production_eligible"]
    assert dep["coverage"] == cfg.class_coverage
    assert json.loads(pathlib.Path(artifacts["model_card"]).read_text())["coverage"] == cfg.class_coverage
    # The browser discovery index is written only after complete artifacts exist.
    import importlib.util
    script = pathlib.Path(__file__).resolve().parents[2] / "tools/train_squash_models.py"
    spec = importlib.util.spec_from_file_location("squash_install_tool", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    public = tmp_path / "public"
    public.mkdir()
    old = {"deployment_url": "dynamic_movement.deployment.json", "model_url": "dynamic_movement.onnx"}
    (public / "index.json").write_text(json.dumps([old]))
    fixture_pose = tmp_path / "cached-fixture.task"
    fixture_pose.write_bytes(b"test-pose-checkpoint")
    pose_model = {"model_id": "mediapipe_pose_landmarker", "version": "full/float16/1/mediapipe-fixture",
                  "digest": hashlib.sha256(fixture_pose.read_bytes()).hexdigest()}
    monkeypatch.setattr(module, "resolve_pose_checkpoint", lambda _: fixture_pose)
    index = module.install_artifacts([{"model_task": "static_pose", "artifacts": artifacts, "pose_model": pose_model}], public)
    assert old in index and len(index) == 2
    assert (public / "static_pose.onnx").exists() and (public / "static_pose.deployment.json").exists()
    assert not (public / "index.json.tmp").exists()
    assert (public.parent / "pose_landmarker_full.task").read_bytes() == fixture_pose.read_bytes()
