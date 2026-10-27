"""
Build, verify and (optionally) install the squash dynamic-movement ensemble.

The ensemble has two members, trained on the same prepared dataset with identical live input contracts:
  A  world_hierarchy      TCN, longer budget                        (best top-1 on unseen views)
  B  stgcn_sim_hierarchy  ST-GCN++ with >= N simulated variants per window (best top-5 / robustness)
The browser model is one ONNX graph. It returns log(w*softmax(A) + (1-w)*softmax(B)) per timestep, so the
browser's softmax recovers the averaged probabilities exactly. The weight is fixed at 0.5 in advance.

Evidence (leave-one-camera-view-out, ml/sports/squash/ensemble_eval.py, docs/11): the ensemble beat the installed
4k model on family, group, movement top-1, top-5 and family F1.

    python tools/build_squash_ensemble.py                # train + verify, no install
    python tools/build_squash_ensemble.py --install      # ... and install (current files are backed up first)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "ml"))

import torch  # noqa: E402
from train_squash_models import install_artifacts, run_task, task_plan, write_json  # noqa: E402
from training.train import load_run  # noqa: E402
from export.export_onnx import export  # noqa: E402
from model_provenance import ensemble_lineage  # noqa: E402

TASK = "dynamic_movement"


class ProbabilityEnsemble(torch.nn.Module):
    """Per-timestep weighted mean of member softmax outputs, returned as log-probabilities."""

    def __init__(self, a: torch.nn.Module, b: torch.nn.Module, weight_a: float = 0.5):
        super().__init__()
        if list(a.classes) != list(b.classes):
            raise ValueError("ensemble members must share the exact class list")
        self.a, self.b, self.w = a, b, float(weight_a)
        self.classes = list(a.classes)
        self.num_landmarks = a.num_landmarks
        self.landmark_set = getattr(a, "landmark_set", "mediapipe_pose_33")
        self.causal = getattr(a, "causal", True) and getattr(b, "causal", True)

    def forward(self, x, mask):
        pa = torch.softmax(self.a(x, mask), dim=-1)
        pb = torch.softmax(self.b(x, mask), dim=-1)
        return torch.log(self.w * pa + (1.0 - self.w) * pb + 1e-12)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data/squash")
    ap.add_argument("--runs-dir", type=Path, default=ROOT / "ml/runs/squash" / ("ensemble_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")))
    ap.add_argument("--public-dir", type=Path, default=ROOT / "apps/frontend/public/models/squash")
    ap.add_argument("--steps-a", type=int, default=18000)
    ap.add_argument("--min-variants", type=int, default=1000, help="minimum simulated variants per training window for member B")
    ap.add_argument("--weight-a", type=float, default=0.5)
    ap.add_argument("--evidence", type=Path, default=ROOT / "ml/runs/squash/confirm_long/ensemble_report.json")
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--resume", action="store_true", help="reuse a member already trained in --runs-dir")
    a = ap.parse_args()
    os.environ.setdefault("APEXFORMZ_DEVICE", "auto")
    common = dict(allow_development_split=True, allow_partial_coverage=True)  # same flags as the installed model

    plan_a = task_plan(a.data_dir, TASK, a.runs_dir / "A_world_hierarchy", steps=a.steps_a, recipe="world_hierarchy", **common)
    probe = task_plan(a.data_dir, TASK, a.runs_dir / "B_stgcn_sim", steps=1, recipe="stgcn_sim_hierarchy", **common)
    windows = probe["splits"]["train"]["windows"]
    p_sim = probe["config"]["simulate"]["p"]
    steps_b = max(a.steps_a, math.ceil(a.min_variants * windows / (probe["config"]["batch_size"] * p_sim)))
    plan_b = task_plan(a.data_dir, TASK, a.runs_dir / "B_stgcn_sim", steps=steps_b, recipe="stgcn_sim_hierarchy", **common)
    if plan_a["classes"] != plan_b["classes"] or plan_a["manifest_sha256"] != plan_b["manifest_sha256"]:
        raise ValueError("members would be trained on different classes or datasets")
    variants = steps_b * plan_b["config"]["batch_size"] * p_sim / windows
    print(json.dumps({"stage": "plan", "train_windows": windows, "steps_a": a.steps_a, "steps_b": steps_b,
                      "simulated_variants_per_window_b": round(variants, 1)}), flush=True)
    for p in (plan_a, plan_b):
        write_json(Path(p["config"]["out_dir"]) / "train_config.json", p["config"])

    def run_or_resume(plan):
        done = Path(plan["config"]["out_dir"]) / "training_summary.json"
        if a.resume and done.exists():
            r = json.loads(done.read_text(encoding="utf-8"))
            if r.get("config_steps", plan["config"]["steps"]) == plan["config"]["steps"] and Path(r["record_path"]).exists():
                print(json.dumps({"stage": "resume", "record": r["record_path"]}), flush=True)
                return r
        return run_task(plan)

    res_a = run_or_resume(plan_a)
    res_b = run_or_resume(plan_b)

    model_a, cfg_a, rec_a = load_run(res_a["record_path"])
    model_b, cfg_b, rec_b = load_run(res_b["record_path"])
    lineage = ensemble_lineage([rec_a, rec_b])
    ens = ProbabilityEnsemble(model_a, model_b, a.weight_a)
    out_dir = a.runs_dir / "ensemble" / "export"
    onnx_path = out_dir / f"{TASK}.onnx"
    exp = export(ens, onnx_path, quantize=False)
    if exp.get("equivalence_max_abs_diff") is None:
        raise ValueError("ONNX Runtime equivalence is required before installing browser model files")

    dep_a = json.loads(Path(res_a["artifacts"]["deployment"]).read_text(encoding="utf-8"))
    dep_b = json.loads(Path(res_b["artifacts"]["deployment"]).read_text(encoding="utf-8"))
    if dep_a["input"] != dep_b["input"] or dep_a["classes"] != dep_b["classes"]:
        raise ValueError("members disagree on the live input contract or classes")
    digest = sha256(onnx_path)
    evidence = json.loads(a.evidence.read_text(encoding="utf-8")) if a.evidence.exists() else None
    deployment = dict(dep_a)
    deployment["model"] = {"model_id": f"squash.{TASK}.ensemble", "version": f"ensemble-{rec_a['run_id']}-{rec_b['run_id']}", "digest": f"sha256:{digest}"}
    deployment["ensemble"] = {
        "combine": "mean_softmax_per_timestep", "weights": [a.weight_a, 1 - a.weight_a], "weight_selection": "fixed in advance (0.5), not tuned on test folds",
        "members": [
            {"role": "A", "recipe": "world_hierarchy", "model": cfg_a.model, "steps": cfg_a.steps, "run_id": rec_a["run_id"], "member_onnx_digest": dep_a["model"]["digest"]},
            {"role": "B", "recipe": "stgcn_sim_hierarchy", "model": cfg_b.model, "steps": cfg_b.steps, "run_id": rec_b["run_id"], "member_onnx_digest": dep_b["model"]["digest"],
             "simulated_variants_per_window": round(variants, 1), "simulate": cfg_b.simulate},
        ],
        "cross_view_evidence": {"protocol": "leave-one-camera-view-out, one athlete, seed 11, members trained 18k steps per fold",
                                "report": str(a.evidence), "primary": (evidence or {}).get("results", {}).get(str(a.weight_a), {}).get("mean")},
    }
    dep_path = out_dir / f"{TASK}.deployment.json"
    write_json(dep_path, deployment)
    card = json.loads(Path(exp["model_card"]).read_text(encoding="utf-8"))
    card.update({"model": "ProbabilityEnsemble", "pose_model": plan_a["pose_model"], "class_names": plan_a["class_names"],
                 "ensemble": deployment["ensemble"], "display_name_provenance": plan_a["display_name_provenance"],
                 "dataset": lineage, "production_eligible": False})
    write_json(Path(exp["model_card"]), card)
    result = {"model_task": TASK, "pose_model": plan_a["pose_model"],
              "artifacts": {"float_onnx": str(onnx_path), "deployment": str(dep_path), "model_card": exp["model_card"],
                            "equivalence_max_abs_diff": exp["equivalence_max_abs_diff"]},
              "members": [res_a["record_path"], res_b["record_path"]], "production_eligible": False}
    write_json(a.runs_dir / "ensemble_summary.json", result)
    print(json.dumps({"stage": "verified", "onnx": str(onnx_path), "sha256": digest, "equivalence_max_abs_diff": exp["equivalence_max_abs_diff"],
                      "size_kb": round(onnx_path.stat().st_size / 1024)}), flush=True)

    if a.install:
        backup = a.runs_dir / "backup_installed"
        backup.mkdir(parents=True, exist_ok=True)
        for f in a.public_dir.glob(f"{TASK}*"):
            shutil.copy2(f, backup / f.name)
        if (a.public_dir / "index.json").exists():
            shutil.copy2(a.public_dir / "index.json", backup / "index.json")
        install_artifacts([result], a.public_dir)
        print(json.dumps({"stage": "installed", "public_dir": str(a.public_dir), "backup": str(backup)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
