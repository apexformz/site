"""Assemble ensemble lineage from verified member training records, without claiming validation."""
from __future__ import annotations

import re


def ensemble_lineage(records: list[dict]) -> dict:
    if len(records) < 2 or any(r.get("dry_run") for r in records):
        raise ValueError("ensemble lineage requires at least two real training records")
    datasets = {r.get("dataset_manifest_sha256") for r in records}
    splits = {r.get("split_manifest_sha256") for r in records}
    if len(datasets) != 1 or not re.fullmatch(r"[a-f0-9]{64}", next(iter(datasets)) or ""):
        raise ValueError("ensemble members must have the same recorded dataset SHA-256")
    if len(splits) != 1:
        raise ValueError("ensemble members must have the same recorded split manifest")
    split_hash = next(iter(splits))
    if split_hash is not None and not re.fullmatch(r"[a-f0-9]{64}", split_hash):
        raise ValueError("invalid split manifest SHA-256")
    split_evidence = [r.get("dataset", {}).get("split_evidence", {}) for r in records]
    if any(s != split_evidence[0] for s in split_evidence[1:]):
        raise ValueError("ensemble members disagree on split evidence")
    return {
        "dataset_hash": next(iter(datasets)),
        "split_manifest_hash": split_hash,
        "split_manifest_status": "recorded" if split_hash else "no separate split manifest; assignments embedded in dataset manifest",
        "athlete_disjoint": split_evidence[0].get("athlete_disjoint"),
        "split_evidence": split_evidence[0],
        "member_training_records": [
            {"run_id": r["run_id"], "checkpoint_sha256": r.get("checkpoint_sha256"),
             "dataset_manifest_sha256": r["dataset_manifest_sha256"], "split_manifest_sha256": r.get("split_manifest_sha256")}
            for r in records
        ],
    }
