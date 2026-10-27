"""Export a Brain recognizer (causal TCN or ST-GCN++) to ONNX with a dynamic time axis,
check float equivalence, optionally quantize, and write a model card (TRD 10/12).

The float model remains the reference. A quantized variant is only release-eligible
when it also meets the error and latency gates on representative devices (recorded
in the model card by the evaluation protocol, not here).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training.stgcn import build_model  # noqa: E402
from training.train import file_sha256, input_contract, load_run  # noqa: E402

TENSOR_CONTRACT = {
    "input": {"name": "input", "shape": ["batch", "time", "V*3"], "layout": "body-relative x,y,z per landmark; zeros where masked"},
    "mask": {"name": "mask", "shape": ["batch", "time", "V"], "layout": "1 observed / 0 padded, dropped or invalid"},
    "logits": {"name": "logits", "shape": ["batch", "time", "classes"], "note": "last class is UNKNOWN; causal models decide on the last frame"},
    "producer": "packages/analysis/src/recognizer.ts::seriesToTensor",
}


def export(model: torch.nn.Module, out: Path, T: int = 48, model_card_extra: dict | None = None, quantize: bool = True) -> dict:
    model.eval()
    V = model.num_landmarks
    x = torch.zeros(1, T, V * 3)
    mask = torch.ones(1, T, V)
    out.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model, (x, mask), str(out), input_names=["input", "mask"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch", 1: "time"}, "mask": {0: "batch", 1: "time"}, "logits": {0: "batch", 1: "time"}},
        opset_version=17, dynamo=False,
    )
    result = {"float_onnx": str(out), "model": type(model).__name__, "classes": model.classes, "equivalence_max_abs_diff": None, "quantized_onnx": None}
    try:
        import onnxruntime as ort  # type: ignore

        sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
        rng = np.random.default_rng(0)
        T2 = T + 7  # different length exercises the dynamic axis
        xt = rng.normal(0, 0.2, size=(2, T2, V * 3)).astype(np.float32)
        mt = (rng.random((2, T2, V)) > 0.1).astype(np.float32)
        with torch.no_grad():
            ref = model(torch.tensor(xt), torch.tensor(mt)).numpy()
        got = sess.run(["logits"], {"input": xt, "mask": mt})[0]
        result["equivalence_max_abs_diff"] = float(np.abs(ref - got).max())
        if result["equivalence_max_abs_diff"] > 1e-3:
            raise ValueError(f"ONNX float equivalence failed: {result['equivalence_max_abs_diff']}")
        try:
            if not quantize:
                raise RuntimeError("quantization not requested")
            from onnxruntime.quantization import QuantType, quantize_dynamic  # type: ignore

            q = out.with_name(out.stem + ".int8.onnx")
            quantize_dynamic(str(out), str(q), weight_type=QuantType.QInt8)
            qs = ort.InferenceSession(str(q), providers=["CPUExecutionProvider"])
            qgot = qs.run(["logits"], {"input": xt, "mask": mt})[0]
            result["quantized_onnx"] = str(q)
            result["quantized_max_abs_diff_vs_float"] = float(np.abs(ref - qgot).max())
        except Exception as e:  # noqa: BLE001
            result["quantization_skipped"] = str(e)
    except ImportError:
        result["equivalence_skipped"] = "onnxruntime not installed"
    (out.with_suffix(".export.json")).write_text(json.dumps(result, indent=2))
    card = {
        "model": type(model).__name__,
        "classes": model.classes,
        "landmark_set": getattr(model, "landmark_set", "mediapipe_pose_33"),
        "num_landmarks": V,
        "causal": getattr(model, "causal", True),
        "params": sum(p.numel() for p in model.parameters()),
        "tensor_contract": TENSOR_CONTRACT,
        "artifacts": {"float_onnx": str(out), "quantized_onnx": result.get("quantized_onnx"), "equivalence_max_abs_diff": result.get("equivalence_max_abs_diff")},
        "dataset": {"dataset_hash": "TODO_REQUIRES_VALIDATION", "split_manifest_hash": "TODO_REQUIRES_VALIDATION", "athlete_disjoint": None},
        "metrics": {"macro_f1": None, "unknown_false_acceptance": None, "boundary_mae_ms": None, "ece": None, "per_view": None, "status": "TODO_REQUIRES_VALIDATION"},
        "open_set_thresholds": "TODO_REQUIRES_VALIDATION: ml/evaluation/open_set.py output, shipped in the sport pack models[] entry",
        "license_notes": {"code": "Apache-2.0 (ApexFormz); ST-GCN++ architecture after PYSKL (Apache-2.0)", "weights": "derived from the training dataset licence and consent scope"},
        "intended_use": "within-domain movement recognition after explicit user sport selection; never bypasses the selected sport pack (TRD 05)",
    }
    if model_card_extra:
        card.update(model_card_extra)
    (out.with_name(out.stem + ".model_card.json")).write_text(json.dumps(card, indent=2))
    result["model_card"] = str(out.with_name(out.stem + ".model_card.json"))
    return result


def export_run(run_record: Path, out: Path, *, checkpoint=None, calibration=None, evaluation=None,
               sport_id="squash", model_id=None, version=None, model_url=None, movement_ids=None,
               class_names=None, quantize=False) -> dict:
    model, cfg, record = load_run(run_record, checkpoint)
    cal = json.loads(Path(calibration).read_text(encoding="utf-8")) if calibration else None
    ev = json.loads(Path(evaluation).read_text(encoding="utf-8")) if evaluation else None
    for artifact in (cal, ev):
        if artifact is None:
            continue
        if artifact.get("classes", cfg.classes) != cfg.classes:
            raise ValueError("artifact classes/order differ from the trained model")
        if artifact.get("checkpoint_sha256") and artifact["checkpoint_sha256"] != record.get("checkpoint_sha256"):
            raise ValueError("evaluation/calibration checkpoint does not match the trained model")
    if cal and cal.get("split") not in (None, "val"):
        raise ValueError("calibration must be fitted on validation data")
    thresholds = cal["thresholds"] if cal else {c: 1.0 for c in cfg.classes if c != "UNKNOWN"}
    if set(thresholds) != set(cfg.classes[:-1]):
        raise ValueError("calibration thresholds must cover exactly the known classes")
    mapping = json.loads(Path(movement_ids).read_text(encoding="utf-8")) if movement_ids else None
    if mapping and not set(mapping).issubset(set(cfg.classes[:-1])):
        raise ValueError("movement mapping contains classes absent from the model")
    names = json.loads(Path(class_names).read_text(encoding="utf-8")) if isinstance(class_names, (str, Path)) else class_names
    if names is not None and (not isinstance(names, dict) or not set(names).issubset(set(cfg.classes))
                              or any(not isinstance(v, str) or not v.strip() for v in names.values())):
        raise ValueError("class_names must map exact model classes to nonempty display names")
    extra = {
        "run_id": record["run_id"], "model_task": cfg.model_task, "input": input_contract(cfg),
        "dataset": {"dataset_hash": record.get("dataset_manifest_sha256"),
                    "split_manifest_hash": record.get("split_manifest_sha256"),
                    "labels_hash": record.get("labels_sha256"),
                    **(record.get("dataset") or {})},
        "metrics": ev or {"status": "not_evaluated"},
        "open_set_thresholds": cal or {"status": "not_calibrated", "thresholds": thresholds},
        "production_eligible": False,
        "live_compatible": cfg.subject_continuity in ("tracker", "tracker_root_v1"),
        "continuity_note": "Source ambiguity and tracker identity must be preserved; geometric research continuity is not a live policy.",
        "release_gate": "development artifact; empirical release and reference-device gates not approved",
    }
    if cfg.class_coverage is not None:
        extra["coverage"] = cfg.class_coverage
    result = export(model, out, T=cfg.window_frames, model_card_extra=extra, quantize=quantize)
    digest = file_sha256(str(out))
    deployment = {
        "schema_version": "1.0.0", "sport_id": sport_id, "model_task": cfg.model_task,
        "model_url": model_url or out.name,
        "model": {"model_id": model_id or f"{sport_id}.{cfg.model_task}.{cfg.model}",
                  "version": version or record["run_id"], "digest": f"sha256:{digest}"},
        "classes": cfg.classes, "input": input_contract(cfg),
        "calibration": {"temperature": cal["temperature"] if cal else 1.0,
                        "margin": cal.get("margin", 0.1) if cal else 0.1,
                        "thresholds": thresholds, "status": "provisional"},
        "unknown_support": (record.get("dataset") or {}).get("class_counts", {}).get("UNKNOWN", 0),
        "production_eligible": False,
        "live_compatible": cfg.subject_continuity in ("tracker", "tracker_root_v1"),
    }
    if mapping:
        deployment["movement_ids"] = mapping
    if cfg.class_coverage is not None:
        deployment["coverage"] = cfg.class_coverage
    if names:
        deployment["class_names"] = names
    dep_path = out.with_name(out.stem + ".deployment.json")
    dep_path.write_text(json.dumps(deployment, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    result.update({"deployment": str(dep_path), "sha256": digest})
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["tcn", "stgcnpp"], default="tcn")
    ap.add_argument("--landmark-set", default="mediapipe_pose_33")
    ap.add_argument("--checkpoint", type=Path)
    ap.add_argument("--run-record", type=Path)
    ap.add_argument("--calibration", type=Path)
    ap.add_argument("--evaluation", type=Path)
    ap.add_argument("--sport-id", default="squash")
    ap.add_argument("--model-id")
    ap.add_argument("--version")
    ap.add_argument("--model-url")
    ap.add_argument("--movement-ids", type=Path, help="Explicit reviewed source-label to pack-id mapping JSON")
    ap.add_argument("--class-names", type=Path, help="Exact class id to original capture display name JSON")
    ap.add_argument("--quantize", action="store_true")
    ap.add_argument("--classes", nargs="+", default=["movement_a", "movement_b", "UNKNOWN"])
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args()
    if a.run_record:
        result = export_run(a.run_record, a.out or a.run_record.with_suffix(".onnx"), checkpoint=a.checkpoint,
                            calibration=a.calibration, evaluation=a.evaluation, sport_id=a.sport_id,
                            model_id=a.model_id, version=a.version, model_url=a.model_url,
                            movement_ids=a.movement_ids, class_names=a.class_names, quantize=a.quantize)
    else:
        if a.checkpoint:
            ap.error("--checkpoint requires --run-record so the exact trained architecture is restored")
        m = build_model(a.model, a.classes, a.landmark_set)
        result = export(m, a.out or Path(f"ml/runs/{a.model}.onnx"), quantize=a.quantize)
    print(json.dumps(result, indent=2))
