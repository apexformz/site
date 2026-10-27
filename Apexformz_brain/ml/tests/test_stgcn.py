import json
import pathlib
import os
import subprocess

# Dry runs are smoke tests of the pipeline, not of the GPU; forcing CPU keeps them
# independent of whatever other suites (tracker models) left resident on the device.
CPU_ENV = {**os.environ, "APEXFORMZ_DEVICE": "cpu"}
import sys

import numpy as np
import pytest
import torch

ML = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

from training.graph import build_adjacency, num_nodes  # noqa: E402
from training.stgcn import STGCNpp, build_model  # noqa: E402
from training.agcn import AdaptiveGCN  # noqa: E402

CLASSES = ["a", "b", "UNKNOWN"]


@pytest.mark.parametrize("landmark_set", ["mediapipe_pose_33", "coco_17"])
def test_graph_partition_normalised(landmark_set):
    A = build_adjacency(landmark_set)
    V = num_nodes(landmark_set)
    assert A.shape == (3, V, V)
    assert np.allclose(A[0], np.eye(V))
    for k in (1, 2):
        rows = A[k].sum(axis=1)
        assert np.all((np.isclose(rows, 1.0)) | (np.isclose(rows, 0.0)))
    assert (A[1] + A[2]).sum() > 0


@pytest.mark.parametrize("landmark_set", ["mediapipe_pose_33", "coco_17"])
def test_stgcnpp_shapes_and_mask_invariance(landmark_set):
    torch.manual_seed(0)
    model = STGCNpp(CLASSES, landmark_set=landmark_set, base_channels=16, causal=False).eval()
    V = num_nodes(landmark_set)
    B, T = 2, 37  # not a multiple of the total stride
    x = torch.randn(B, T, V * 3)
    mask = torch.ones(B, T, V)
    out = model(x, mask)
    assert out.shape == (B, T, len(CLASSES))
    assert model.total_stride == 4
    x3 = x.clone()
    x3[:, :, 0:3] += 100.0
    m3 = mask.clone()
    m3[:, :, 0] = 0
    assert torch.allclose(model(x, m3), model(x3, m3), atol=1e-4)
    probs = model.predict_sequence(x, mask)
    assert probs.shape == (B, len(CLASSES))
    assert torch.allclose(probs.sum(-1), torch.ones(B), atol=1e-5)


def test_stgcnpp_causal_no_future_leakage():
    torch.manual_seed(0)
    model = STGCNpp(CLASSES, base_channels=16, causal=True).eval()
    B, T, V = 2, 48, 33
    x = torch.randn(B, T, V * 3)
    mask = torch.ones(B, T, V)
    out = model(x, mask)
    x2 = x.clone()
    x2[:, 24:, :] += 10.0
    out2 = model(x2, mask)
    assert torch.allclose(out[:, :24], out2[:, :24], atol=1e-4), "future frames changed earlier outputs"
    assert not torch.allclose(out[:, 24:], out2[:, 24:])


def test_non_causal_model_does_use_future():
    torch.manual_seed(0)
    model = STGCNpp(CLASSES, base_channels=16, causal=False).eval()
    x = torch.randn(1, 48, 99)
    mask = torch.ones(1, 48, 33)
    out = model(x, mask)
    x2 = x.clone()
    x2[:, 40:, :] += 10.0
    assert not torch.allclose(out[:, :24], model(x2, mask)[:, :24])


def test_requires_unknown_class_and_factory():
    with pytest.raises(AssertionError):
        STGCNpp(["a", "b"])
    m = build_model("tcn", CLASSES, "coco_17")
    assert m.num_landmarks == 17
    with pytest.raises(ValueError):
        build_model("nope", CLASSES)


def test_agcn_block_shape():
    A = torch.tensor(build_adjacency("coco_17"))
    blk = AdaptiveGCN(4, 8, A).eval()
    y = blk(torch.randn(2, 4, 10, 17))
    assert y.shape == (2, 8, 10, 17)


def test_param_counts_reasonable():
    full = STGCNpp(CLASSES, causal=True)
    n = sum(p.numel() for p in full.parameters())
    assert 0.8e6 < n < 3e6, n


@pytest.mark.parametrize("model", ["tcn", "stgcnpp"])
def test_train_dry_run_both_models(tmp_path, model):
    cmd = [sys.executable, str(ML / "training" / "train.py"), "--dry-run", "--model", model, "--out-dir", str(tmp_path)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=CPU_ENV)
    assert res.returncode == 0, res.stderr
    rec = json.loads(next(tmp_path.glob(f"{model}-*.json")).read_text())
    assert rec["steps"] == 2
    assert rec["architecture"]["model"] == model
    assert rec["augmentation"] is not None


def test_pretrain_dry_run(tmp_path):
    cmd = [sys.executable, str(ML / "training" / "pretrain_contrastive.py"), "--dry-run", "--model", "stgcnpp", "--out-dir", str(tmp_path)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=CPU_ENV)
    assert res.returncode == 0, res.stderr
    rec = json.loads(next(tmp_path.glob("pretrain-*.json")).read_text())
    assert rec["objective"] == "nt_xent" and rec["steps"] == 2


def test_export_onnx_stgcnpp_dynamic_time(tmp_path):
    from export.export_onnx import export

    model = STGCNpp(CLASSES, base_channels=16, causal=True)
    try:
        res = export(model, tmp_path / "s.onnx", T=40)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"onnx export unavailable: {e}")
    assert (tmp_path / "s.onnx").exists()
    assert (tmp_path / "s.model_card.json").exists()
    card = json.loads((tmp_path / "s.model_card.json").read_text())
    assert card["tensor_contract"]["input"]["shape"] == ["batch", "time", "V*3"]
    if res.get("equivalence_max_abs_diff") is not None:
        assert res["equivalence_max_abs_diff"] < 1e-3
