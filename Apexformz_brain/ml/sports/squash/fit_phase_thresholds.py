"""Fit provisional squash phase thresholds from explicit training annotations.

Use --features deployed-engine feature JSONL, --labels reviewed/labels.jsonl,
--split reviewed/splits.json and --out proposals. Flat labels contain execution_id,
source_execution_id (optional), stream_id, movement_id, start_ms, end_ms and
phases[{phase_id,start_ms,end_ms}]. Nested manifest annotations with labels.phases
are also accepted. --manifest resolves source bounds, streams and split lineage;
a full --labels manifest supplies those itself. Explicit splits are mandatory.

Only train executions contribute, equally weighted regardless of frame count.
At least three annotated executions with positive and preceding-phase negative
observations are required. Capture labels never imply phases. Proposals remain
unvalidated and never modify the sport pack.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import pathlib
from typing import Optional
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
PACK = ROOT / "sport-packs" / "squash"
OPS = {"lt", "lte", "gt", "gte", "abs_lt", "abs_gt", "abs_lte", "abs_gte"}


def load_document(path: pathlib.Path):
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        return []
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return [json.loads(line) for line in text.splitlines() if line.strip()]


def finite_number(value, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value):
        raise ValueError(f"{field} must be a finite number")
    return float(value)


def compare(values: np.ndarray, threshold: float, op: str) -> np.ndarray:
    if op not in OPS:
        raise ValueError(f"unsupported threshold operator: {op}")
    if op.startswith("abs_"):
        values, op = np.abs(values), op[4:]
    return {"lt": np.less, "lte": np.less_equal, "gt": np.greater, "gte": np.greater_equal}[op](values, threshold)


def best_threshold(pos: np.ndarray, neg: np.ndarray, op: str, *, positive_groups=None,
                   negative_groups=None, min_samples: int = 10) -> tuple[Optional[float], Optional[float]]:
    """Exact runtime comparisons; balanced accuracy averages each execution equally."""
    if op not in OPS:
        raise ValueError(f"unsupported threshold operator: {op}")
    pos, neg = np.asarray(pos, dtype=float), np.asarray(neg, dtype=float)
    if not np.isfinite(pos).all() or not np.isfinite(neg).all():
        raise ValueError("feature values must be finite")
    if len(pos) < min_samples or len(neg) < min_samples:
        return None, None
    pg = np.asarray(positive_groups if positive_groups is not None else ["all"] * len(pos))
    ng = np.asarray(negative_groups if negative_groups is not None else ["all"] * len(neg))
    if pg.shape != pos.shape or ng.shape != neg.shape:
        raise ValueError("each feature sample requires exactly one execution group")
    values = np.unique(np.concatenate([np.abs(pos), np.abs(neg)] if op.startswith("abs_") else [pos, neg]))
    candidates = np.unique(np.concatenate([values, values[:-1] / 2 + values[1:] / 2,
                                           [np.nextafter(values[0], -np.inf), np.nextafter(values[-1], np.inf)]]))
    best, best_t = -1.0, None
    for threshold in candidates[np.isfinite(candidates)]:
        pp, nn = compare(pos, threshold, op), ~compare(neg, threshold, op)
        tpr = np.mean([pp[pg == group].mean() for group in np.unique(pg)])
        tnr = np.mean([nn[ng == group].mean() for group in np.unique(ng)])
        score = float((tpr + tnr) / 2)
        if score > best:
            best, best_t = score, float(threshold)
    return best_t, best


def resolve_assignments(split_document, manifest: Optional[dict], label_document) -> dict:
    source = split_document
    if source is None and manifest is not None:
        source = manifest.get("splits")
    if source is None and isinstance(label_document, dict):
        source = label_document.get("splits")
    assignments = source.get("assignments") if isinstance(source, dict) else None
    if not isinstance(assignments, dict) or not assignments:
        raise ValueError("explicit train/val/test split assignments required; provide --split or a manifest with splits.assignments")
    if any(value not in {"train", "val", "test"} for value in assignments.values()):
        raise ValueError("split assignments must be train, val or test")
    return assignments


def normalize_labels(document, graphs: list[dict], assignments: dict, manifest: Optional[dict] = None):
    if isinstance(document, dict) and "annotations" in document:
        manifest = manifest or document
        rows = document["annotations"]
    else:
        rows = document if isinstance(document, list) else [document]
    executions = {e["execution_id"]: e for e in (manifest or {}).get("executions", [])}
    graph_map = {g["movement_id"]: g for g in graphs}
    out, skipped, seen, review_needs = [], Counter(), set(), []
    for row in rows:
        labels = row.get("labels", row)
        eid = row.get("execution_id", labels.get("execution_id"))
        if not isinstance(eid, str) or not eid:
            raise ValueError("every annotation requires execution_id")
        if eid not in assignments:
            raise ValueError(f"annotation execution {eid} has no split assignment")
        source_id = row.get("source_execution_id", eid)
        ex = executions.get(source_id, {})
        if manifest is not None:
            if not ex:
                raise ValueError(f"annotation source execution not found in manifest: {source_id}")
            source_split = manifest.get("splits", {}).get("assignments", {}).get(source_id)
            if source_split not in {"train", "val", "test"} or assignments[eid] != source_split:
                raise ValueError(f"annotation split differs from source manifest: {eid}")
        if assignments[eid] != "train":
            skipped["non_train_execution"] += 1
            continue
        phases = labels.get("phases")
        if not phases:
            single_frame = bool(ex.get("static") and ex.get("start_ms") == ex.get("end_ms"))
            skipped["single_frame_no_temporal_support" if single_frame else "no_phase_annotations"] += 1
            review_needs.append({"execution_id": eid, "source_execution_id": source_id,
                                 "movement_id": labels.get("movement_id", ex.get("movement_id")),
                                 "reason": "single photograph cannot establish phase timing; timed holds/background observations required"
                                           if single_frame else "independent phase annotations required"})
            continue
        if not isinstance(phases, list):
            raise ValueError(f"phases must be a list: {eid}")
        if row.get("review_status") != "reviewed":
            raise ValueError(f"phase annotations require review_status reviewed: {eid}")
        if row.get("disagreement") is not None:
            raise ValueError(f"unresolved annotation disagreement: {eid}")
        mid = labels.get("movement_id", ex.get("movement_id"))
        if mid not in graph_map:
            raise ValueError(f"unknown squash movement for phase annotations: {mid}")
        stream = labels.get("stream_id", row.get("stream_id"))
        if stream is None and len(ex.get("view_stream_ids", [])) == 1:
            stream = ex["view_stream_ids"][0]
        if not isinstance(stream, str) or not stream:
            raise ValueError(f"explicit stream_id required for phase annotation: {eid}")
        if ex and stream not in ex.get("view_stream_ids", []):
            raise ValueError(f"annotation stream differs from source execution: {eid}")
        if (eid, stream) in seen:
            raise ValueError(f"duplicate annotation execution/stream; resolve versions before fitting: {eid}")
        seen.add((eid, stream))
        lo = finite_number(labels.get("start_ms", ex.get("start_ms")), f"{eid}.start_ms")
        hi = finite_number(labels.get("end_ms", ex.get("end_ms")), f"{eid}.end_ms")
        if lo < 0 or hi <= lo:
            raise ValueError(f"annotation boundaries must satisfy 0 <= start < end: {eid}")
        if ex and (lo < ex["start_ms"] or hi > ex["end_ms"]):
            raise ValueError(f"annotation boundaries exceed source capture: {eid}")
        known = {p["id"] for p in graph_map[mid]["phases"]}
        edges = {(edge["from"], edge["to"]) for edge in graph_map[mid].get("edges", [])}
        previous_end, previous_id = lo, None
        for phase in phases:
            pid = phase.get("phase_id")
            if pid not in known:
                raise ValueError(f"unknown phase_id {pid}: {eid}")
            start = finite_number(phase.get("start_ms"), f"{eid}.{pid}.start_ms")
            end = finite_number(phase.get("end_ms"), f"{eid}.{pid}.end_ms")
            if start < previous_end or start < lo or end > hi or end <= start:
                raise ValueError(f"phase boundaries overlap or exceed execution: {eid}/{pid}")
            if previous_id is not None and (previous_id, pid) not in edges:
                raise ValueError(f"annotated transition absent from phase graph: {eid}/{previous_id}->{pid}")
            previous_end, previous_id = end, pid
        out.append({"execution_id": eid, "source_execution_id": source_id, "stream_id": stream,
                    "movement_id": mid, "phases": phases, "review_status": row["review_status"],
                    "source_identity_corrected": bool(ex and mid != ex.get("movement_id"))})
    return out, dict(skipped), review_needs


def fit_proposals(graphs: list[dict], features: list[dict], label_document, assignments: dict,
                  *, manifest: Optional[dict] = None, window_ms: float = 120.0,
                  min_executions: int = 3, min_samples: int = 10) -> dict:
    if not np.isfinite(window_ms) or window_ms <= 0 or min_executions < 3 or min_samples < 1:
        raise ValueError("window_ms must be positive; at least three executions and one sample required")
    # The public helper is subject to the same split validation as the CLI.
    assignments = resolve_assignments({"assignments": assignments}, None, label_document)
    labels, skipped, review_needs = normalize_labels(label_document, graphs, assignments, manifest)
    streams, seen = defaultdict(list), set()
    for row in features:
        stream = row.get("stream_id")
        if not isinstance(stream, str) or not stream:
            raise ValueError("each feature row requires stream_id")
        ts = finite_number(row.get("timestamp_ms"), "feature timestamp_ms")
        if (stream, ts) in seen:
            raise ValueError(f"duplicate feature timestamp for stream {stream}")
        seen.add((stream, ts))
        streams[stream].append(row)

    def values(stream, feature, start, end):
        result = []
        for row in streams.get(stream, []):
            if start <= row["timestamp_ms"] < end and row.get("quality_ok") is not False:
                value = row.get("features", {}).get(feature)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value):
                    result.append(float(value))
        return result

    proposals = []
    for graph in graphs:
        for phase in graph["phases"]:
            for condition in phase["enter"]:
                pos, neg, pg, ng, source_ids = [], [], [], [], set()
                for label in labels:
                    if label["movement_id"] != graph["movement_id"]:
                        continue
                    for index, current in enumerate(label["phases"]):
                        if index == 0 or current["phase_id"] != phase["id"]:
                            continue
                        previous = label["phases"][index - 1]
                        positive = values(label["stream_id"], condition["feature"], current["start_ms"],
                                          min(current["end_ms"], current["start_ms"] + window_ms))
                        negative = values(label["stream_id"], condition["feature"], previous["start_ms"],
                                          max(previous["start_ms"], previous["end_ms"] - window_ms))
                        if not positive or not negative:
                            continue
                        pos.extend(positive); neg.extend(negative)
                        pg.extend([label["execution_id"]] * len(positive)); ng.extend([label["execution_id"]] * len(negative))
                        source_ids.add(label["source_execution_id"])
                count = len(set(pg))
                threshold, score, status = None, None, "insufficient_annotated_executions"
                if condition["op"] not in OPS:
                    status = "unsupported_operator"
                elif not any(edge["to"] == phase["id"] for edge in graph.get("edges", [])):
                    status = "no_incoming_transition_requires_background_negatives"
                elif count >= min_executions:
                    threshold, score = best_threshold(np.asarray(pos), np.asarray(neg), condition["op"],
                                                      positive_groups=pg, negative_groups=ng, min_samples=min_samples)
                    status = "insufficient_data" if threshold is None else "proposal_requires_coach_review"
                    if score is not None and score <= .5:
                        threshold, status = None, "insufficient_separation"
                proposals.append({"graph_id": graph["id"], "movement_id": graph["movement_id"], "phase_id": phase["id"],
                                  "feature": condition["feature"], "op": condition["op"], "current_value": condition["value"],
                                  "proposed_value": threshold, "balanced_accuracy": score, "score_split": "train",
                                  "score_weighting": "equal_execution", "n_positive": len(pos), "n_negative": len(neg),
                                  "n_executions": count, "n_source_executions": len(source_ids), "status": status})
    return {"schema_version": "1.0.0", "sport_pack_id": "squash", "production_eligible": False,
            "note": "Training-fit proposals only; independent boundary evaluation and coach review are still required.",
            "split_policy": "explicit_train_only", "minimum_executions": min_executions, "window_ms": window_ms,
            "annotation_executions": len({label["execution_id"] for label in labels}),
            "annotation_review_status": dict(Counter(label["review_status"] for label in labels)),
            "source_identity_corrections": sum(label["source_identity_corrected"] for label in labels),
            "skipped_annotations": skipped, "review_needs": review_needs,
            "fitted_conditions": sum(p["proposed_value"] is not None for p in proposals),
            "condition_status_counts": dict(Counter(p["status"] for p in proposals)), "proposals": proposals}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--features", type=pathlib.Path, required=True)
    ap.add_argument("--labels", type=pathlib.Path, required=True)
    ap.add_argument("--split", type=pathlib.Path, help="explicit assignments JSON; only train executions contribute")
    ap.add_argument("--manifest", type=pathlib.Path, help="optional prepared manifest for source bounds and split lineage")
    ap.add_argument("--out", type=pathlib.Path, default=ROOT / "ml/sports/squash/proposals")
    ap.add_argument("--window-ms", type=float, default=120.0)
    args = ap.parse_args()
    graph_path = PACK / "phase_graphs.json"
    graphs = json.loads(graph_path.read_text(encoding="utf-8"))["graphs"]
    labels = load_document(args.labels)
    manifest = load_document(args.manifest) if args.manifest else None
    split = load_document(args.split) if args.split else None
    assignments = resolve_assignments(split, manifest, labels)
    features = load_document(args.features)
    if isinstance(features, dict):
        features = [features]
    report = fit_proposals(graphs, features, labels, assignments, manifest=manifest, window_ms=args.window_ms)
    report["source_hashes"] = {name: hashlib.sha256(path.read_bytes()).hexdigest()
                               for name, path in {"features": args.features, "labels": args.labels, "split": args.split,
                                                  "manifest": args.manifest, "phase_graphs": graph_path}.items() if path}
    args.out.mkdir(parents=True, exist_ok=True)
    output = args.out / "phase_thresholds.proposal.json"
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    fitted = sum(p["proposed_value"] is not None for p in report["proposals"])
    print(f"{fitted}/{len(report['proposals'])} training-fit proposals -> {output}")


if __name__ == "__main__":
    main()

