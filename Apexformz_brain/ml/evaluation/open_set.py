"""Open-set threshold calibration and temperature scaling (TRD 10: no universal 0.8 cutoff).

Given validation logits and labels (UNKNOWN must be present as the last class):
  1. Fit a temperature T by minimising NLL on the validation set (Guo et al., 2017).
  2. For every known class c choose the probability threshold such that the fraction of
     UNKNOWN-labelled samples whose arg-max is c and whose probability exceeds the
     threshold does not exceed `target_far` (unknown false acceptance). Classes that never
     attract unknown samples fall back to the lowest accepted known-sample probability
     (floor at `min_threshold`).
  3. Export `{movement_id: threshold}` consumed by packages/analysis/src/recognizer.ts::decideOpenSet
     through the sport pack (models[].role = movement_classifier, thresholds JSON).

Thresholds are monotone in the target FAR: a stricter FAR never lowers a threshold.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

import numpy as np

if __package__:
    from .metrics import expected_calibration_error, unknown_false_acceptance
else:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from evaluation.metrics import expected_calibration_error, unknown_false_acceptance


def softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    if not np.isfinite(temperature) or temperature <= 0:
        raise ValueError("temperature must be finite and positive")
    z = logits / temperature
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def fit_temperature(logits: np.ndarray, y: np.ndarray, grid: np.ndarray | None = None) -> float:
    """Grid search over T minimising NLL (robust, dependency-free; LBFGS unnecessary for a scalar)."""
    grid = grid if grid is not None else np.exp(np.linspace(np.log(0.25), np.log(8.0), 200))
    best_t, best_nll = 1.0, np.inf
    for t in grid:
        p = softmax(logits, t)
        nll = -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1)).mean()
        if nll < best_nll:
            best_nll, best_t = nll, float(t)
    return best_t


def calibrate_thresholds(probs: np.ndarray, y: np.ndarray, classes: List[str], target_far: float = 0.05, min_threshold: float = 0.5) -> Dict[str, float]:
    unknown = classes.index("UNKNOWN")
    pred = probs.argmax(axis=1)
    conf = probs.max(axis=1)
    out: Dict[str, float] = {}
    for c, name in enumerate(classes):
        if c == unknown:
            continue
        unk_as_c = conf[(y == unknown) & (pred == c)]
        if unk_as_c.size:
            # accept at most target_far of the unknowns predicted as c: threshold at the (1 - far) quantile
            thr = float(np.quantile(unk_as_c, 1 - target_far))
            thr = min(0.999, max(min_threshold, thr))
        else:
            known_as_c = conf[(y == c) & (pred == c)]
            thr = float(max(min_threshold, known_as_c.min())) if known_as_c.size else min_threshold
        out[name] = round(thr, 4)
    return out


def apply_thresholds(probs: np.ndarray, classes: List[str], thresholds: Dict[str, float], margin: float = 0.1) -> np.ndarray:
    """Browser decideOpenSet parity: compare top two known classes, then UNKNOWN."""
    unknown = classes.index("UNKNOWN")
    known_ids = [i for i in range(len(classes)) if i != unknown]
    if not known_ids:
        return np.full(len(probs), unknown, dtype=int)
    if set(thresholds) != {classes[i] for i in known_ids}:
        raise ValueError("thresholds must cover exactly the known model classes")
    known_probs = probs[:, known_ids]
    order = np.argsort(-known_probs, axis=1)
    top = np.asarray(known_ids)[order[:, 0]]
    p1 = probs[np.arange(len(probs)), top]
    p2 = known_probs[np.arange(len(probs)), order[:, 1]] if len(known_ids) > 1 else np.zeros(len(probs))
    limits = np.asarray([thresholds[classes[i]] for i in top])
    # 1 is the disabled-class sentinel, even if floating-point softmax saturates
    # to exactly 1. Keep parity with the browser's decideOpenSet implementation.
    rejected = (limits >= 1) | (probs[:, unknown] >= p1) | (p1 < limits) | (p1 - p2 < margin)
    return np.where(rejected, unknown, top)


def evaluate_thresholds(probs: np.ndarray, y: np.ndarray, classes: List[str], thresholds: Dict[str, float], margin: float = 0.1) -> dict:
    unknown = classes.index("UNKNOWN")
    decided = apply_thresholds(probs, classes, thresholds, margin)
    known = y != unknown
    return {
        "unknown_false_acceptance": unknown_false_acceptance(y, decided, unknown) if (y == unknown).any() else None,
        "known_rejection_rate": float((decided[known] == unknown).mean()) if known.any() else None,
        "accuracy_on_accepted": float((decided[known & (decided != unknown)] == y[known & (decided != unknown)]).mean()) if (known & (decided != unknown)).any() else None,
    }


def calibrate(logits: np.ndarray, y: np.ndarray, classes: List[str], target_far: float = 0.05, margin: float = 0.1) -> dict:
    if not classes or classes[-1] != "UNKNOWN" or len(set(classes)) != len(classes):
        raise ValueError("classes must be unique and end in UNKNOWN")
    if logits.ndim != 2 or logits.shape[1] != len(classes) or len(logits) != len(y) or len(y) == 0:
        raise ValueError("nonempty logits [N,C] and labels [N] must match classes")
    if not np.isfinite(logits).all() or not np.issubdtype(y.dtype, np.integer) or y.min() < 0 or y.max() >= len(classes):
        raise ValueError("invalid logits or class indices")
    if not 0 <= target_far <= 1:
        raise ValueError("target_far must be in [0,1]")
    temperature = fit_temperature(logits, y)
    probs = softmax(logits, temperature)
    thresholds = calibrate_thresholds(probs, y, classes, target_far)
    support = {c: int((y == i).sum()) for i, c in enumerate(classes)}
    # Absent negative evidence cannot establish a false-acceptance cutoff.
    for c in thresholds:
        if support["UNKNOWN"] == 0 or support[c] == 0:
            thresholds[c] = 1.0
    return {
        "classes": classes,
        "status": "provisional",
        "class_support": support,
        "unknown_support": support["UNKNOWN"],
        "temperature": temperature,
        "ece_before": expected_calibration_error(softmax(logits), y),
        "ece_after": expected_calibration_error(probs, y),
        "target_unknown_false_acceptance": target_far,
        "margin": margin,
        "thresholds": thresholds,
        "evaluation": evaluate_thresholds(probs, y, classes, thresholds, margin),
        "note": "thresholds are per movement and valid only for the model/version they were fitted on; re-fit after any retraining",
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("logits_npz", type=Path, help="npz with arrays 'logits' [N,C] and 'y' [N]")
    ap.add_argument("--classes", nargs="+")
    ap.add_argument("--target-far", type=float, default=0.05)
    ap.add_argument("--out", type=Path, default=Path("ml/runs/open_set_thresholds.json"))
    a = ap.parse_args()
    d = np.load(a.logits_npz)
    if "split" in d and str(d["split"].item()) != "val":
        ap.error("calibrate only on the validation split; test data must remain held out")
    classes = a.classes or (d["classes"].tolist() if "classes" in d else None)
    if not classes:
        ap.error("--classes required when NPZ has no class metadata")
    if "classes" in d and classes != d["classes"].tolist():
        ap.error("--classes order differs from NPZ model metadata")
    res = calibrate(d["logits"], d["y"], classes, a.target_far)
    for name in ("run_id", "checkpoint_sha256", "split"):
        if name in d:
            res[name] = str(d[name].item())
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, indent=2))
    print(json.dumps({"temperature": res["temperature"], "thresholds": res["thresholds"], **res["evaluation"]}))
