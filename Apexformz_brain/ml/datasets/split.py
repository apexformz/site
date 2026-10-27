"""Athlete-disjoint, execution-grouped dataset splits (TRD 12 hard requirement).

Rules:
  * test/val/train athletes are disjoint;
  * every view stream and derived sample of one execution stays in the execution's split;
  * optional location or camera holdouts force those executions into `test`;
  * deterministic for a given seed; writes a split manifest with checksums.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional


def _hash_manifest(manifest: dict) -> str:
    return hashlib.sha256(json.dumps(manifest, sort_keys=True).encode("utf-8")).hexdigest()


def make_splits(
    executions: List[dict],
    seed: int,
    fractions=(0.7, 0.15, 0.15),
    location_holdouts: Optional[Iterable[str]] = None,
    camera_holdouts: Optional[Iterable[str]] = None,
    sessions: Optional[List[dict]] = None,
    view_streams: Optional[List[dict]] = None,
) -> Dict[str, str]:
    """Return execution_id -> split ("train" | "val" | "test")."""
    assert abs(sum(fractions) - 1) < 1e-9, "fractions must sum to 1"
    loc_hold = set(location_holdouts or [])
    cam_hold = set(camera_holdouts or [])
    session_loc = {s["capture_session_id"]: s.get("location_id") for s in (sessions or [])}
    stream_cam = {v["view_stream_id"]: v["camera_id"] for v in (view_streams or [])}

    # 1. Forced holdouts (whole athlete goes to test so disjointness holds).
    forced_test_athletes = set()
    for ex in executions:
        if session_loc.get(ex["capture_session_id"]) in loc_hold:
            forced_test_athletes.add(ex["athlete_id"])
        if any(stream_cam.get(v) in cam_hold for v in ex.get("view_stream_ids", [])):
            forced_test_athletes.add(ex["athlete_id"])

    # 2. Deterministic athlete-level assignment, balanced by execution counts.
    by_athlete: Dict[str, int] = defaultdict(int)
    for ex in executions:
        by_athlete[ex["athlete_id"]] += 1
    athletes = sorted(a for a in by_athlete if a not in forced_test_athletes)
    rng = random.Random(seed)
    rng.shuffle(athletes)
    total = sum(by_athlete[a] for a in athletes)
    targets = [fractions[0] * total, fractions[1] * total]
    athlete_split: Dict[str, str] = {a: "test" for a in forced_test_athletes}
    acc = 0
    for a in athletes:
        if acc < targets[0]:
            athlete_split[a] = "train"
        elif acc < targets[0] + targets[1]:
            athlete_split[a] = "val"
        else:
            athlete_split[a] = "test"
        acc += by_athlete[a]
    if athletes and not any(v == "test" for v in athlete_split.values()):
        athlete_split[athletes[-1]] = "test"
    return {ex["execution_id"]: athlete_split[ex["athlete_id"]] for ex in executions}


def check_no_leakage(executions: List[dict], assignments: Dict[str, str]) -> List[str]:
    problems = []
    athlete_splits: Dict[str, set] = defaultdict(set)
    stream_splits: Dict[str, set] = defaultdict(set)
    for ex in executions:
        sp = assignments.get(ex["execution_id"])
        if sp is None:
            problems.append(f"execution {ex['execution_id']} unassigned")
            continue
        athlete_splits[ex["athlete_id"]].add(sp)
        for v in ex.get("view_stream_ids", []):
            stream_splits[v].add(sp)
    for a, s in athlete_splits.items():
        if len(s) > 1:
            problems.append(f"athlete {a} appears in {sorted(s)}")
    for v, s in stream_splits.items():
        if len(s) > 1:
            problems.append(f"view stream {v} appears in {sorted(s)}")
    return problems


def write_split_manifest(dataset_manifest_path: Path, out_path: Path, seed: int, **kwargs) -> dict:
    manifest = json.loads(dataset_manifest_path.read_text(encoding="utf-8"))
    assignments = make_splits(manifest["executions"], seed, sessions=manifest.get("capture_sessions"), view_streams=manifest.get("view_streams"), **kwargs)
    problems = check_no_leakage(manifest["executions"], assignments)
    if problems:
        raise SystemExit("leakage detected: " + "; ".join(problems))
    out = {
        "dataset_version": manifest["dataset_version"],
        "dataset_manifest_sha256": _hash_manifest(manifest),
        "seed": seed,
        "assignments": assignments,
        "counts": {s: sum(1 for v in assignments.values() if v == s) for s in ("train", "val", "test")},
        "holdouts": {"locations": list(kwargs.get("location_holdouts") or []), "cameras": list(kwargs.get("camera_holdouts") or [])},
    }
    out_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Create an athlete-disjoint split manifest")
    ap.add_argument("manifest", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--seed", type=int, default=20261025)
    ap.add_argument("--holdout-location", action="append", default=[])
    ap.add_argument("--holdout-camera", action="append", default=[])
    a = ap.parse_args()
    res = write_split_manifest(a.manifest, a.out, a.seed, location_holdouts=a.holdout_location, camera_holdouts=a.holdout_camera)
    print(json.dumps(res["counts"]))
