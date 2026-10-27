import pathlib
import sys

import numpy as np

ML = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML))

from evaluation.open_set import calibrate, calibrate_thresholds, evaluate_thresholds, fit_temperature, softmax  # noqa: E402

CLASSES = ["a", "b", "UNKNOWN"]


def _data(seed=0, n=600):
    rng = np.random.default_rng(seed)
    y = rng.integers(0, 3, size=n)
    logits = rng.normal(0, 1, size=(n, 3))
    logits[np.arange(n), y] += 3.0  # mostly correct, over-confident
    # make unknowns look like class a sometimes
    unk = y == 2
    logits[unk, 0] += rng.normal(1.0, 1.0, size=unk.sum())
    return logits * 2.5, y


def test_temperature_reduces_ece():
    logits, y = _data()
    t = fit_temperature(logits, y)
    assert t > 1.0  # over-confident logits need T > 1
    res = calibrate(logits, y, CLASSES)
    assert res["ece_after"] <= res["ece_before"] + 1e-9


def test_thresholds_monotone_in_target_far():
    logits, y = _data()
    probs = softmax(logits, 1.0)
    strict = calibrate_thresholds(probs, y, CLASSES, target_far=0.01)
    loose = calibrate_thresholds(probs, y, CLASSES, target_far=0.2)
    for c in ("a", "b"):
        assert strict[c] >= loose[c]
    assert "UNKNOWN" not in strict
    assert all(0.5 <= v <= 0.999 for v in strict.values())


def test_thresholds_bound_unknown_false_acceptance():
    logits, y = _data(seed=3, n=2000)
    probs = softmax(logits, 1.0)
    thr = calibrate_thresholds(probs, y, CLASSES, target_far=0.05)
    ev = evaluate_thresholds(probs, y, CLASSES, thr, margin=0.0)
    assert ev["unknown_false_acceptance"] <= 0.05 + 0.02
    assert ev["accuracy_on_accepted"] is None or ev["accuracy_on_accepted"] > 0.8
