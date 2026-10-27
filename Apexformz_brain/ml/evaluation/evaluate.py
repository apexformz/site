"""Evaluate the exact trained recognizer on explicitly split real pose captures.
Writes a report and logits NPZ for validation-only calibration. Movement models do
not predict phase boundaries, so no phase metric is invented.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
import numpy as np
import torch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from evaluation.metrics import report
from evaluation.open_set import apply_thresholds, softmax
from training.train import TrainConfig, file_sha256, load_run, make_dataset, make_model, sequence_logits


def evaluate_run(run_record, *, checkpoint=None, dataset_manifest=None, split_manifest=None,
                 labels_file=None, split="test", out=None, logits_out=None, calibration=None,
                 batch_size=64, allow_development_split=None) -> dict:
    model, cfg, record = load_run(run_record, checkpoint)
    for key, value in (("dataset_manifest", dataset_manifest), ("split_manifest", split_manifest), ("labels_file", labels_file)):
        if value is not None:
            setattr(cfg, key, str(value))
    if allow_development_split is not None:
        cfg.allow_development_split = allow_development_split
    for field, hash_key, explicit in (("dataset_manifest", "dataset_manifest_sha256", dataset_manifest),
                                     ("split_manifest", "split_manifest_sha256", split_manifest),
                                     ("labels_file", "labels_sha256", labels_file)):
        expected = record.get(hash_key)
        if expected and explicit is None and file_sha256(getattr(cfg, field)) != expected:
            raise ValueError(f"{field} changed since training; explicitly override for a new evaluation dataset")
    ds = make_dataset(cfg, split)
    if not len(ds):
        raise ValueError(f"{split} split contains no usable pose windows")
    logits_parts, label_parts = [], []
    with torch.inference_mode():
        for x, mask, y in torch.utils.data.DataLoader(ds, batch_size=batch_size, shuffle=False):
            logits_parts.append(sequence_logits(model, model(x, mask), cfg.causal).numpy())
            label_parts.append(y.numpy())
    logits, y = np.concatenate(logits_parts), np.concatenate(label_parts)
    views = [m.get("view") or "unknown" for m in ds.metadata]
    probs = softmax(logits)
    closed = report(y, probs.argmax(1), probs, cfg.classes, views)
    cal = json.loads(Path(calibration).read_text(encoding="utf-8")) if calibration else None
    if cal:
        if cal.get("classes", cfg.classes) != cfg.classes:
            raise ValueError("calibration class order differs from the trained model")
        if cal.get("checkpoint_sha256") and cal["checkpoint_sha256"] != record.get("checkpoint_sha256"):
            raise ValueError("calibration was fitted to a different checkpoint")
        probs = softmax(logits, cal["temperature"])
        pred = apply_thresholds(probs, cfg.classes, cal["thresholds"], cal.get("margin", 0.1))
    else:
        pred = probs.argmax(1)
    rep = report(y, pred, probs, cfg.classes, views)
    rep.update({"schema_version": "1.0.0", "run_id": record["run_id"], "split": split, "synthetic": False,
                "n_windows": len(ds), "classes": cfg.classes, "class_support": ds.class_counts(),
                "unknown_support": int((y == cfg.classes.index("UNKNOWN")).sum()),
                "split_evidence": ds.split_evidence, "skipped_empty": ds.skipped_empty,
                "rejected_windows": ds.rejected_windows, "rejected_by_sequence": ds.rejected_by_sequence,
                "excluded_classes": ds.excluded_classes, "excluded_executions": ds.excluded_executions,
                "dataset_manifest_sha256": file_sha256(cfg.dataset_manifest),
                "split_manifest_sha256": file_sha256(cfg.split_manifest),
                "checkpoint_sha256": record.get("checkpoint_sha256"),
                "calibration_applied": bool(cal), "closed_set": closed,
                "boundary_metric_status": "not_applicable: movement classifier does not predict phase boundaries",
                "production_eligible": False,
                "release_gate": "development_evaluation; expert/device/unknown-class release gates still required"})
    if rep["unknown_support"] == 0:
        rep["unknown_false_acceptance"] = None
        rep["closed_set"]["unknown_false_acceptance"] = None
    if out:
        path = Path(out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rep, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    if logits_out:
        path = Path(logits_out)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(path, logits=logits, y=y, classes=np.asarray(cfg.classes), views=np.asarray(views),
                            sequence_ids=np.asarray([m["sequence_id"] for m in ds.metadata]),
                            split=np.asarray(split), run_id=np.asarray(record["run_id"]),
                            checkpoint_sha256=np.asarray(record.get("checkpoint_sha256") or ""))
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-record", type=Path)
    ap.add_argument("--checkpoint", type=Path)
    ap.add_argument("--dataset-manifest", type=Path)
    ap.add_argument("--split-manifest", type=Path)
    ap.add_argument("--labels-file", type=Path)
    ap.add_argument("--split", choices=["train", "val", "test"], default="test")
    ap.add_argument("--calibration", type=Path)
    ap.add_argument("--allow-development-split", action="store_true", default=None)
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--out", type=Path, default=Path("ml/runs/eval.json"))
    ap.add_argument("--logits-out", type=Path)
    args = ap.parse_args()
    if args.synthetic:
        cfg = TrainConfig()
        model = make_model(cfg).eval()
        rng = np.random.default_rng(0)
        y = rng.integers(0, len(cfg.classes), size=64)
        x = rng.normal(0, 0.1, size=(64, 45, 99)).astype(np.float32)
        with torch.inference_mode():
            logits = sequence_logits(model, model(torch.tensor(x), torch.ones(64, 45, 33)), True).numpy()
        probs = softmax(logits)
        rep = report(y, probs.argmax(1), probs, cfg.classes)
        rep.update({"synthetic": True, "note": "synthetic smoke test, not model-quality evidence"})
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(rep, indent=2), encoding="utf-8")
    else:
        if not args.run_record:
            ap.error("--run-record is required for real evaluation")
        rep = evaluate_run(args.run_record, checkpoint=args.checkpoint, dataset_manifest=args.dataset_manifest,
                           split_manifest=args.split_manifest, labels_file=args.labels_file, split=args.split,
                           out=args.out, logits_out=args.logits_out, calibration=args.calibration,
                           allow_development_split=args.allow_development_split)
    print(json.dumps({"macro_f1": rep["macro_f1"], "ece": rep["ece"], "unknown_false_acceptance": rep["unknown_false_acceptance"]}))


if __name__ == "__main__":
    main()
