"""Self-supervised skeleton pretraining (SimCLR-style NT-Xent on two augmented views).

Sport-agnostic representation learning from unlabelled captures (TRD 12 pipeline
step before any sport labels exist). The encoder is either ST-GCN++ or the causal
TCN; a small projection head is discarded after pretraining and the encoder
weights are saved for fine-tuning with training/train.py.

`--dry-run` runs two steps on synthetic sequences.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from training.augment import apply_pipeline  # noqa: E402
from datasets.jsonl_dataset import PoseJsonlDataset, split_evidence  # noqa: E402
from training.train import TrainConfig, encoder_architecture, file_sha256, git_commit, input_contract, make_model  # noqa: E402


class ProjectionHead(nn.Module):
    def __init__(self, cin: int, dim: int = 128):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(cin, cin), nn.ReLU(inplace=True), nn.Linear(cin, dim))

    def forward(self, z: torch.Tensor) -> torch.Tensor:
        return F.normalize(self.net(z), dim=-1)



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

def nt_xent(z1: torch.Tensor, z2: torch.Tensor, temperature: float = 0.1) -> torch.Tensor:
    """Normalised temperature-scaled cross entropy over 2B embeddings (SimCLR)."""
    B = z1.shape[0]
    if B < 2 or z1.shape != z2.shape or not np.isfinite(temperature) or temperature <= 0:
        raise ValueError("NT-Xent requires matching views, at least two samples and positive temperature")
    z = torch.cat([z1, z2], dim=0)
    sim = z @ z.t() / temperature
    sim.fill_diagonal_(-1e9)
    targets = torch.cat([torch.arange(B, 2 * B), torch.arange(0, B)]).to(z.device)
    return F.cross_entropy(sim, targets)


def embed(model: nn.Module, x: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    if hasattr(model, "embed"):
        return model.embed(x, mask)
    # TCN: pool the last block's features over time
    B, T, _ = x.shape
    V = model.num_landmarks
    m = mask.view(B, T, V, 1)
    xm = (x.view(B, T, V, 3) * m).view(B, T, -1)
    feats = torch.cat([xm, mask], dim=-1).transpose(1, 2)
    return model.blocks(feats).mean(dim=2)


def two_views(x: np.ndarray, mask: np.ndarray, rng: np.random.Generator, cfg: dict):
    a = [apply_pipeline(x[i], mask[i], "right", rng, cfg)[:2] for i in range(x.shape[0])]
    b = [apply_pipeline(x[i], mask[i], "right", rng, cfg)[:2] for i in range(x.shape[0])]
    xa = np.stack([v[0] for v in a]).astype(np.float32)
    ma = np.stack([v[1] for v in a]).astype(np.float32)
    xb = np.stack([v[0] for v in b]).astype(np.float32)
    mb = np.stack([v[1] for v in b]).astype(np.float32)
    return xa, ma, xb, mb


def make_pretraining_dataset(cfg: TrainConfig):
    """Use only explicitly assigned training captures; labels never enter the objective.

    Reject stream/athlete/session leakage even when supervised development experiments
    allow it. Reading a legacy manifest must not silently train on every sequence.
    """
    if not cfg.dataset_manifest:
        raise ValueError("dataset_manifest is required for real-data pretraining")
    manifest = json.loads(Path(cfg.dataset_manifest).read_text(encoding="utf-8"))
    assignments = (json.loads(Path(cfg.split_manifest).read_text(encoding="utf-8"))["assignments"]
                   if cfg.split_manifest else manifest.get("splits", {}).get("assignments"))
    if not assignments:
        raise ValueError("pretraining requires explicit train/val/test split assignments")
    entries = manifest.get("executions", manifest.get("sequences", []))
    normalized = [{**e, "execution_id": e.get("execution_id", e.get("sequence_id"))} for e in entries]
    if any(assignments.get(e["execution_id"]) not in ("train", "val", "test") for e in normalized):
        raise ValueError("every pretraining execution requires a valid split assignment")
    evidence = split_evidence({"executions": normalized}, assignments)
    if evidence["problems"]:
        raise ValueError("split leakage: " + "; ".join(evidence["problems"]))
    # Different stream ids may still alias the same pose file. Never use a held-out
    # recording for self-supervision, even if only its training interval is selected.
    root = Path(cfg.dataset_manifest).parent
    streams = {s["view_stream_id"]: s for s in manifest.get("view_streams", [])}
    path_splits = {}
    for e in normalized:
        sources = [streams[sid] for sid in e["view_stream_ids"]] if "view_stream_ids" in e else [e]
        for source in sources:
            path = (root / (source.get("pose_path") or source["path"])).resolve()
            path_splits.setdefault(path, set()).add(assignments[e["execution_id"]])
    if any(len(parts) > 1 for parts in path_splits.values()):
        raise ValueError("split leakage: pose file appears in multiple partitions")
    ds = PoseJsonlDataset.from_manifest(cfg.dataset_manifest, None, ["UNKNOWN"], ignore_labels=True,
        split_manifest=cfg.split_manifest, split="train", window_frames=cfg.window_frames,
        stride=cfg.stride, hz=cfg.hz, max_hold_ms=cfg.max_hold_ms, min_visibility=cfg.min_visibility,
        min_observed_fraction=cfg.min_observed_fraction, frame_gate=cfg.frame_gate,
        subject_continuity=cfg.subject_continuity, normalization=cfg.normalization, landmark_set=cfg.landmark_set)
    if len(ds) < 2:
        raise ValueError("pretraining requires at least two usable training windows")
    info = {"windows": len(ds), "labels_used": False, "split": "train", "split_evidence": evidence,
            "sequence_ids": sorted({it[3] for it in ds.items}), "rejected_windows": ds.rejected_windows,
            "skipped_empty": ds.skipped_empty,
            "pose_sources": [{"path": str(p), "sha256": file_sha256(str(p))}
                             for p, parts in sorted(path_splits.items()) if parts == {"train"}]}
    return ds, info


def pretrain(model_name: str, landmark_set: str, steps: int, batch_size: int, window: int, out_dir: Path,
             seed: int = 20261025, dry_run: bool = False, config: TrainConfig | None = None) -> dict:
    cfg = dataclasses.replace(config) if config else TrainConfig()
    cfg.model, cfg.landmark_set, cfg.steps, cfg.batch_size, cfg.window_frames, cfg.seed = model_name, landmark_set, steps, batch_size, window, seed
    cfg.out_dir = str(out_dir)
    if steps < 1 or batch_size < 2 or window < 1:
        raise ValueError("steps/window must be positive and contrastive batch_size must be at least two")
    if cfg.pretrained_encoder_record:
        raise ValueError("pretraining starts from a seeded encoder; pretrained_encoder_record is for fine-tuning")
    ds, dataset_info = (None, None) if dry_run else make_pretraining_dataset(cfg)
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    device = select_device()
    cfg.classes = ["placeholder", "UNKNOWN"]
    encoder = make_model(cfg).to(device)
    V = cfg.num_landmarks
    feat_dim = getattr(encoder, "out_channels", None) or encoder.blocks[-1].c2.conv.out_channels
    head = ProjectionHead(feat_dim).to(device)
    opt = torch.optim.AdamW(list(encoder.parameters()) + list(head.parameters()), lr=cfg.lr, weight_decay=cfg.weight_decay)
    # Keep handedness semantics intact by default; callers may explicitly opt into
    # mirror invariance for unlabeled representation learning.
    aug = {**(cfg.augment_cfg if cfg.augment else {"jitter_sigma": 0, "occlusion_p": 0, "mirror": False}),
           "resample": False, "landmark_set": landmark_set}
    steps = 2 if dry_run else steps
    t0 = time.time()
    losses = []
    for step in range(steps):
        if ds is None:
            x = rng.normal(0, 0.1, size=(batch_size, window, V * 3)).astype(np.float32)
            mask = np.ones((batch_size, window, V), dtype=np.float32)
        else:
            # No duplicate window in a batch and no singleton last batch. Sampling
            # without replacement inside each batch is deterministic for this seed.
            ids = rng.choice(len(ds), size=min(batch_size, len(ds)), replace=False)
            x = np.stack([ds.items[i][0] for i in ids])
            mask = np.stack([ds.items[i][1] for i in ids])
        xa, ma, xb, mb = two_views(x, mask, rng, aug)
        za = head(embed(encoder, torch.tensor(xa).to(device), torch.tensor(ma).to(device)))
        zb = head(embed(encoder, torch.tensor(xb).to(device), torch.tensor(mb).to(device)))
        loss = nt_xent(za, zb)
        if not torch.isfinite(loss):
            raise ValueError(f"non-finite contrastive loss at step {step}")
        opt.zero_grad()
        loss.backward()
        opt.step()
        losses.append(float(loss.detach()))
    out_dir.mkdir(parents=True, exist_ok=True)
    rec = {"schema_version": "1.0.0", "run_id": f"pretrain-{model_name}-{time.time_ns()}", "dry_run": dry_run, "model": model_name, "landmark_set": landmark_set, "steps": steps,
           "final_loss": losses[-1], "duration_s": time.time() - t0, "objective": "nt_xent", "augmentation": aug,
           "optimizer": {"type": "AdamW", "lr": cfg.lr, "weight_decay": cfg.weight_decay},
           "contrastive": {"temperature": 0.1, "projection_dim": 128, "requested_batch_size": batch_size,
                           "effective_batch_size": batch_size if ds is None else min(batch_size, len(ds))},
           "loss_history": losses, "seed": seed, "config": dataclasses.asdict(cfg), "input": input_contract(cfg),
           "architecture": encoder_architecture(cfg), "dataset": dataset_info,
           "dataset_manifest_sha256": file_sha256(cfg.dataset_manifest), "split_manifest_sha256": file_sha256(cfg.split_manifest),
           "hardware": {"device": str(device), "torch": str(torch.__version__), "platform": platform.platform()},
           "code_commit": git_commit(), "data_source": "synthetic_smoke" if dry_run else "manifest_train_partition",
           "source_sha256": {str(p.relative_to(Path(__file__).resolve().parents[1])): file_sha256(str(p))
                             for p in [Path(__file__).resolve(), Path(__file__).with_name("train.py"),
                                       Path(__file__).with_name("augment.py"), Path(__file__).with_name("tcn.py"),
                                       Path(__file__).with_name("stgcn.py"), Path(__file__).with_name("graph.py"),
                                       Path(__file__).resolve().parents[1] / "datasets" / "jsonl_dataset.py",
                                       Path(__file__).resolve().parents[1] / "datasets" / "split.py"]},
           "release_gate": "not_eligible: representation pretraining is not a movement classifier or validation result",
           "encoder_params": sum(p.numel() for p in encoder.parameters()), "note": "encoder weights are a starting point for train.py; never a release artifact on their own"}
    if not dry_run:
        ckpt = out_dir / f"{rec['run_id']}.encoder.pt"
        torch.save({k: v.cpu() for k, v in encoder.state_dict().items() if not k.startswith("head.")}, ckpt)
        rec["checkpoint"], rec["checkpoint_sha256"] = ckpt.name, file_sha256(str(ckpt))
    rec["record_path"] = str((out_dir / f"{rec['run_id']}.json").resolve())
    Path(rec["record_path"]).write_text(json.dumps(rec, indent=2), encoding="utf-8")
    return rec


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=Path, help="TrainConfig JSON: same data/split, architecture and input contract as fine-tuning")
    ap.add_argument("--model", choices=["tcn", "stgcnpp"])
    ap.add_argument("--landmark-set")
    ap.add_argument("--steps", type=int)
    ap.add_argument("--batch-size", type=int)
    ap.add_argument("--window", type=int)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--dataset-manifest")
    ap.add_argument("--split-manifest")
    ap.add_argument("--out-dir", type=Path, default=Path("ml/runs"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    cfg = TrainConfig(**json.loads(a.config.read_text(encoding="utf-8"))) if a.config else TrainConfig(model="stgcnpp", steps=5000, batch_size=32)
    if a.dataset_manifest:
        cfg.dataset_manifest = a.dataset_manifest
    if a.split_manifest:
        cfg.split_manifest = a.split_manifest
    r = pretrain(a.model or cfg.model, a.landmark_set or cfg.landmark_set, a.steps if a.steps is not None else cfg.steps,
                 a.batch_size if a.batch_size is not None else cfg.batch_size, a.window if a.window is not None else cfg.window_frames,
                 a.out_dir, seed=a.seed if a.seed is not None else cfg.seed, dry_run=a.dry_run, config=cfg)
    print(json.dumps({"run_id": r["run_id"], "final_loss": r["final_loss"], "steps": r["steps"]}))
