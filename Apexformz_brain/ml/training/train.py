"""Train Brain movement recognizers on labelled, split PoseFrame captures.

Models share one data pipeline, one augmentation policy and one experiment record:
    --model tcn       causal temporal convolution baseline (training/tcn.py)
    --model stgcnpp   ST-GCN++ challenger (training/stgcn.py), causal by default
Every run writes an experiment record (dataset hash, architecture, optimizer, seed,
hardware, code commit, evaluator version). `--dry-run` trains two steps on synthetic
data so the pipeline is exercised in CI without any athlete data.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import platform
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Tuple, List, Optional

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training.augment import apply_pipeline  # noqa: E402
from training.graph import num_nodes  # noqa: E402
from training.stgcn import build_model  # noqa: E402

EVALUATOR_VERSION = "1.1.0"


@dataclass
class TrainConfig:
    model: str = "tcn"  # tcn | stgcnpp
    model_task: str = "dynamic_movement"  # static_pose | dynamic_movement
    classes: List[str] = field(default_factory=lambda: ["movement_a", "movement_b", "UNKNOWN"])
    excluded_classes: List[str] = field(default_factory=list)
    class_coverage: Optional[dict] = None
    landmark_set: str = "mediapipe_pose_33"
    num_landmarks: int = 33  # derived from landmark_set when they disagree
    channels: List[int] = field(default_factory=lambda: [64, 64, 128])  # tcn only
    kernel: int = 3  # tcn only
    base_channels: int = 64  # stgcnpp only
    causal: bool = True
    dropout: float = 0.1
    lr: float = 1e-3
    weight_decay: float = 1e-4
    batch_size: int = 16
    steps: int = 1000
    seed: int = 20261025
    window_frames: int = 45
    stride: int = 15
    hz: float = 15.0
    max_hold_ms: float = 100.0
    min_visibility: float = 0.5
    min_observed_fraction: float = 0.6
    frame_gate: str = "strict"  # strict | identity_only (must match the browser detector; exported in the input contract)
    subject_continuity: str = "tracker"  # tracker | tracker_root_v1 | geometric (legacy research; never live-compatible)
    normalization: str = "body_relative_v1"  # body_relative_v1 (2D image, view-dependent) | world_bodyframe_v1 (3D, camera-yaw invariant)
    canonical_handedness: Optional[str] = None  # racket hand of every training athlete (left|right) when known and uniform
    # Hierarchy-aware loss: class index -> group / family index (-1 = not in the taxonomy, e.g. UNKNOWN).
    # loss = CE(movement) + hierarchy_loss_weight * (NLL(group) + NLL(family)), with group/family log-probabilities
    # obtained by log-sum-exp over member classes, i.e. exactly how the engine aggregates at inference.
    hierarchy_loss_weight: float = 0.0
    class_groups: Optional[List[int]] = None
    class_families: Optional[List[int]] = None
    # Speed augmentation inside a fixed window: (min, max) playback factor; None disables. Dynamic windows only.
    speed_range: Optional[List[float]] = None
    # Physically grounded simulation (training/simulate.py) for world_bodyframe_v1 inputs; None disables.
    # e.g. {"bone_scale": 0.12, "asymmetry": 0.03, "tilt_deg": 8, "depth_noise": 0.03, "p": 0.8}
    simulate: Optional[dict] = None
    label_smoothing: float = 0.0
    label_coverage: float = 0.6
    augment: bool = True
    augment_cfg: dict = field(default_factory=lambda: {"jitter_sigma": 0.01, "occlusion_p": 0.1, "resample": False, "mirror": False})
    mirror_label_invariant: bool = False
    allow_development_split: bool = False
    dataset_manifest: Optional[str] = None
    split_manifest: Optional[str] = None
    labels_file: Optional[str] = None
    # Self-supervised record, with a checksum-pinned encoder checkpoint. Never loads its classification head.
    pretrained_encoder_record: Optional[str] = None
    out_dir: str = "ml/runs"



def select_device() -> "torch.device":
    """Device policy: APEXFORMZ_DEVICE=cpu|cuda|auto (default auto). CPU is forced without touching CUDA at all,
    so smoke tests stay independent of other GPU residents."""
    import os as _os
    pref = _os.environ.get("APEXFORMZ_DEVICE", "auto").lower()
    if pref == "cpu":
        return torch.device("cpu")
    if pref == "cuda":
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")

def git_commit() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def file_sha256(path: Optional[str]) -> Optional[str]:
    if not path or not Path(path).exists():
        return None
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def class_balanced_weights(labels: np.ndarray, n_classes: int) -> torch.Tensor:
    counts = np.bincount(labels, minlength=n_classes).astype(float)
    counts[counts == 0] = 1
    w = counts.sum() / (n_classes * counts)
    return torch.tensor(w, dtype=torch.float32)


def make_model(cfg: TrainConfig) -> torch.nn.Module:
    V = num_nodes(cfg.landmark_set)
    cfg.num_landmarks = V
    if cfg.model == "tcn":
        if not cfg.causal:
            raise ValueError("TCN is causal; causal=false is only supported by ST-GCN++")
        model = build_model("tcn", cfg.classes, cfg.landmark_set, channels=tuple(cfg.channels), kernel=cfg.kernel, dropout=cfg.dropout)
    elif cfg.model == "stgcnpp":
        model = build_model("stgcnpp", cfg.classes, cfg.landmark_set, causal=cfg.causal, base_channels=cfg.base_channels, dropout=cfg.dropout)
    else:
        raise ValueError(f"unknown model {cfg.model}")
    model.landmark_set = cfg.landmark_set
    model.causal = cfg.causal
    return model


def input_contract(cfg: TrainConfig) -> dict:
    return {"landmark_set": cfg.landmark_set, "window_frames": cfg.window_frames, "hz": cfg.hz,
            "max_hold_ms": cfg.max_hold_ms, "min_visibility": cfg.min_visibility,
            "min_observed_fraction": cfg.min_observed_fraction, "frame_gate": cfg.frame_gate,
            "subject_continuity": cfg.subject_continuity,
            **({"canonical_handedness": cfg.canonical_handedness} if cfg.canonical_handedness in ("left", "right") else {}),
            "normalization": cfg.normalization, "smoothing": "none"}


def encoder_architecture(cfg: TrainConfig) -> dict:
    """Architecture fields that determine encoder tensors, independent of movement classes."""
    return {"model": cfg.model, "landmark_set": cfg.landmark_set, "causal": cfg.causal,
            **({"channels": list(cfg.channels), "kernel": cfg.kernel} if cfg.model == "tcn"
               else {"base_channels": cfg.base_channels})}


def load_pretrained_encoder(model: torch.nn.Module, cfg: TrainConfig) -> Optional[dict]:
    """Fail closed on stale data, split changes, incompatible inputs or checkpoint corruption.

    Fine-tuning currently requires the same manifest/split as pretraining. A separate
    unlabeled corpus needs an explicit overlap audit before this policy can be widened.
    """
    if not cfg.pretrained_encoder_record:
        return None
    path = Path(cfg.pretrained_encoder_record)
    record = json.loads(path.read_text(encoding="utf-8"))
    if record.get("schema_version") != "1.0.0" or record.get("objective") != "nt_xent" or record.get("dry_run") is not False:
        raise ValueError("pretrained encoder requires a real-data contrastive record")
    if record.get("architecture") != encoder_architecture(cfg) or record.get("input") != input_contract(cfg):
        raise ValueError("pretrained encoder architecture or input contract is incompatible")
    if not cfg.dataset_manifest or record.get("dataset_manifest_sha256") != file_sha256(cfg.dataset_manifest):
        raise ValueError("pretrained encoder dataset manifest differs from fine-tuning")
    if record.get("split_manifest_sha256") != file_sha256(cfg.split_manifest):
        raise ValueError("pretrained encoder split manifest differs from fine-tuning")
    for source in record.get("dataset", {}).get("pose_sources", []):
        if file_sha256(source["path"]) != source["sha256"]:
            raise ValueError("pretrained encoder pose source checksum mismatch")
    if not record.get("dataset", {}).get("pose_sources"):
        raise ValueError("pretrained encoder lacks pose source provenance")
    ckpt = path.parent / record["checkpoint"]
    if not record.get("checkpoint_sha256") or file_sha256(str(ckpt)) != record["checkpoint_sha256"]:
        raise ValueError("pretrained encoder checkpoint checksum mismatch")
    state = torch.load(ckpt, map_location="cpu", weights_only=True)
    expected = {k: v for k, v in model.state_dict().items() if not k.startswith("head.")}
    if state.keys() != expected.keys() or any(state[k].shape != expected[k].shape for k in expected):
        raise ValueError("pretrained encoder tensor shapes are incompatible")
    model.load_state_dict({**model.state_dict(), **state})
    return {"record_path": str(path.resolve()), "record_sha256": file_sha256(str(path)),
            "run_id": record["run_id"], "checkpoint_sha256": record["checkpoint_sha256"],
            "loaded_tensors": len(state), "classification_head": "fresh_initialization"}


def make_dataset(cfg: TrainConfig, split: str):
    from datasets.jsonl_dataset import PoseJsonlDataset

    if not cfg.dataset_manifest:
        raise ValueError("dataset_manifest is required")
    return PoseJsonlDataset.from_manifest(cfg.dataset_manifest, cfg.labels_file, cfg.classes,
        window_frames=cfg.window_frames, stride=cfg.stride, hz=cfg.hz,
        max_hold_ms=cfg.max_hold_ms, min_visibility=cfg.min_visibility, label_coverage=cfg.label_coverage,
        min_observed_fraction=cfg.min_observed_fraction, frame_gate=cfg.frame_gate, subject_continuity=cfg.subject_continuity, normalization=cfg.normalization,
        landmark_set=cfg.landmark_set, split_manifest=cfg.split_manifest, split=split,
        excluded_classes=cfg.excluded_classes,
        allow_development_split=cfg.allow_development_split)


def load_run(run_record: str | Path, checkpoint: str | Path | None = None):
    """Restore the exact trained architecture, never a guessed default architecture."""
    path = Path(run_record)
    record = json.loads(path.read_text(encoding="utf-8"))
    cfg = TrainConfig(**record["config"])
    ckpt = Path(checkpoint) if checkpoint else Path(record.get("checkpoint") or path.with_suffix(".pt"))
    if not ckpt.is_absolute() and not ckpt.exists():
        ckpt = path.parent / ckpt
    if not ckpt.exists():
        raise ValueError(f"checkpoint missing: {ckpt}")
    expected = record.get("checkpoint_sha256")
    if expected and file_sha256(str(ckpt)) != expected:
        raise ValueError("checkpoint checksum does not match run record")
    model = make_model(cfg)
    model.load_state_dict(torch.load(ckpt, map_location="cpu", weights_only=True))
    return model.eval(), cfg, record


def speed_warp(x: np.ndarray, mask: np.ndarray, factor: float) -> Tuple[np.ndarray, np.ndarray]:
    """Play a [T, C] window `factor` times faster (>1) or slower (<1), keep length T and the causal right edge.
    Sampling is nearest-frame on the original grid; frames before the start are masked (left padding)."""
    T = x.shape[0]
    src = (T - 1) - (np.arange(T)[::-1] * factor)
    idx = np.round(src).astype(int)
    ok = idx >= 0
    xo = np.zeros_like(x)
    mo = np.zeros_like(mask)
    xo[ok] = x[idx[ok]]
    mo[ok] = mask[idx[ok]]
    return xo, mo


def augment_batch(x: np.ndarray, mask: np.ndarray, cfg: TrainConfig, rng: np.random.Generator):
    """Shared augmentation for every model; mirroring keeps a fixed window length (no resampling here)."""
    if not cfg.augment:
        return x, mask
    if cfg.simulate:
        if cfg.normalization != "world_bodyframe_v1":
            raise ValueError("simulation requires world_bodyframe_v1 inputs (3D body frame)")
        from training.simulate import simulate_window
        prob = float(cfg.simulate.get("p", 0.8))
        for i in range(x.shape[0]):
            if rng.random() < prob:
                x[i], mask[i] = simulate_window(x[i], mask[i], rng, cfg.simulate)
    if cfg.speed_range and x.shape[1] > 1:
        lo, hi = cfg.speed_range
        for i in range(x.shape[0]):
            x[i], mask[i] = speed_warp(x[i], mask[i], float(np.exp(rng.uniform(np.log(lo), np.log(hi)))))
    xs, ms = [], []
    acfg = dict(cfg.augment_cfg)
    acfg["resample"] = False  # fixed-length windows for batched training
    acfg["landmark_set"] = cfg.landmark_set
    for i in range(x.shape[0]):
        xi, mi, _, _ = apply_pipeline(x[i], mask[i], "right", rng, acfg)
        xs.append(xi)
        ms.append(mi)
    return np.stack(xs).astype(np.float32), np.stack(ms).astype(np.float32)


def synthetic_batch(cfg: TrainConfig, rng: np.random.Generator):
    B, T, V = cfg.batch_size, cfg.window_frames, cfg.num_landmarks
    y = rng.integers(0, len(cfg.classes), size=B)
    x = rng.normal(0, 0.1, size=(B, T, V * 3)).astype(np.float32)
    for i in range(B):
        x[i, :, 0] += 0.5 * y[i]  # trivially separable signal
    mask = (rng.random((B, T, V)) > 0.05).astype(np.float32)
    return x, mask, y


def _level_nll(logp: torch.Tensor, y: torch.Tensor, index: torch.Tensor) -> torch.Tensor:
    """NLL of the coarse level: log P(level of y) = logsumexp of member class log-probs. Classes with index -1 are skipped."""
    target = index[y]
    keep = target >= 0
    if not bool(keep.any()):
        return logp.new_zeros(())
    n_levels = int(index.max().item()) + 1
    member = (index.unsqueeze(0) == torch.arange(n_levels, device=logp.device).unsqueeze(1))  # [L, C]
    masked = logp.unsqueeze(1).masked_fill(~member.unsqueeze(0), float("-inf"))  # [B, L, C]
    level_logp = torch.logsumexp(masked, dim=-1)  # [B, L]
    return -level_logp[keep].gather(1, target[keep].unsqueeze(1)).mean()


def hierarchy_nll(logits: torch.Tensor, y: torch.Tensor, class_groups: List[int], class_families: List[int]) -> torch.Tensor:
    logp = F.log_softmax(logits, dim=-1)
    g = torch.tensor(class_groups, device=logits.device)
    f = torch.tensor(class_families, device=logits.device)
    return _level_nll(logp, y, g) + _level_nll(logp, y, f)


def sequence_logits(model: torch.nn.Module, logits: torch.Tensor, causal: bool) -> torch.Tensor:
    return logits[:, -1, :] if causal or getattr(model, "causal", True) else logits.mean(dim=1)


def train(cfg: TrainConfig, dry_run: bool = False) -> dict:
    if cfg.model_task not in ("static_pose", "dynamic_movement"):
        raise ValueError("model_task must be static_pose or dynamic_movement")
    if cfg.model_task == "static_pose" and cfg.window_frames != 1:
        raise ValueError("static_pose requires window_frames=1; do not manufacture temporal observations")
    if cfg.steps < 1 or cfg.batch_size < 1:
        raise ValueError("steps and batch_size must be positive")
    if not dry_run and cfg.augment and cfg.augment_cfg.get("mirror", True) and not cfg.mirror_label_invariant:
        raise ValueError("mirroring requires mirror_label_invariant=true after reviewing the class semantics, or mirror=false")
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    device = select_device()
    model = make_model(cfg).to(device)
    warm_start = load_pretrained_encoder(model, cfg)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    steps = 2 if dry_run else cfg.steps
    loader = None
    dataset_info = None
    weights = None
    if not dry_run:
        ds = make_dataset(cfg, "train")
        if not len(ds):
            raise ValueError("training split contains no usable pose windows")
        missing_classes = [c for c, n in ds.class_counts().items() if c != "UNKNOWN" and n == 0]
        if missing_classes:
            raise ValueError(f"training split has no usable windows for classes: {missing_classes}; fix extraction/splits or explicitly choose the available class list")
        dataset_info = {"windows": len(ds), "class_counts": ds.class_counts(), "split_evidence": ds.split_evidence,
                        "skipped_empty": ds.skipped_empty, "rejected_windows": ds.rejected_windows,
                        "rejected_by_sequence": ds.rejected_by_sequence, "excluded_classes": ds.excluded_classes,
                        "excluded_executions": ds.excluded_executions}
        weights = class_balanced_weights(np.array([it[2] for it in ds.items]), len(cfg.classes)).to(device)
        loader = torch.utils.data.DataLoader(ds, batch_size=cfg.batch_size, shuffle=True, drop_last=False,
                                             generator=torch.Generator().manual_seed(cfg.seed))
        it = iter(loader)
    losses = []
    t0 = time.time()
    tel = None
    if not dry_run:
        try:
            from apexformz_telemetry import Run as _TelemetryRun
            tel = _TelemetryRun(kind="simulation" if cfg.simulate else "training", project="apexformz-brain",
                                label=f"{cfg.model_task}:{cfg.model}", group=str(Path(cfg.out_dir).parent.name), total_steps=steps,
                                meta={"config": dataclasses.asdict(cfg), "windows": dataset_info["windows"] if dataset_info else None,
                                      "classes": len(cfg.classes), "device": str(device)},
                                sensitive=["meta", "label", "group"])
        except Exception:  # noqa: BLE001
            tel = None
    simulated = 0
    for step in range(steps):
        if loader is None:
            x, mask, y = synthetic_batch(cfg, rng)
        else:
            try:
                xb, mb, yb = next(it)
            except StopIteration:
                it = iter(loader)
                xb, mb, yb = next(it)
            x, mask, y = xb.numpy(), mb.numpy(), yb.numpy()
        x, mask = augment_batch(x, mask, cfg, rng)
        xt, mt, yt = torch.tensor(x).to(device), torch.tensor(mask).to(device), torch.tensor(y).long().to(device)
        batch_weights = weights if weights is not None else class_balanced_weights(y, len(cfg.classes)).to(device)
        logits = sequence_logits(model, model(xt, mt), cfg.causal)
        loss = F.cross_entropy(logits, yt, weight=batch_weights, label_smoothing=cfg.label_smoothing)
        if cfg.hierarchy_loss_weight > 0 and cfg.class_groups and cfg.class_families:
            loss = loss + cfg.hierarchy_loss_weight * hierarchy_nll(logits, yt, cfg.class_groups, cfg.class_families)
        if not torch.isfinite(loss):
            raise ValueError(f"non-finite training loss at step {step}")
        opt.zero_grad()
        loss.backward()
        opt.step()
        losses.append(float(loss.detach()))
        if cfg.simulate:
            simulated += int(round(len(y) * float(cfg.simulate.get("p", 0.8))))
        if tel is not None:
            dt = max(time.time() - t0, 1e-6)
            tel.step(step + 1, loss=losses[-1], metrics={"samples_per_s": (step + 1) * cfg.batch_size / dt, "simulated": simulated,
                                                         "lr": opt.param_groups[0]["lr"]}, force=(step + 1 == steps))
    arch = {"type": type(model).__name__, "model": cfg.model, "landmark_set": cfg.landmark_set, "causal": cfg.causal, "params": sum(p.numel() for p in model.parameters())}
    if cfg.model == "tcn":
        arch.update({"channels": cfg.channels, "kernel": cfg.kernel, "receptive_field_frames": getattr(model, "receptive_field", None)})
    else:
        arch.update({"base_channels": cfg.base_channels, "total_stride": getattr(model, "total_stride", None)})
    record = {
        "run_id": f"{cfg.model}-{time.time_ns()}",
        "dry_run": dry_run,
        "config": dataclasses.asdict(cfg),
        "dataset_manifest_sha256": file_sha256(cfg.dataset_manifest),
        "split_manifest_sha256": file_sha256(cfg.split_manifest),
        "labels_sha256": file_sha256(cfg.labels_file),
        "input": input_contract(cfg),
        "dataset": dataset_info,
        "pretrained_encoder": warm_start,
        "architecture": arch,
        "optimizer": {"type": "AdamW", "lr": cfg.lr, "weight_decay": cfg.weight_decay},
        "augmentation": cfg.augment_cfg if cfg.augment else None,
        "seed": cfg.seed,
        "hardware": {"device": str(device), "platform": platform.platform(), "torch": torch.__version__, "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None},
        "code_commit": git_commit(),
        "evaluator_version": EVALUATOR_VERSION,
        "steps": steps,
        "final_loss": losses[-1] if losses else None,
        "initial_loss": losses[0],
        "loss_history": losses,
        "duration_s": time.time() - t0,
        "calibration": {"status": "TODO_REQUIRES_VALIDATION: run ml/evaluation/open_set.py on the held-out val split", "ece": None},
        "release_gate": "not_eligible: dry run / no athlete-disjoint evaluation" if dry_run else "pending_evaluation",
    }
    if tel is not None:
        tel.end("completed", {"final_loss": losses[-1] if losses else None, "initial_loss": losses[0] if losses else None,
                              "steps": steps, "simulated_samples": simulated, "duration_s": time.time() - t0})
    out = Path(cfg.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if not dry_run:
        ckpt = out / f"{record['run_id']}.pt"
        torch.save(model.cpu().state_dict(), ckpt)
        record["checkpoint"] = str(ckpt.resolve())
        record["checkpoint_sha256"] = file_sha256(str(ckpt))
    record["record_path"] = str((out / f"{record['run_id']}.json").resolve())
    Path(record["record_path"]).write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=Path, help="JSON file with TrainConfig fields")
    ap.add_argument("--model", choices=["tcn", "stgcnpp"], default=None)
    ap.add_argument("--landmark-set", choices=["mediapipe_pose_33", "coco_17"], default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--out-dir", default=None)
    a = ap.parse_args()
    cfg = TrainConfig(**json.loads(a.config.read_text())) if a.config else TrainConfig()
    if a.model:
        cfg.model = a.model
    if a.landmark_set:
        cfg.landmark_set = a.landmark_set
    if a.out_dir:
        cfg.out_dir = a.out_dir
    rec = train(cfg, dry_run=a.dry_run)
    print(json.dumps({"run_id": rec["run_id"], "final_loss": rec["final_loss"], "steps": rec["steps"], "params": rec["architecture"]["params"], "duration_s": round(rec["duration_s"], 3)}))
