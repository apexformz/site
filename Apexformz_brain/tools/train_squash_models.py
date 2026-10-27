"""Train local static/video squash baselines from prepared capture manifests.

No S3 operations or pose extraction occur here. Run --plan-only to inspect exact
classes, split evidence and usable sample counts before spending training time.
"""
from __future__ import annotations

import argparse
import dataclasses
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import numpy as np
import torch
from evaluation.evaluate import evaluate_run
from evaluation.open_set import calibrate
from export.export_onnx import export_run
from training.train import TrainConfig, file_sha256, make_dataset, train

TASKS = ("static_pose", "dynamic_movement")
POSE_MODEL_FILENAME = "pose_landmarker_full.task"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def validate_pose_model(value) -> dict:
    """Validate provenance without loading a detector or downloading any weights."""
    if not isinstance(value, dict):
        raise ValueError("prepared manifest requires pose_model provenance with the full checkpoint digest")
    if value.get("model_id") != "mediapipe_pose_landmarker" or not str(value.get("version", "")).startswith("full/float16/1/"):
        raise ValueError("browser recognition uses MediaPipe full/float16/1; re-extract captures with --variant full")
    digest = str(value.get("digest", "")).removeprefix("sha256:").lower()
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("prepared pose_model.digest must identify the exact full checkpoint by SHA-256")
    return {**value, "digest": f"sha256:{digest}", "model_url": f"/models/{POSE_MODEL_FILENAME}"}


def resolve_pose_checkpoint(pose_model: dict) -> Path:
    """Use the same pinned cache resolver as capture preparation, then verify bytes."""
    model = validate_pose_model(pose_model)
    sys.path.insert(0, str(ROOT / "packages/perception-py"))
    from apexformz_perception.pose.mediapipe_backend import ensure_model

    source = Path(ensure_model("full"))
    if file_sha256(str(source)) != model["digest"].removeprefix("sha256:"):
        raise ValueError("cached MediaPipe full checkpoint differs from prepared pose_model.digest; re-extract with the intended checkpoint before training/installing")
    return source


RECIPES = {
    # Original first-capture training.
    "baseline": {},
    # Live-compatible variant: retain tracker/ambiguity evidence and add a root-jump guard.
    # Historical research scores used geometric identity overrides and do not validate this recipe.
    "world_hierarchy": {"frame_gate": "identity_only", "subject_continuity": "tracker_root_v1", "normalization": "world_bodyframe_v1",
                        "speed_range": [0.8, 1.25], "hierarchy_loss_weight": 0.5},
    # ST-GCN++ candidates (ml/sports/squash/cross_view_eval.py world_stgcn / sim_stgcn, run with
    # --subject-continuity tracker_root_v1 for the live-compatible comparison).
    "stgcn_hierarchy": {"frame_gate": "identity_only", "subject_continuity": "tracker_root_v1", "normalization": "world_bodyframe_v1",
                        "speed_range": [0.8, 1.25], "hierarchy_loss_weight": 0.5, "model": "stgcnpp", "base_channels": 32, "lr": 5e-4},
    # + per-sample 3D simulation (ml/training/simulate.py): each training sample is a new simulated execution.
    "stgcn_sim_hierarchy": {"frame_gate": "identity_only", "subject_continuity": "tracker_root_v1", "normalization": "world_bodyframe_v1",
                            "speed_range": [0.8, 1.25], "hierarchy_loss_weight": 0.5, "model": "stgcnpp", "base_channels": 32, "lr": 5e-4,
                            "simulate": {"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}},
}


def taxonomy_indices(classes, pack_catalog: Path = ROOT / "sport-packs/squash/movement_catalog.json"):
    cat = json.loads(pack_catalog.read_text(encoding="utf-8"))
    groups, families = {}, {}
    for f in cat.get("taxonomy", {}).get("families", []):
        for g in f["groups"]:
            for m in g["members"]:
                groups[m], families[m] = g["id"], f["id"]
    gids, fids = sorted(set(groups.values())), sorted(set(families.values()))
    return ([gids.index(groups[c]) if c in groups else -1 for c in classes],
            [fids.index(families[c]) if c in families else -1 for c in classes])


def resolve_display_names(original: dict, catalog_path: Path = ROOT / "ml/sports/squash/source_catalog.json"):
    """Use exact Data Capture IDs; preserve the pinned manifest's original spelling as provenance."""
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    authoritative = {}
    for movement in catalog["movements"]:
        label, name = movement["movement_id"], movement["name"]
        if label in authoritative or not isinstance(name, str) or not name.strip():
            raise ValueError("canonical capture catalog has duplicate IDs or empty names")
        authoritative[label] = name
    names = {label: authoritative.get(label, name) for label, name in original.items()}
    names["UNKNOWN"] = "Unknown / other movement"
    provenance = {"method": "exact_movement_id", "catalog_path": str(catalog_path.resolve()),
                  "catalog_sha256": file_sha256(str(catalog_path)), "catalog_source": catalog.get("source"),
                  "original_manifest_class_names": original,
                  "corrected_class_names": {label: names[label] for label in original if names[label] != original[label]},
                  "unmatched_class_ids": [label for label in original if label != "UNKNOWN" and label not in authoritative]}
    return names, provenance


def task_plan(data_dir: Path, task: str, runs_dir: Path, *, steps=1000, epochs=None,
              batch_size=32, seed=20261025, allow_development_split=False, allow_partial_coverage=False, recipe: str = "baseline") -> dict:
    manifest_path = (data_dir / f"dataset_{task}.json").resolve()
    if not manifest_path.exists():
        raise ValueError(f"prepared dataset missing: {manifest_path}; run prepare_capture_dataset.py first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("model_task", task) != task or manifest.get("sport_pack_id") != "squash":
        raise ValueError(f"dataset task/sport mismatch: {manifest_path}")
    pose_model = validate_pose_model(manifest.get("pose_model"))
    executions = manifest.get("executions", [])
    source_catalog = manifest.get("source_label_catalog", {})
    if not isinstance(source_catalog, dict):
        raise ValueError("source_label_catalog must be keyed by original capture label IDs")
    labels = {e["movement_id"] for e in executions} | set(source_catalog)
    if not labels or any(not isinstance(c, str) or not c.strip() for c in labels):
        raise ValueError(f"no valid original capture labels: {manifest_path}")
    classes = sorted(labels - {"UNKNOWN"}) + ["UNKNOWN"]
    if len(classes) < 2:
        raise ValueError("at least one known movement class is required")
    names = {c: source_catalog.get(c, {}).get("name") or manifest.get("class_names", {}).get(c, c) for c in classes}
    names["UNKNOWN"] = "Unknown / other movement"
    names, name_provenance = resolve_display_names(names)
    assignments = manifest.get("splits", {}).get("assignments")
    if not assignments:
        raise ValueError("explicit grouped split assignments required; do not randomly split windows")
    if any(assignments.get(e["execution_id"]) not in {"train", "val", "test"} for e in executions):
        raise ValueError("every execution must have a valid train/val/test assignment")
    task_dir = (runs_dir / task).resolve()
    cfg = TrainConfig(model="tcn", model_task=task, classes=classes,
                      channels=[32, 32] if task == "static_pose" else [32, 32, 64],
                      kernel=1 if task == "static_pose" else 3,
                      window_frames=1 if task == "static_pose" else 45,
                      stride=1 if task == "static_pose" else 15,
                      steps=steps, batch_size=batch_size, seed=seed,
                      augment_cfg={"jitter_sigma": .005 if task == "static_pose" else .01,
                                   "occlusion_p": .05, "resample": False, "mirror": False},
                      allow_development_split=allow_development_split,
                      dataset_manifest=str(manifest_path), out_dir=str(task_dir))
    for key, value in RECIPES[recipe].items():
        setattr(cfg, key, value)
    # Racket hand of the training athletes (owner-attested or recorded); only a uniform known value is declared.
    hands = {a.get("handedness") for a in manifest.get("athletes", [])}
    cfg.canonical_handedness = next(iter(hands)) if len(hands) == 1 and hands <= {"left", "right"} else None
    split_info = {}
    for split in ("train", "val", "test"):
        assigned = sum(v == split for v in assignments.values())
        if not assigned:
            split_info[split] = {"executions": 0, "windows": 0, "status": "not_available"}
            continue
        ds = make_dataset(cfg, split)
        split_info[split] = {"executions": assigned, "windows": len(ds), "class_counts": ds.class_counts(),
                             "split_evidence": ds.split_evidence, "skipped_empty": ds.skipped_empty,
                             "rejected_windows": ds.rejected_windows, "rejected_by_sequence": ds.rejected_by_sequence,
                             "status": "available" if len(ds) else "no_usable_poses"}
    if not split_info["train"]["windows"]:
        raise ValueError(f"{task} has no usable training observations")
    missing = [c for c in classes[:-1] if split_info["train"]["class_counts"][c] == 0]
    if missing and not allow_partial_coverage:
        raise ValueError(f"{task} has classes without usable train windows: {missing}; repair extraction/splits or explicitly use --allow-partial-coverage for a documented development subset")
    source_classes = list(classes[:-1])
    support = {}
    for label in source_classes:
        prepared_count = sum(ex["movement_id"] == label for ex in executions)
        source = source_catalog.get(label, {})
        support[label] = {"class_name": names[label],
                          "source_capture_count": source.get("source_capture_count", prepared_count),
                          "prepared_capture_count": source.get("prepared_capture_count", prepared_count),
                          "preparation_exclusion_reasons": source.get("exclusion_reasons", {}),
                          "usable_windows": {split: split_info[split].get("class_counts", {}).get(label, 0)
                                             for split in ("train", "val", "test")}}
    excluded = [{"class_id": label, **support[label],
                 "reason": "no prepared captures" if support[label]["prepared_capture_count"] == 0
                           else "no usable training windows after quality, visibility and split filtering"}
                for label in missing]
    classes = [label for label in classes if label not in missing]
    if len(classes) < 2:
        raise ValueError(f"{task} has no known class with usable training windows")
    coverage = {"partial": bool(missing), "allow_partial_coverage": allow_partial_coverage,
                "source_catalog_available": bool(source_catalog),
                "source_class_count": len(source_classes), "modeled_class_count": len(classes) - 1,
                "source_classes": source_classes, "modeled_classes": classes[:-1],
                "class_support": support, "excluded_classes": excluded}
    cfg.classes = classes
    cfg.excluded_classes = missing
    if cfg.hierarchy_loss_weight > 0:
        cfg.class_groups, cfg.class_families = taxonomy_indices(classes)
    cfg.class_coverage = coverage
    names = {label: names[label] for label in classes}
    # Keep source support in coverage, while evaluation/training consume only the
    # explicit modeled subset. Excluded captures never become UNKNOWN samples.
    for split, info in split_info.items():
        if "class_counts" not in info:
            continue
        info["excluded_windows"] = sum(info["class_counts"].get(label, 0) for label in missing)
        info["class_counts"] = {label: info["class_counts"].get(label, 0) for label in classes}
        info["windows"] = sum(info["class_counts"].values())
        info["excluded_executions"] = [ex["execution_id"] for ex in executions
                                       if assignments[ex["execution_id"]] == split and ex["movement_id"] in missing]
        info["status"] = "available" if info["windows"] else "no_usable_poses"
    if epochs is not None:
        cfg.steps = max(1, math.ceil(split_info["train"]["windows"] / batch_size) * epochs)
    blockers = list(manifest.get("release_blockers", []))
    if missing:
        blockers.append(f"Partial capture-label coverage: {len(classes) - 1}/{len(source_classes)} classes modeled; {len(missing)} excluded classes have no usable training support.")
    evidence = split_info["train"]["split_evidence"]
    if evidence.get("athlete_disjoint") is not True:
        blockers.append("Athlete-disjoint evidence is unavailable or failed; this remains a development model.")
    if evidence.get("problems"):
        blockers.append("Explicit development override permits split leakage; no generalization claim is supported.")
    if not split_info["val"]["windows"]:
        blockers.append("No usable held-out validation set; calibration is unavailable.")
    if not split_info["test"]["windows"]:
        blockers.append("No usable held-out test set; no test accuracy will be reported.")
    if split_info.get("val", {}).get("class_counts", {}).get("UNKNOWN", 0) == 0:
        blockers.append("No validation UNKNOWN samples; acceptance thresholds remain 1 and unvalidated.")
    blockers.append("Expert approval and sustained reference-device release checks are outstanding.")
    return {"model_task": task, "manifest": str(manifest_path), "manifest_sha256": file_sha256(str(manifest_path)),
            "pose_model": pose_model,
            "coverage": coverage,
            "display_name_provenance": name_provenance,
            "classes": classes, "class_names": names, "splits": split_info, "config": dataclasses.asdict(cfg),
            "release_blockers": list(dict.fromkeys(blockers)), "production_eligible": False}


def run_task(plan: dict) -> dict:
    task = plan["model_task"]
    cfg = TrainConfig(**plan["config"])
    task_dir = Path(cfg.out_dir)
    if file_sha256(cfg.dataset_manifest) != plan["manifest_sha256"]:
        raise ValueError("dataset changed after preflight")
    print(json.dumps({"stage": "train", "task": task, "steps": cfg.steps,
                      "training_windows": plan["splits"]["train"]["windows"]}), flush=True)
    rec = train(cfg)
    reports = {}
    calibration_path = None
    for split in ("val", "test"):
        info = plan["splits"][split]
        if not info["windows"]:
            reports[split] = {"status": "not_available", "reason": "no usable held-out observations"}
            continue
        # A development override can train a prototype; it does not create a
        # held-out set when athlete/session/stream evidence says otherwise.
        if info.get("split_evidence", {}).get("problems"):
            reports[split] = {"status": "not_evaluated", "reason": "split leakage; refusing a held-out metric"}
            continue
        report_path = task_dir / f"{split}.evaluation.json"
        logits_path = task_dir / f"{split}.logits.npz"
        print(json.dumps({"stage": "evaluate", "task": task, "split": split}), flush=True)
        rep = evaluate_run(rec["record_path"], split=split, out=report_path, logits_out=logits_path,
                           calibration=calibration_path)
        reports[split] = {"status": "evaluated", "path": str(report_path), "n_windows": rep["n_windows"],
                          "macro_f1": rep["macro_f1"], "closed_set_macro_f1": rep["closed_set"]["macro_f1"],
                          "unknown_false_acceptance": rep["unknown_false_acceptance"],
                          "split_evidence": rep["split_evidence"]}
        if split == "val":
            with np.load(logits_path) as values:
                cal = calibrate(values["logits"], values["y"], cfg.classes)
            cal.update({"split": "val", "run_id": rec["run_id"], "checkpoint_sha256": rec["checkpoint_sha256"],
                        "dataset_manifest_sha256": plan["manifest_sha256"]})
            calibration_path = task_dir / "calibration.json"
            write_json(calibration_path, cal)
    export_dir = task_dir / "export"
    selected_report = reports.get("test", {}).get("path") or reports.get("val", {}).get("path")
    print(json.dumps({"stage": "export", "task": task}), flush=True)
    artifacts = export_run(Path(rec["record_path"]), export_dir / f"{task}.onnx", calibration=calibration_path,
                           evaluation=selected_report, model_url=f"{task}.onnx", class_names=plan["class_names"])
    if artifacts.get("equivalence_max_abs_diff") is None:
        raise ValueError("ONNX Runtime equivalence is required before installing browser model files")
    deployment_path = Path(artifacts["deployment"])
    deployment = json.loads(deployment_path.read_text(encoding="utf-8"))
    deployment["release_blockers"] = plan["release_blockers"]
    deployment["pose_model"] = plan["pose_model"]
    deployment["display_name_provenance"] = plan["display_name_provenance"]
    deployment["source_dataset_version"] = json.loads(Path(cfg.dataset_manifest).read_text(encoding="utf-8")).get("dataset_version")
    write_json(deployment_path, deployment)
    card_path = Path(artifacts["model_card"])
    card = json.loads(card_path.read_text(encoding="utf-8"))
    card["pose_model"] = plan["pose_model"]
    card["class_names"] = plan["class_names"]
    card["display_name_provenance"] = plan["display_name_provenance"]
    write_json(card_path, card)
    result = {"model_task": task, "record_path": rec["record_path"], "checkpoint": rec["checkpoint"],
              "pose_model": plan["pose_model"],
              "coverage": plan["coverage"],
              "display_name_provenance": plan["display_name_provenance"],
              "classes": cfg.classes, "class_names": plan["class_names"], "training": rec["dataset"],
              "initial_loss": rec["initial_loss"], "final_loss": rec["final_loss"], "duration_s": rec["duration_s"],
              "evaluation": reports, "calibration": str(calibration_path) if calibration_path else None,
              "artifacts": artifacts, "release_blockers": plan["release_blockers"], "production_eligible": False}
    write_json(task_dir / "training_summary.json", result)
    return result


def install_artifacts(results: list[dict], public_dir: Path) -> list[dict]:
    """Install completed local artifacts; update the discovery index only last."""
    if not results:
        raise ValueError("no completed model artifacts to install")
    for result in results:
        artifact = result.get("artifacts", {})
        if artifact.get("deployment"):
            deployment = json.loads(Path(artifact["deployment"]).read_text(encoding="utf-8"))
            if deployment.get("live_compatible") is False or deployment.get("input", {}).get("subject_continuity") == "geometric":
                raise ValueError("refusing to install live-incompatible geometric research model; retrain with tracker_root_v1")
            model_input = deployment.get("input", {})
            if "subject_continuity" not in model_input and (model_input.get("frame_gate") == "identity_only" or model_input.get("normalization") == "world_bodyframe_v1"):
                raise ValueError("refusing to assume a live-compatible subject continuity policy from incomplete metadata")
    pose_models = [validate_pose_model(r.get("pose_model")) for r in results]
    if len({m["digest"] for m in pose_models}) != 1:
        raise ValueError("all browser models must use the same prepared MediaPipe full checkpoint")
    # Resolve and hash before modifying any browser assets. Preparation and the
    # browser must use identical pose weights, not merely the same model family.
    pose_checkpoint = resolve_pose_checkpoint(pose_models[0])
    expected_pose_hash = pose_models[0]["digest"].removeprefix("sha256:")
    if file_sha256(str(pose_checkpoint)) != expected_pose_hash:
        raise ValueError("resolved MediaPipe checkpoint checksum does not match prepared provenance")
    public_dir.mkdir(parents=True, exist_ok=True)
    index_path = public_dir / "index.json"
    existing = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    if not isinstance(existing, list):
        raise ValueError("existing models index must be an array")
    pose_destination = public_dir.parent / POSE_MODEL_FILENAME
    staged_pose = pose_destination.with_name(pose_destination.name + ".tmp")
    shutil.copy2(pose_checkpoint, staged_pose)
    if file_sha256(str(staged_pose)) != expected_pose_hash:
        raise ValueError("staged browser pose checkpoint checksum mismatch")
    staged_pose.replace(pose_destination)
    replacement_names = {f"{r['model_task']}.deployment.json" for r in results}
    index = [entry for entry in existing if entry.get("deployment_url") not in replacement_names]
    for result in results:
        task = result["model_task"]
        artifact = result["artifacts"]
        for source in (Path(artifact["float_onnx"]), Path(artifact["deployment"]), Path(artifact["model_card"])):
            destination = public_dir / source.name
            staged = public_dir / (source.name + ".tmp")
            shutil.copy2(source, staged)
            staged.replace(destination)
        index.append({"deployment_url": f"{task}.deployment.json", "model_url": f"{task}.onnx"})
    staged_index = public_dir / "index.json.tmp"
    write_json(staged_index, index)
    staged_index.replace(index_path)
    return index


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data/squash")
    ap.add_argument("--tasks", nargs="+", choices=TASKS, default=list(TASKS))
    ap.add_argument("--runs-dir", type=Path, default=ROOT / "ml/runs/squash" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--public-dir", type=Path, default=ROOT / "apps/frontend/public/models/squash")
    budget = ap.add_mutually_exclusive_group()
    budget.add_argument("--steps", type=int, default=1000)
    budget.add_argument("--epochs", type=int)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--seed", type=int, default=20261025)
    ap.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    ap.add_argument("--allow-development-split", action="store_true")
    ap.add_argument("--allow-partial-coverage", action="store_true",
                    help="Explicitly train only labels with usable train windows and report every excluded source label")
    ap.add_argument("--plan-only", "--prepare-only", action="store_true")
    ap.add_argument("--recipe", choices=sorted(RECIPES), default="world_hierarchy",
                    help="Training recipe; world_hierarchy preserves tracker identity and adds the versioned root guard")
    args = ap.parse_args()
    if args.steps < 1 or (args.epochs is not None and args.epochs < 1) or args.batch_size < 1:
        ap.error("steps/epochs/batch-size must be positive")
    os.environ["APEXFORMZ_DEVICE"] = args.device
    torch.set_num_threads(1)
    plans = [task_plan(args.data_dir, task, args.runs_dir, steps=args.steps, epochs=args.epochs,
                       batch_size=args.batch_size, seed=args.seed, allow_development_split=args.allow_development_split,
                       allow_partial_coverage=args.allow_partial_coverage, recipe=args.recipe)
             for task in dict.fromkeys(args.tasks)]
    if len({p["pose_model"]["digest"] for p in plans}) != 1:
        raise ValueError("prepared task manifests use different pose weights; re-extract them with the same full checkpoint")
    for plan in plans:
        write_json(Path(plan["config"]["out_dir"]) / "train_config.json", plan["config"])
    write_json(args.runs_dir / "training_plan.json", {"device": args.device, "tasks": plans})
    if args.plan_only:
        print(json.dumps({"status": "planned", "path": str((args.runs_dir / "training_plan.json").resolve()),
                          "tasks": [{"task": p["model_task"], "classes": len(p["classes"]) - 1, "splits": p["splits"]} for p in plans]}), flush=True)
        return 0
    # Check the deployable pose checkpoint before spending time training; the
    # final install checks it again in case cache contents change during a run.
    resolve_pose_checkpoint(plans[0]["pose_model"])
    results = [run_task(plan) for plan in plans]
    index = install_artifacts(results, args.public_dir)
    write_json(args.runs_dir / "training_summary.json", {"tasks": results, "public_index": str((args.public_dir / "index.json").resolve()),
                                                       "models": index, "production_eligible": False})
    print(json.dumps({"status": "completed", "summary": str((args.runs_dir / "training_summary.json").resolve()),
                      "index": str((args.public_dir / "index.json").resolve())}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
