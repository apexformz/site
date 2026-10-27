"""
Leave-one-camera-view-out evaluation of a probability-averaging ensemble of two already-trained fold models.

For each held-out view, both members must have been trained on the same fold split. The ensemble's class
probabilities are the weighted mean of the members' softmax outputs. The primary weight (0.5) is fixed in
advance. Other weights are printed only as a sensitivity check; choosing among them on these folds would be
test-set tuning.

    python ml/sports/squash/ensemble_eval.py \
        --a "ml/runs/squash/confirm_long/world18k/dynamic_movement/world/{view}" \
        --b "ml/runs/squash/confirm_long/sim18k_{view}/dynamic_movement/sim_stgcn/{view}"
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from cross_view_eval import HELD_OUT_VIEWS, predict, softmax, summarize, taxonomy_index  # noqa: E402
from training.train import load_run  # noqa: E402


def newest_record(folder: Path) -> Path:
    recs = [p for p in folder.glob("*.json") if p.name != "split.json"]
    recs = [p for p in recs if "loss_history" in json.loads(p.read_text(encoding="utf-8"))]
    if not recs:
        raise FileNotFoundError(f"no run record in {folder}")
    return max(recs, key=lambda p: p.stat().st_mtime)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True, help="fold folder pattern of member A, with {view}")
    ap.add_argument("--b", required=True, help="fold folder pattern of member B, with {view}")
    ap.add_argument("--weight", type=float, default=0.5, help="weight of member A (fixed in advance)")
    ap.add_argument("--task", default="dynamic_movement")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--test-dataset", type=Path, default=None, help="score on this manifest's held-out views (default: the members' own)")
    a = ap.parse_args()
    manifest = ROOT / "data" / "squash" / f"dataset_{a.task}.json"
    full = sorted({e["movement_id"] for e in json.loads(manifest.read_text(encoding="utf-8"))["executions"]}) + ["UNKNOWN"]
    _, _, gids, fids = taxonomy_index(full)
    weights = sorted({a.weight, 0.0, 0.3, 0.5, 0.7, 1.0})
    folds = {w: {} for w in weights}
    for view in HELD_OUT_VIEWS:
        ra, rb = newest_record(ROOT / a.a.format(view=view)), newest_record(ROOT / a.b.format(view=view))
        cfg_a, cfg_b = load_run(str(ra))[1], load_run(str(rb))[1]
        if list(cfg_a.classes) != list(cfg_b.classes):
            raise ValueError(f"{view}: members were trained on different class lists")
        if a.test_dataset:
            import dataclasses
            from cross_view_eval import write_split
            tm = a.test_dataset.resolve()
            split = write_split(tm, view, (ROOT / a.a.format(view=view)) / "split_test.json")
            cfg_a = dataclasses.replace(cfg_a, dataset_manifest=str(tm), split_manifest=str(split))
            cfg_b = dataclasses.replace(cfg_b, dataset_manifest=str(tm), split_manifest=str(split))
        la, ya = predict(str(ra), cfg_a)
        lb, yb = predict(str(rb), cfg_b)
        if not np.array_equal(ya, yb):
            raise ValueError(f"{view}: members scored different test windows")
        pa, pb = softmax(la), softmax(lb)
        cg, cf = taxonomy_index(list(cfg_a.classes))[:2]
        for w in weights:
            s = summarize(w * pa + (1 - w) * pb, ya, cg, cf, len(gids), len(fids), len(cfg_a.classes) - 1)
            del s["_gate_data"]
            folds[w][view] = s
    keys = (("family", "top1"), ("group", "top1"), ("movement", "top1"), ("movement", "top5"), ("family", "macro_f1"))
    report = {}
    for w in weights:
        mean = {f"{lvl}.{k}": float(np.mean([folds[w][v][lvl][k] for v in HELD_OUT_VIEWS])) for lvl, k in keys}
        report[str(w)] = {"mean": mean, "folds": folds[w]}
        tag = "A only" if w == 1.0 else "B only" if w == 0.0 else f"w_A={w}" + ("  (primary)" if w == a.weight else "")
        print(f"{tag:22s}", "  ".join(f"{k}={v:.3f}" for k, v in mean.items()))
    if a.out:
        a.out.write_text(json.dumps({"a": a.a, "b": a.b, "primary_weight": a.weight, "results": report}, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
