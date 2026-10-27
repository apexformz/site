"""Self-supervision uses only real training windows and never imports a classifier head."""
import dataclasses
import hashlib
import json
import pathlib
import sys

import numpy as np
import pytest
import torch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from test_real_pipeline import frame
from training.pretrain_contrastive import make_pretraining_dataset, nt_xent, pretrain
from training.train import TrainConfig, load_pretrained_encoder, make_model, train


@pytest.fixture
def config(tmp_path, monkeypatch):
    monkeypatch.setenv("APEXFORMZ_DEVICE", "cpu")
    torch.set_num_threads(1)
    streams, executions, assignments = [], [], {}
    for part in ("train", "val", "test"):
        path = tmp_path / f"{part}.jsonl"
        path.write_text("\n".join(json.dumps(frame(i, i * 100)) for i in range(3)), encoding="utf-8")
        streams.append({"view_stream_id": part, "camera_id": "front", "pose_path": path.name,
                        "pose_sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
        # Deliberately no movement labels: self-supervision must not need them.
        executions.append({"execution_id": part, "capture_session_id": part, "athlete_id": f"ath-{part}",
                           "view_stream_ids": [part], "start_ms": 0, "end_ms": 200})
        assignments[part] = part
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"view_streams": streams, "executions": executions,
                               "splits": {"assignments": assignments}}), encoding="utf-8")
    return TrainConfig(model="tcn", dataset_manifest=str(path), window_frames=1, stride=1, hz=10,
                       channels=[8], dropout=0, steps=2, batch_size=2, seed=17, out_dir=str(tmp_path / "finetune"))


def run(cfg, out):
    return pretrain(cfg.model, cfg.landmark_set, cfg.steps, cfg.batch_size, cfg.window_frames,
                    out, seed=cfg.seed, config=cfg)


def test_uses_train_only_without_labels_and_preserves_quality_gate(config):
    ds, info = make_pretraining_dataset(config)
    assert len(ds) == 3
    assert info["sequence_ids"] == ["train::train"]
    assert all(it[2] == 0 for it in ds.items)  # placeholder UNKNOWN, never used as a target
    assert info["labels_used"] is False
    assert info["split_evidence"]["athlete_disjoint"] is True
    assert [pathlib.Path(p["path"]).name for p in info["pose_sources"]] == ["train.jsonl"]
    # Do not open held-out pose files, even when missing; the partition still exists.
    root = pathlib.Path(config.dataset_manifest).parent
    (root / "val.jsonl").unlink()
    (root / "test.jsonl").unlink()
    assert len(make_pretraining_dataset(config)[0]) == 3
    with pytest.raises(ValueError, match="two usable"):
        make_pretraining_dataset(dataclasses.replace(config, window_frames=45))


@pytest.mark.parametrize("mutation", ["missing", "incomplete", "athlete", "session", "alias"])
def test_rejects_missing_assignments_and_leakage_even_for_development(config, mutation):
    path = pathlib.Path(config.dataset_manifest)
    manifest = json.loads(path.read_text())
    if mutation == "missing":
        del manifest["splits"]
    elif mutation == "incomplete":
        del manifest["splits"]["assignments"]["val"]
    elif mutation == "athlete":
        manifest["executions"][1]["athlete_id"] = "ath-train"
    elif mutation == "session":
        manifest["executions"][1]["capture_session_id"] = "train"
    else:
        manifest["view_streams"][1]["pose_path"] = "train.jsonl"
    path.write_text(json.dumps(manifest))
    config.allow_development_split = True
    with pytest.raises(ValueError, match="split|leakage"):
        make_pretraining_dataset(config)


@pytest.mark.parametrize("model_name", ["tcn", "stgcnpp"])
def test_seeded_real_training_encoder_restore_and_fresh_head(config, tmp_path, model_name):
    config.model, config.base_channels = model_name, 8
    rec = run(config, tmp_path / "one")
    second = run(config, tmp_path / "two")
    assert rec["loss_history"] == second["loss_history"]
    assert rec["data_source"] == "manifest_train_partition" and rec["dry_run"] is False
    assert np.isfinite(rec["final_loss"])
    state = torch.load(tmp_path / "one" / rec["checkpoint"], weights_only=True)
    other = torch.load(tmp_path / "two" / second["checkpoint"], weights_only=True)
    assert all(torch.equal(v, other[k]) for k, v in state.items())
    assert not any(k.startswith("head.") for k in state)
    config.pretrained_encoder_record = rec["record_path"]
    model = make_model(config)
    head = model.head.weight.clone()
    provenance = load_pretrained_encoder(model, config)
    assert provenance["classification_head"] == "fresh_initialization"
    assert torch.equal(model.head.weight, head)
    assert all(torch.equal(model.state_dict()[k], v) for k, v in state.items())
    # Exercise the train entry point while preserving fixture labels/no-label separation.
    result = train(config, dry_run=True)
    assert result["pretrained_encoder"]["checkpoint_sha256"] == rec["checkpoint_sha256"]


@pytest.mark.parametrize("mutation", ["architecture", "input", "dataset", "split", "pose", "checkpoint"])
def test_warm_start_rejects_incompatible_or_changed_provenance(config, tmp_path, mutation):
    rec = run(config, tmp_path / "pretrain")
    config.pretrained_encoder_record = rec["record_path"]
    if mutation == "architecture":
        config.channels = [16]
    elif mutation == "input":
        config.normalization = "world_bodyframe_v1"
    elif mutation == "dataset":
        pathlib.Path(config.dataset_manifest).write_text("{}")
    elif mutation == "split":
        path = tmp_path / "different_split.json"
        path.write_text('{"assignments": {"train": "test"}}')
        config.split_manifest = str(path)
    elif mutation == "pose":
        (tmp_path / "train.jsonl").write_text("changed")
    else:
        (tmp_path / "pretrain" / rec["checkpoint"]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="incompatible|differs|checksum"):
        load_pretrained_encoder(make_model(config), config)


def test_real_pretraining_never_falls_back_to_random_and_nt_xent_needs_negatives(tmp_path):
    with pytest.raises(ValueError, match="dataset_manifest"):
        pretrain("tcn", "mediapipe_pose_33", 2, 2, 4, tmp_path)
    with pytest.raises(ValueError, match="at least two"):
        nt_xent(torch.ones(1, 8), torch.ones(1, 8))


def test_pose_hash_still_checked_when_labels_ignored(config, tmp_path):
    (tmp_path / "train.jsonl").write_text("tampered")
    with pytest.raises(ValueError, match="pose checksum"):
        make_pretraining_dataset(config)
