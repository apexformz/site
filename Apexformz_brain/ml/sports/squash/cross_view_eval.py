"""
Leave-one-camera-view-out evaluation of the squash recognizers, at movement, group and family level.

One athlete means no athlete-held-out test exists. Camera view is the one independent axis the data has: every
movement was filmed from front, back and left. Each fold trains on two views (plus the few right-view clips) and
tests on the third. This measures generalisation to an unseen camera angle, NOT to unseen athletes; the report
says so.

Compares two recipes:
  baseline  original training: strict frame gate, tracker continuity, no speed augmentation, no hierarchy loss
  improved  identity_only frame gate, geometric single-athlete continuity, speed augmentation 0.8-1.25,
            hierarchy-aware loss (weight 0.5) using the sport-pack taxonomy

and calibrates the group/family recognition gates (probability needed to report a group or family) for a target
accuracy on accepted answers, on the held-out views. Movement-level acceptance thresholds stay disabled: without
labeled unknown-movement examples a false-acceptance rate cannot be estimated.

  .venv/Scripts/python ml/sports/squash/cross_view_eval.py --steps 1000 --out ml/runs/squash/cross_view
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(ROOT / "tools"))
os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from training.train import TrainConfig, load_run, make_dataset, select_device, sequence_logits, train  # noqa: E402

HELD_OUT_VIEWS = ("front", "back", "left")
TARGET_ACCURACY = 0.9


def taxonomy_index(classes, pack=ROOT / "sport-packs" / "squash" / "movement_catalog.json"):
    cat = json.loads(Path(pack).read_text(encoding="utf-8"))
    groups, families = {}, {}
    for f in cat["taxonomy"]["families"]:
        for g in f["groups"]:
            for m in g["members"]:
                groups[m] = g["id"]
                families[m] = f["id"]
    gids = sorted(set(groups.values()))
    fids = sorted(set(families.values()))
    cg = [gids.index(groups[c]) if c in groups else -1 for c in classes]
    cf = [fids.index(families[c]) if c in families else -1 for c in classes]
    return cg, cf, gids, fids


def write_split(manifest_path: Path, held: str, out: Path) -> Path:
    m = json.loads(manifest_path.read_text(encoding="utf-8"))
    streams = {s["view_stream_id"]: s for s in m["view_streams"]}
    cams = {c["camera_id"]: c["view"] for c in m["cameras"]}
    assign = {e["execution_id"]: ("test" if cams[streams[e["view_stream_ids"][0]]["camera_id"]] == held else "train") for e in m["executions"]}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"assignments": assign, "strategy": f"leave-one-view-out:{held}", "note": "cross-view only; same athlete and sessions on both sides"}), encoding="utf-8")
    return out


@torch.no_grad()
def predict(record_path: str, cfg: TrainConfig):
    model, _, _ = load_run(record_path)
    device = select_device()
    model.to(device)
    ds = make_dataset(cfg, "test")
    if not len(ds):
        return np.zeros((0, len(cfg.classes))), np.zeros(0, dtype=int)
    loader = torch.utils.data.DataLoader(ds, batch_size=64, shuffle=False)
    out, ys = [], []
    for x, m, y in loader:
        out.append(sequence_logits(model, model(x.to(device), m.to(device)), cfg.causal).cpu().numpy())
        ys.append(y.numpy())
    return np.concatenate(out), np.concatenate(ys)


def level_scores(probs: np.ndarray, y: np.ndarray, index, n_levels: int):
    """Aggregate class probabilities to a level; return (predicted level, its prob, true level) for rows in the taxonomy."""
    idx = np.asarray(index)
    keep = idx[y] >= 0
    P = np.zeros((len(probs), n_levels))
    for c, l in enumerate(idx):
        if l >= 0:
            P[:, l] += probs[:, c]
    pred = P.argmax(1)
    srt = np.sort(P, axis=1)
    return pred[keep], srt[keep, -1], (srt[keep, -1] - srt[keep, -2]) if n_levels > 1 else srt[keep, -1], idx[y][keep]


def macro_f1(y, p, n):
    f1 = []
    for c in range(n):
        tp = ((p == c) & (y == c)).sum(); fp = ((p == c) & (y != c)).sum(); fn = ((p != c) & (y == c)).sum()
        if tp + fn == 0:
            continue
        f1.append(0.0 if tp == 0 else 2 * tp / (2 * tp + fp + fn))
    return float(np.mean(f1)) if f1 else None


def softmax(z):
    z = z - z.max(1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(1, keepdims=True)


def summarize(probs, y, cg, cf, ng, nf, unknown):
    known = y != unknown
    probs, y = probs[known], y[known]
    fine = probs[:, :unknown].argmax(1)
    gp, gprob, gmargin, gy = level_scores(probs, y, cg, ng)
    fp, fprob, fmargin, fy = level_scores(probs, y, cf, nf)
    return {
        "windows": int(len(y)),
        "movement": {"top1": float((fine == y).mean()), "macro_f1": macro_f1(y, fine, unknown), "top5": float(np.mean([y[i] in np.argsort(-probs[i, :unknown])[:5] for i in range(len(y))]))},
        "group": {"top1": float((gp == gy).mean()), "macro_f1": macro_f1(gy, gp, ng)},
        "family": {"top1": float((fp == fy).mean()), "macro_f1": macro_f1(fy, fp, nf)},
        "_gate_data": {"group": (gprob, gmargin, gp == gy), "family": (fprob, fmargin, fp == fy)},
    }


def gate_curve(prob, margin, correct, min_margin=0.1):
    """Accuracy on accepted answers and coverage for every probability gate (margin fixed)."""
    rows = []
    for t in np.round(np.arange(0.2, 0.96, 0.05), 2):
        acc_mask = (prob >= t) & (margin >= min_margin)
        rows.append({"threshold": float(t), "coverage": float(acc_mask.mean()), "n_accepted": int(acc_mask.sum()),
                     "accuracy_on_accepted": float(correct[acc_mask].mean()) if acc_mask.any() else None})
    return rows


def calibrate_gate(prob, margin, correct, target=TARGET_ACCURACY, min_margin=0.1):
    """Lowest probability gate whose accepted answers reach the target accuracy (margin fixed at min_margin)."""
    best = None
    for t in np.round(np.arange(0.3, 0.96, 0.05), 2):
        acc_mask = (prob >= t) & (margin >= min_margin)
        if acc_mask.sum() < 10:
            continue
        acc = correct[acc_mask].mean()
        if acc >= target:
            best = {"threshold": float(t), "margin": min_margin, "accuracy_on_accepted": float(acc), "coverage": float(acc_mask.mean()), "n_accepted": int(acc_mask.sum())}
            break
    return best


RECIPES = {
    "baseline": dict(frame_gate="strict", subject_continuity="tracker", speed_range=None, hierarchy_loss_weight=0.0),
    "improved": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5),
    "world": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1"),
    # --- simulation search (ml/training/simulate.py): each training sample is a new simulated execution
    "sim": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1",
                simulate={"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}),
    "sim_strong": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.75, 1.33], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1",
                       simulate={"bone_scale": 0.2, "asymmetry": 0.05, "tilt_deg": 12, "depth_noise": 0.06, "p": 0.9}),
    "sim_ls": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1",
                   simulate={"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}, label_smoothing=0.1),
    "sim_wide": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1",
                     simulate={"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}, channels=[64, 64, 128], dropout=0.25),
    "sim_hier1": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=1.0, normalization="world_bodyframe_v1",
                      simulate={"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}),
    "sim_stgcn": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1",
                      simulate={"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}, model="stgcnpp", base_channels=32, lr=5e-4),
    # ablation for sim_stgcn: same architecture, no simulation (separates the model gain from the simulation gain)
    "world_stgcn": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.5, normalization="world_bodyframe_v1",
                        model="stgcnpp", base_channels=32, lr=5e-4),
    "world_flat": dict(frame_gate="identity_only", subject_continuity="geometric", speed_range=[0.8, 1.25], hierarchy_loss_weight=0.0, normalization="world_bodyframe_v1"),
}


def base_config(task: str, out_dir: Path, steps: int, classes):
    manifest = ROOT / "data" / "squash" / f"dataset_{task}.json"
    static = task == "static_pose"
    return TrainConfig(model="tcn", model_task=task, classes=classes,
                       channels=[32, 32] if static else [32, 32, 64], kernel=1 if static else 3,
                       window_frames=1 if static else 45, stride=1 if static else 15, steps=steps, batch_size=32,
                       augment_cfg={"jitter_sigma": .005 if static else .01, "occlusion_p": .05, "resample": False, "mirror": False},
                       allow_development_split=True, dataset_manifest=str(manifest), out_dir=str(out_dir))


def reuse_record(run_dir: Path, cfg) -> dict | None:
    """Newest finished run record in the fold folder with the same model and step budget, if any."""
    for f in sorted(run_dir.glob(f"{cfg.model}-*.json"), key=lambda q: q.stat().st_mtime, reverse=True):
        try:
            r = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if r.get("run_id") and isinstance(r.get("loss_history"), list) and r.get("steps") == cfg.steps and Path(r.get("checkpoint", "")).exists():
            return {"record_path": str(f), "final_loss": r.get("final_loss")}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=1000)
    ap.add_argument("--out", type=Path, default=ROOT / "ml" / "runs" / "squash" / "cross_view")
    ap.add_argument("--tasks", nargs="+", default=["static_pose", "dynamic_movement"])
    ap.add_argument("--recipes", nargs="+", default=list(RECIPES))
    ap.add_argument("--seed", type=int, default=20261025, help="training seed (repeat with several seeds to measure run-to-run spread)")
    ap.add_argument("--subject-continuity", choices=["tracker", "tracker_root_v1", "geometric"], default=None,
                    help="override every recipe's subject continuity (tracker_root_v1 = the live-compatible policy)")
    ap.add_argument("--views", nargs="+", choices=list(HELD_OUT_VIEWS), default=list(HELD_OUT_VIEWS),
                    help="held-out views to run (run views as separate processes to use idle CPU/GPU capacity)")
    ap.add_argument("--dataset", type=Path, default=None, help="training dataset manifest (default data/squash/dataset_<task>.json)")
    ap.add_argument("--test-dataset", type=Path, default=None,
                    help="score held-out views on this manifest instead (compare training data versions on identical test windows)")
    ap.add_argument("--reuse", action="store_true",
                    help="score an already-trained run in the fold folder (same model and step budget) instead of retraining")
    a = ap.parse_args()
    if a.subject_continuity:
        for r in RECIPES.values():
            r["subject_continuity"] = a.subject_continuity
    report = {"protocol": "leave-one-camera-view-out (front, back, left); one athlete; measures unseen-view generalisation only",
              "target_accuracy_for_gates": TARGET_ACCURACY, "tasks": {}}
    try:
        from apexformz_telemetry import Run as _TelemetryRun
        search_tel = _TelemetryRun(kind="search", project="apexformz-brain", label="leave-one-view-out recipe search",
                                   total_steps=len(a.tasks) * len(a.recipes) * len(a.views),
                                   meta={"tasks": a.tasks, "recipes": a.recipes, "steps": a.steps}, sensitive=["meta", "label"])
    except Exception:  # noqa: BLE001
        search_tel = None
    done_folds = 0
    for task in a.tasks:
        manifest = (a.dataset or ROOT / "data" / "squash" / f"dataset_{task}.json").resolve()
        test_manifest = (a.test_dataset or manifest).resolve()
        m = json.loads(manifest.read_text(encoding="utf-8"))
        classes = sorted({e["movement_id"] for e in m["executions"]}) + ["UNKNOWN"]
        cg, cf, gids, fids = taxonomy_index(classes)
        unknown = len(classes) - 1
        report["tasks"][task] = {"classes": len(classes) - 1, "groups": len(gids), "families": len(fids), "recipes": {}}
        for recipe in a.recipes:
            folds, gate_pool = {}, {"group": [[], [], []], "family": [[], [], []]}
            for held in a.views:
                run_dir = a.out / task / recipe / held
                cfg = base_config(task, run_dir, a.steps, classes)
                cfg.seed = a.seed
                for k, v in RECIPES[recipe].items():
                    setattr(cfg, k, v)
                cfg.class_groups, cfg.class_families = cg, cf
                cfg.split_manifest = str(write_split(manifest, held, run_dir / "split.json"))
                train_ds = make_dataset(cfg, "train")
                present = {train_ds.classes[c] for c in {it[2] for it in train_ds.items}}
                missing = [c for c in classes[:-1] if c not in present]
                if missing:
                    # classes with no windows in the training views of this fold are kept as model outputs but
                    # cannot be learned; trainer requires explicit coverage, so drop them from the fold's class list.
                    cfg.excluded_classes = missing
                    cfg.classes = [c for c in classes if c not in missing]
                    cfg.class_groups, cfg.class_families = taxonomy_index(cfg.classes)[:2]
                print(json.dumps({"task": task, "recipe": recipe, "held_out_view": held, "train_windows": len(train_ds), "excluded_in_fold": len(missing)}), flush=True)
                rec = reuse_record(run_dir, cfg) if a.reuse else None
                if rec:
                    print(json.dumps({"reused": rec["record_path"]}), flush=True)
                else:
                    rec = train(cfg)
                if test_manifest != manifest:
                    cfg_test = dataclasses.replace(cfg, dataset_manifest=str(test_manifest),
                                                   split_manifest=str(write_split(test_manifest, held, run_dir / "split_test.json")))
                    logits, y = predict(rec["record_path"], cfg_test)
                else:
                    logits, y = predict(rec["record_path"], cfg)
                fold_cg, fold_cf = cfg.class_groups, cfg.class_families
                s = summarize(softmax(logits), y, fold_cg, fold_cf, len(gids), len(fids), len(cfg.classes) - 1)
                for lvl in ("group", "family"):
                    pr, mg, ok = s["_gate_data"][lvl]
                    gate_pool[lvl][0].append(pr); gate_pool[lvl][1].append(mg); gate_pool[lvl][2].append(ok)
                del s["_gate_data"]
                s["excluded_classes_in_fold"] = missing
                done_folds += 1
                if search_tel:
                    search_tel.step(done_folds, loss=rec["final_loss"], force=True,
                                    metrics={"family_top1": s["family"]["top1"], "group_top1": s["group"]["top1"], "movement_top1": s["movement"]["top1"]})
                s["final_loss"] = rec["final_loss"]
                folds[held] = s
            mean = lambda lvl, k: float(np.mean([f[lvl][k] for f in folds.values() if f[lvl][k] is not None]))  # noqa: E731
            pooled = {lvl: [np.concatenate(gate_pool[lvl][i]) for i in range(3)] for lvl in ("group", "family")}
            gates = {lvl: calibrate_gate(*pooled[lvl]) for lvl in ("group", "family")}
            curves = {lvl: gate_curve(*pooled[lvl]) for lvl in ("group", "family")}
            report["tasks"][task]["recipes"][recipe] = {
                "config": RECIPES[recipe],
                "mean": {lvl: {k: mean(lvl, k) for k in next(iter(folds.values()))[lvl]} for lvl in ("movement", "group", "family")},
                "folds": folds,
                "calibrated_gates": gates,
                "gate_curves": curves,
            }
            print(json.dumps({"task": task, "recipe": recipe, "mean": report["tasks"][task]["recipes"][recipe]["mean"], "gates": gates}), flush=True)
    if search_tel:
        search_tel.end("completed", {"folds": done_folds})
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "cross_view_report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("report:", a.out / "cross_view_report.json")


if __name__ == "__main__":
    main()
