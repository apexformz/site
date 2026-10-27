"""Record deterministic PyTorch outputs for the installed squash models' exact training records.

This is an explicit fixture regeneration step when intentionally updating installed weights.
It does not train, collect data, or estimate recognition accuracy.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml"))
sys.path.insert(0, str(ROOT / "tools"))
import torch
from training.train import load_run
from build_squash_ensemble import ProbabilityEnsemble


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dynamic-summary", type=Path, required=True)
    ap.add_argument("--static-record", type=Path, required=True)
    ap.add_argument("--public-dir", type=Path, default=ROOT / "apps/frontend/public/models/squash")
    ap.add_argument("--out", type=Path, default=ROOT / "tests/models/installed-movement-outputs.json")
    args = ap.parse_args()
    torch.set_num_threads(1)
    summary = json.loads(args.dynamic_summary.read_text(encoding="utf-8"))
    records = [load_run(path) for path in summary["members"]]
    deployment = json.loads((args.public_dir / "dynamic_movement.deployment.json").read_text(encoding="utf-8"))
    expected_ids = [member["run_id"] for member in deployment["ensemble"]["members"]]
    if [r[2]["run_id"] for r in records] != expected_ids:
        raise ValueError("training records do not match installed ensemble members")
    dynamic = ProbabilityEnsemble(records[0][0], records[1][0], deployment["ensemble"]["weights"][0])
    static, _, static_record = load_run(str(args.static_record))
    static_deployment = json.loads((args.public_dir / "static_pose.deployment.json").read_text(encoding="utf-8"))
    if static_record["run_id"] != static_deployment["model"]["version"]:
        raise ValueError("training record does not match installed static model")
    results = {}
    for name, model, config, source_records in [
        ("dynamic_movement", dynamic, deployment, [r[2] for r in records]),
        ("static_pose", static, static_deployment, [static_record]),
    ]:
        window = config["input"]["window_frames"]
        x = torch.tensor([(i % 31 - 15) / 32 for i in range(window * 99)], dtype=torch.float32).reshape(1, window, 99)
        mask = torch.tensor([float(i % 11 != 0) for i in range(window * 33)], dtype=torch.float32).reshape(1, window, 33)
        model.eval()
        with torch.no_grad():
            logits = model(x, mask).cpu()
        model_path = args.public_dir / f"{name}.onnx"
        digest = "sha256:" + hashlib.sha256(model_path.read_bytes()).hexdigest()
        if digest != config["model"]["digest"]:
            raise ValueError(f"{name} installed model digest mismatch")
        results[name] = {
            "model_digest": digest, "model_version": config["model"]["version"], "window_frames": window,
            "input_recipe": "input[i]=(i%31-15)/32; mask[i]=Number(i%11!==0)",
            "output_dims": list(logits.shape), "output": logits.reshape(-1).tolist(),
            "training_records": [{"run_id": r["run_id"], "checkpoint_sha256": r["checkpoint_sha256"]} for r in source_records],
        }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"schema_version": 1, "reference": "PyTorch CPU eval; deterministic arithmetic input, no athlete data", "models": results}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(args.out), "models": list(results), "reference": "PyTorch CPU"}))


if __name__ == "__main__":
    main()
