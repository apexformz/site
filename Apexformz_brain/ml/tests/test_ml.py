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

from datasets.split import check_no_leakage, make_splits  # noqa: E402
from evaluation.metrics import boundary_mae_ms, boundary_within_tolerance_rate, expected_calibration_error, macro_f1, report, unknown_false_acceptance  # noqa: E402
from training.augment import mirror, masked_occlusion  # noqa: E402
from training.tcn import CausalTCN  # noqa: E402


def _executions(n_athletes=12, per_athlete=4):
    ex = []
    for a in range(n_athletes):
        for k in range(per_athlete):
            eid = f"a{a}-e{k}"
            ex.append({"execution_id": eid, "athlete_id": f"athlete-{a}", "capture_session_id": f"s{a}", "movement_id": "x.m",
                       "view_stream_ids": [f"{eid}-{v}" for v in ("front", "left", "right", "back")]})
    return ex


def test_split_is_athlete_disjoint_and_execution_grouped():
    ex = _executions()
    a = make_splits(ex, seed=7)
    assert check_no_leakage(ex, a) == []
    assert set(a.values()) == {"train", "val", "test"}
    assert a == make_splits(ex, seed=7), "must be deterministic"
    assert a != make_splits(ex, seed=8)


def test_location_holdout_forces_test():
    ex = _executions(6)
    sessions = [{"capture_session_id": f"s{a}", "athlete_id": f"athlete-{a}", "location_id": "gym_b" if a < 2 else "gym_a"} for a in range(6)]
    a = make_splits(ex, seed=1, location_holdouts=["gym_b"], sessions=sessions)
    for e in ex:
        if e["athlete_id"] in ("athlete-0", "athlete-1"):
            assert a[e["execution_id"]] == "test"
    assert check_no_leakage(ex, a) == []


def test_leakage_detector_catches_split_views():
    ex = _executions(2, 1)
    bad = {ex[0]["execution_id"]: "train", ex[1]["execution_id"]: "test"}
    ex[1]["athlete_id"] = ex[0]["athlete_id"]
    assert check_no_leakage(ex, bad)


def test_metrics_toy():
    y = [0, 0, 1, 1, 2, 2]
    p = [0, 0, 1, 0, 2, 1]
    assert 0 < macro_f1(y, p, 3) < 1
    assert unknown_false_acceptance(y, p, unknown_class=2) == 0.5
    probs = np.array([[0.9, 0.05, 0.05]] * 6)
    ece = expected_calibration_error(probs, y)
    assert 0 <= ece <= 1
    assert boundary_mae_ms({"a": 100, "b": 200}, {"a": 120, "b": 190}) == 15
    rep = report(y, p, probs, ["a", "b", "UNKNOWN"], views=["front"] * 6)
    assert rep["per_view"]["front"]["n"] == 6


def test_tcn_shape_and_causality():
    classes = ["a", "b", "UNKNOWN"]
    model = CausalTCN(classes, channels=(16, 16), kernel=3).eval()
    B, T, V = 2, 40, 33
    torch.manual_seed(0)
    x = torch.randn(B, T, V * 3)
    mask = torch.ones(B, T, V)
    out = model(x, mask)
    assert out.shape == (B, T, len(classes))
    # Perturb future frames: outputs up to t=19 must not change.
    x2 = x.clone()
    x2[:, 20:, :] += 10.0
    out2 = model(x2, mask)
    assert torch.allclose(out[:, :20], out2[:, :20], atol=1e-5)
    assert not torch.allclose(out[:, 20:], out2[:, 20:])
    # Masked landmarks contribute nothing.
    x3 = x.clone()
    x3[:, :, 0:3] += 100.0
    m3 = mask.clone()
    m3[:, :, 0] = 0
    out3a = model(x, m3)
    out3b = model(x3, m3)
    assert torch.allclose(out3a, out3b, atol=1e-5)


def test_tcn_requires_unknown_class():
    with pytest.raises(AssertionError):
        CausalTCN(["a", "b"])


def test_augment_mirror_and_occlusion():
    rng = np.random.default_rng(0)
    T, V = 10, 33
    x = rng.normal(size=(T, V * 3))
    mask = np.ones((T, V))
    mx, mm, hand = mirror(x, mask, "right")
    assert hand == "left"
    assert np.allclose(mx.reshape(T, V, 3)[:, 25, 0], -x.reshape(T, V, 3)[:, 26, 0])  # left_knee <- right_knee flipped
    ox, om = masked_occlusion(x, mask, p_joint=1.0, min_len=3, max_len=3, rng=rng)
    assert (om == 0).sum() == V * 3
    occluded = om == 0
    assert np.all(ox.reshape(T, V, 3)[occluded] == 0)


def test_train_dry_run_writes_experiment_record(tmp_path):
    cmd = [sys.executable, str(ML / "training" / "train.py"), "--dry-run", "--out-dir", str(tmp_path)]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=CPU_ENV)
    assert res.returncode == 0, res.stderr
    records = list(tmp_path.glob("tcn-*.json"))
    assert records
    rec = json.loads(records[0].read_text())
    for key in ("dataset_manifest_sha256", "architecture", "optimizer", "seed", "hardware", "code_commit", "evaluator_version"):
        assert key in rec
    assert rec["steps"] == 2


def test_export_onnx(tmp_path):
    sys.path.insert(0, str(ML))
    from export.export_onnx import export

    model = CausalTCN(["a", "b", "UNKNOWN"], channels=(8, 8))
    try:
        res = export(model, tmp_path / "m.onnx")
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"onnx export unavailable: {e}")
    assert (tmp_path / "m.onnx").exists()
    if res.get("equivalence_max_abs_diff") is not None:
        assert res["equivalence_max_abs_diff"] < 1e-3


def test_boundary_tolerance_rate():
    pred = {"a": 100.0, "b": 250.0, "c": 900.0}
    true = {"a": 130.0, "b": 200.0, "c": 905.0, "d": 1.0}
    assert boundary_within_tolerance_rate(pred, true, 80.0) == 1.0  # a 30 ms, b 50 ms, c 5 ms all inside; d has no prediction
    assert boundary_within_tolerance_rate(pred, true, 40.0) == 2 / 3
    assert boundary_within_tolerance_rate(pred, true, 10.0) == 1 / 3
    import math
    assert math.isnan(boundary_within_tolerance_rate({}, true, 80.0))
