"""Evaluation metrics required by TRD 10: macro-F1, per-class confusion, unknown
false acceptance, phase boundary MAE, calibration ECE, per-view breakdown.
Pure numpy; class-balanced reporting, never a single global accuracy alone."""
from __future__ import annotations

from typing import Dict, List, Sequence

import numpy as np


def confusion_matrix(y_true: Sequence[int], y_pred: Sequence[int], n_classes: int) -> np.ndarray:
    cm = np.zeros((n_classes, n_classes), dtype=int)
    for t, p in zip(y_true, y_pred):
        cm[t, p] += 1
    return cm


def per_class_f1(cm: np.ndarray) -> np.ndarray:
    tp = np.diag(cm).astype(float)
    fp = cm.sum(axis=0) - tp
    fn = cm.sum(axis=1) - tp
    denom = 2 * tp + fp + fn
    with np.errstate(divide="ignore", invalid="ignore"):
        f1 = np.where(denom > 0, 2 * tp / denom, 0.0)
    return f1


def macro_f1(y_true, y_pred, n_classes: int, ignore_empty: bool = True) -> float:
    cm = confusion_matrix(y_true, y_pred, n_classes)
    f1 = per_class_f1(cm)
    if ignore_empty:
        present = cm.sum(axis=1) > 0
        if present.any():
            return float(f1[present].mean())
    return float(f1.mean())


def unknown_false_acceptance(y_true, y_pred, unknown_class: int) -> float:
    """Fraction of truly-UNKNOWN samples that were accepted as a known movement."""
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    unk = y_true == unknown_class
    if not unk.any():
        return 0.0
    return float((y_pred[unk] != unknown_class).mean())


def boundary_mae_ms(pred_boundaries: Dict[str, float], true_boundaries: Dict[str, float]) -> float:
    """Mean absolute error over phase boundaries present in both; NaN if none."""
    keys = sorted(set(pred_boundaries) & set(true_boundaries))
    if not keys:
        return float("nan")
    return float(np.mean([abs(pred_boundaries[k] - true_boundaries[k]) for k in keys]))


def boundary_within_tolerance_rate(pred_boundaries: Dict[str, float], true_boundaries: Dict[str, float], tolerance_ms: float) -> float:
    """Fraction of phase boundaries predicted within +/- tolerance_ms of the label (human/annotator variance aware).

    Annotators and athletes do not place phase boundaries to the millisecond; a boundary error smaller than the
    sport pack's timing floor (e.g. the squash profile's 80 ms) is not a model error. NaN if no shared boundaries.
    """
    keys = sorted(set(pred_boundaries) & set(true_boundaries))
    if not keys:
        return float("nan")
    return float(np.mean([abs(pred_boundaries[k] - true_boundaries[k]) <= tolerance_ms for k in keys]))


def expected_calibration_error(probs: np.ndarray, y_true: Sequence[int], n_bins: int = 10) -> float:
    probs = np.asarray(probs)
    y_true = np.asarray(y_true)
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    acc = (pred == y_true).astype(float)
    bins = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = (conf > lo) & (conf <= hi)
        if sel.any():
            ece += sel.mean() * abs(acc[sel].mean() - conf[sel].mean())
    return float(ece)


def per_view(y_true, y_pred, views: Sequence[str], n_classes: int) -> Dict[str, Dict[str, float]]:
    y_true = np.asarray(y_true)
    y_pred = np.asarray(y_pred)
    views = np.asarray(views)
    out = {}
    for v in sorted(set(views.tolist())):
        sel = views == v
        out[v] = {"n": int(sel.sum()), "macro_f1": macro_f1(y_true[sel], y_pred[sel], n_classes)}
    return out


def report(y_true, y_pred, probs, classes: List[str], views: Sequence[str] | None = None, boundaries: List[tuple] | None = None) -> dict:
    n = len(classes)
    unknown = classes.index("UNKNOWN") if "UNKNOWN" in classes else None
    cm = confusion_matrix(y_true, y_pred, n)
    rep = {
        "macro_f1": macro_f1(y_true, y_pred, n),
        "per_class_f1": dict(zip(classes, per_class_f1(cm).round(4).tolist())),
        "confusion": cm.tolist(),
        "ece": expected_calibration_error(np.asarray(probs), y_true),
        "unknown_false_acceptance": unknown_false_acceptance(y_true, y_pred, unknown) if unknown is not None else None,
        "per_view": per_view(y_true, y_pred, views, n) if views is not None else None,
        "boundary_mae_ms": float(np.nanmean([boundary_mae_ms(p, t) for p, t in boundaries])) if boundaries else None,
    }
    return rep
