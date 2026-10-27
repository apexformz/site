"""Fit auditable scalar-rule/variance proposals without changing a sport pack.

The numerical functions intentionally mirror scoring/rules.ts and variance.ts.
Reviewed outcomes are independent targets, never the current engine verdicts.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import itertools
import json
import math
from pathlib import Path
import statistics

SPLITS = {"train", "val", "test"}
CONTEXTS = {"novice", "intermediate", "advanced", "unknown"}
KINDS = {"range", "max_abs", "max_value", "min_value", "ordering", "stability", "phase_duration"}
PIN_KEYS = ("sport_pack_sha256", "rubric_sha256", "runtime_sha256", "pose_pipeline_sha256", "reference_models_sha256")
ALLOWED_REASONS = {None, "RUBRIC_UNVALIDATED", "WITHIN_NORMAL_VARIANCE"}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pack_digest(pack: Path) -> str:
    pins = {p.name: digest(p) for p in sorted(pack.glob("*.json"), key=lambda p: p.name)}
    return hashlib.sha256(json.dumps(pins, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def reference_digest(pack: Path) -> str:
    pins = {p.relative_to(pack).as_posix(): digest(p)
            for p in sorted((pack / "models/reference").glob("*.json"), key=lambda p: p.name)}
    return hashlib.sha256(json.dumps(pins, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def load_effective_evaluators(pack: Path, rubric: dict) -> dict:
    """Pinned adapters describe the comparator used by evaluator.ts, not new rules."""
    effective = {}
    for criterion in rubric["criteria"]:
        ev = criterion["evaluator"]
        if ev["kind"] == "reference_nearest":
            ref_name = ev.get("model_reference", "")
            path = (pack / ref_name).resolve()
            if path.parent != (pack / "models/reference").resolve() or path.suffix != ".json":
                raise ValueError("reference model must be a pinned pack models/reference JSON")
            model = read_document(path)
            threshold = finite(model.get("threshold"), "reference threshold")
            tolerance = finite(model.get("tolerance", threshold), "reference tolerance")
            effective[criterion["criterion_id"]] = {
                "evaluator": dict(ev, kind="max_value", limit=threshold, tolerance=tolerance),
                "unit": model.get("unit", "none"), "model_reference": ref_name, "model_sha256": digest(path),
                "application": "Update this pinned reference model threshold/tolerance after review; retain reference_nearest criterion kind.",
            }
        elif ev["kind"] == "equipment_dependent":
            kind = ev.get("params", {}).get("comparison_kind")
            if kind in {"range", "max_value", "min_value", "max_abs"}:
                effective[criterion["criterion_id"]] = {
                    "evaluator": dict(ev, kind=kind), "unit": ev.get("params", {}).get("measurement_unit"),
                    "application": "Retain equipment_dependent kind and params.comparison_kind; review the proposed limit/range.",
                }
    return effective


def read_document(path: Path):
    text = path.read_text(encoding="utf-8-sig").strip()
    if not text:
        return []
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return [json.loads(line) for line in text.splitlines() if line.strip()]


def finite(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return float(value)


def known(value) -> bool:
    return isinstance(value, str) and bool(value.strip()) and value.lower() not in {"unknown", "unspecified"}


def sha(value, name: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise ValueError(f"{name} must be a lowercase SHA256")
    return value


def pins(value: dict) -> dict:
    if not isinstance(value, dict):
        raise ValueError("pipeline_provenance is required")
    result = {key: sha(value.get(key), key) for key in PIN_KEYS}
    # Replay may pin additional configuration/tool/phase code. Preserve and
    # compare those too, rather than accepting mixed configurations silently.
    result.update({key: sha(checksum, key) for key, checksum in value.items() if key.endswith("_sha256")})
    return result


def resolve_feature_units(features: list[dict]) -> dict[str, str]:
    """Mirror FeatureEngine's dependency validation/defaultUnit/resolveUnit.

    FeatureSpec.unit is optional: derived feature units come from their source
    feature, with the same derivative conversions as the live engine.
    """
    specs = {feature["id"]: feature for feature in features}
    if len(specs) != len(features):
        raise ValueError("duplicate feature spec ID")
    order, visited, active = [], set(), set()

    def visit(fid):
        if fid in visited:
            return
        if fid in active:
            raise ValueError(f"feature dependency cycle: {fid}")
        if fid not in specs:
            raise ValueError(f"unknown feature dependency: {fid}")
        active.add(fid)
        params = specs[fid].get("params", {})
        dependencies = [params["of"]] if isinstance(params.get("of"), str) else []
        if isinstance(params.get("features"), list):
            dependencies += params["features"]
        for dependency in dependencies:
            visit(dependency)
        active.remove(fid)
        visited.add(fid)
        order.append(fid)

    for fid in specs:
        visit(fid)
    derivative_units = {"deg": "deg_per_s", "rad": "rad_per_s", "deg_per_s": "deg_per_s2",
                        "normalized": "normalized_per_s", "normalized_per_s": "normalized_per_s2",
                        "normalized_per_s2": "normalized_per_s3", "m": "m_per_s"}
    defaults = {"angle_at": "deg", "line_inclination": "deg", "segment_orientation": "deg",
                "interjoint_distance_ratio": "ratio", "relative_phase_timing": "score",
                "path_smoothness": "normalized_per_s3", "center_of_keypoints": "normalized",
                "landmark_coordinate": "normalized", "landmark_offset": "normalized"}
    units = {}
    for fid in order:
        spec = specs[fid]
        kind, params = spec["kind"], spec.get("params", {})
        if spec.get("unit"):
            units[fid] = spec["unit"]
        elif kind in {"time_derivative", "angular_velocity", "stability_variability", "window_min", "window_max", "window_mean"}:
            dependency = params.get("of")
            if dependency not in units:
                raise ValueError(f"unknown feature dependency: {dependency}")
            units[fid] = derivative_units.get(units[dependency], "none") if kind in {"time_derivative", "angular_velocity"} else units[dependency]
        elif kind in {"min_of", "max_of"}:
            dependencies = params.get("features", [])
            units[fid] = units[dependencies[0]] if dependencies else "none"
        else:
            units[fid] = defaults.get(kind, "none")
    return units


def score_against(ev: dict, value: float) -> dict:
    """Exact crisp equality and score decay from scoring/rules.ts."""
    kind = ev["kind"]
    if kind == "range":
        lo, hi = ev["range"]
        distance = max(lo - value, value - hi, 0)
    elif kind == "max_abs":
        distance = max(abs(value) - ev["limit"], 0)
    elif kind in {"max_value", "stability", "phase_duration"}:
        distance = max(value - ev["limit"], 0)
    elif kind in {"min_value", "ordering"}:
        distance = max(ev.get("limit", 1) - value, 0)
    else:
        raise ValueError(f"unsupported evaluator kind: {kind}")
    tolerance = ev.get("tolerance", 0)
    tolerance = tolerance if tolerance > 0 else max(abs(distance), 1e-9)
    score = max(0, min(1, value)) if kind == "ordering" else (1 if distance <= 0 else max(0, 1 - distance / tolerance))
    return {"pass": distance == 0, "distance": distance, "score": score}


def validate_evaluator(ev: dict):
    if ev["kind"] not in KINDS:
        return
    if ev["kind"] == "range":
        bounds = ev.get("range")
        if not isinstance(bounds, list) or len(bounds) != 2 or finite(bounds[0], "range lower") > finite(bounds[1], "range upper"):
            raise ValueError("ordered finite evaluator range required")
    else:
        limit = finite(ev.get("limit", 1 if ev["kind"] == "ordering" else None), "evaluator limit")
        if ev["kind"] == "max_abs" and limit < 0:
            raise ValueError("max_abs limit must be nonnegative")
    if finite(ev.get("tolerance", 0), "evaluator tolerance") < 0:
        raise ValueError("evaluator tolerance must be nonnegative")


def variance_band(ev: dict, unit: str, context: str, profile: dict) -> float:
    if ev["kind"] == "range":
        magnitude = max(abs(ev["range"][1] - ev["range"][0]), 1e-9)
    elif ev["kind"] == "ordering":
        magnitude = ev.get("limit", 1)
    else:
        magnitude = abs(ev.get("limit", 0))
    relative = ev.get("human_variance_relative", profile.get("relative", 0))
    floor = profile.get("measurement_floor", {}).get(unit, 0)
    tolerance = ev.get("tolerance", 0)
    scale = profile.get("context_scale", {}).get(context, 1)
    return max(floor, tolerance, max(tolerance, math.hypot(relative * magnitude, floor)) * scale) if relative > 0 or floor > 0 else 0.0


def predict(rows: list[dict], ev: dict, profile: dict) -> list[str]:
    """Replay prior-repetition variance; current execution cannot inflate its baseline.

    Each row is one final runtime aggregate inside one reviewed repetition. A
    baseline key contains athlete/session/stream/runtime variance reset epoch.
    Temporal gaps alone do not reset runtime variance history. A complete
    reviewed sequence is required, so missing earlier repetitions cannot change
    the simulated baseline silently.
    """
    consistency = profile.get("consistency", {"enabled": False})
    enabled = consistency.get("enabled", False)
    if enabled and not continuity_supported(rows, consistency, require_history=False):
        raise ValueError("insufficient ordered repetitions for consistency evaluation")
    states, history = [""] * len(rows), defaultdict(list)
    ordered = sorted(enumerate(rows), key=lambda ir: (continuity_key(ir[1]), ir[1].get("sequence_index", 0), ir[1]["timestamp_ms"]))
    for index, row in ordered:
        verdict = score_against(ev, row["value"])
        band = variance_band(ev, row["unit"], row["athlete_context"], profile)
        zone = "PASS" if verdict["pass"] else "UNCERTAIN" if verdict["distance"] <= band else "IMPROVE"
        if enabled:
            history_key = continuity_key(row)
            current = row["runtime_execution_id"]
            previous = [h for h in history[history_key] if h[0] != current]
            # Runtime records first and trims, then excludes the current execution.
            history[history_key] = (previous + [(current, row["value"], zone == "IMPROVE")])[-consistency["window"]:]
            previous = [h for h in history[history_key] if h[0] != current]
            if zone == "IMPROVE" and len(previous) >= consistency["min_reps"]:
                values = [h[1] for h in previous]
                sd = statistics.stdev(values) if len(values) > 1 else 0
                fail_fraction = sum(h[2] for h in previous) / len(previous)
                if (fail_fraction < consistency["fail_fraction"] and sd > 0
                        and abs(row["value"] - statistics.mean(values)) <= consistency["k_sd"] * sd):
                    zone = "UNCERTAIN"
        states[index] = zone
    return states


def continuity_key(row: dict) -> tuple:
    return tuple(str(row.get(k, "")) for k in ("split", "athlete_id", "capture_session_id", "stream_id", "repetition_baseline_id"))


def continuity_supported(rows: list[dict], config: dict, *, require_history: bool = True, min_athletes: int = 1) -> bool:
    if any(not all(known(r.get(k)) for k in ("athlete_id", "capture_session_id", "repetition_baseline_id", "runtime_execution_id"))
           or type(r.get("sequence_index")) is not int or r.get("repetition_history_complete") is not True for r in rows):
        return False
    groups = defaultdict(list)
    for row in rows:
        groups[continuity_key(row)].append(row)
    for group in groups.values():
        order = [(r["sequence_index"], r["runtime_execution_id"]) for r in group]
        if len(set(i for i, _ in order)) != len(order) or len(set(e for _, e in order)) != len(order):
            return False
        if sorted(i for i, _ in order) != list(range(len(order))):
            return False
        times = [r["timestamp_ms"] for r in sorted(group, key=lambda r: r["sequence_index"])]
        if times != sorted(times):
            return False
    supporting_athletes = {group[0]["athlete_id"] for group in groups.values() if len(group) >= config["min_reps"] + 1}
    return not require_history or len(supporting_athletes) >= min_athletes


def source_index(manifests: list[dict]) -> dict:
    sources, seen_groups = {}, {}
    for manifest in manifests:
        if manifest.get("sport_pack_id") != "squash":
            raise ValueError("Only squash manifests are accepted by this workflow")
        streams = {s["view_stream_id"]: s for s in manifest["view_streams"]}
        assignments = manifest.get("splits", {}).get("assignments", {})
        for execution in manifest["executions"]:
            eid = execution["execution_id"]
            split = assignments.get(eid)
            if eid in sources or split not in SPLITS:
                raise ValueError(f"duplicate source or missing explicit train/val/test split: {eid}")
            selected = {sid: streams[sid] for sid in execution["view_stream_ids"]}
            for sid, stream in selected.items():
                sha(stream.get("sha256"), "source_sha256")
                if stream.get("extraction", {}).get("orientation_policy") != "encoded":
                    raise ValueError(f"encoded landscape pose extraction required: {sid}")
                if not stream.get("object_uri", "").startswith("s3://apexformz-datacapture-") or "/raw/squash/" not in stream["object_uri"]:
                    raise ValueError(f"source is not squash Data Capture: {sid}")
            groups = [(field, execution.get(field)) for field in ("athlete_id", "capture_session_id", "split_group_id")]
            groups += [("source_sha256", s["sha256"]) for s in selected.values()]
            for field, value in groups:
                if known(value):
                    key = (field, value)
                    if key in seen_groups and seen_groups[key] != split:
                        raise ValueError(f"split leakage: {field} {value}")
                    seen_groups[key] = split
            sources[eid] = {**execution, "split": split, "streams": selected}
    return sources


def validate_labels(labels: list[dict], assignments: dict, sources: dict, criteria: dict) -> list[dict]:
    seen, occupied, result = set(), defaultdict(list), []
    if set(assignments) != {r.get("execution_id") for r in labels}:
        raise ValueError("explicit split assignments must match all reviewed execution IDs")
    for row in labels:
        eid = row.get("execution_id")
        if not known(eid) or eid in seen:
            raise ValueError("unique reviewed execution_id required")
        seen.add(eid)
        source = sources.get(row.get("source_execution_id"))
        if not source or row.get("stream_id") not in source["streams"]:
            raise ValueError(f"review source/stream missing from manifest: {eid}")
        stream = source["streams"][row["stream_id"]]
        if (row.get("review_status") != "reviewed" or not known(row.get("annotator_id"))
                or row["annotator_id"].startswith("importer:") or type(row.get("annotation_version")) is not int
                or row["annotation_version"] < 1 or "disagreement" not in row or row["disagreement"] is not None):
            raise ValueError(f"independent reviewed annotations with resolved disagreements required: {eid}")
        if assignments[eid] != source["split"] or row.get("split", source["split"]) != source["split"]:
            raise ValueError(f"review split differs from pinned source: {eid}")
        for field in ("athlete_id", "capture_session_id"):
            if row.get(field) != source.get(field):
                raise ValueError(f"review {field} differs from source: {eid}")
        if row.get("source_sha256") != stream["sha256"] or row.get("view") != stream["view"]:
            raise ValueError(f"review source hash/view differs from source: {eid}")
        if row.get("handedness") not in {"left", "right", "unknown"}:
            raise ValueError(f"review handedness is required: {eid}")
        start, end = finite(row.get("start_ms"), "start_ms"), finite(row.get("end_ms"), "end_ms")
        if not source["start_ms"] <= start <= end <= source["end_ms"] or (start == end and source["start_ms"] != source["end_ms"]):
            raise ValueError(f"review boundaries exceed source or have no duration: {eid}")
        key = (row["source_execution_id"], row["stream_id"])
        for a, b in occupied[key]:
            if start == end or max(a, start) < min(b, end):
                raise ValueError(f"overlapping reviewed repetitions: {eid}")
        occupied[key].append((start, end))
        outcomes = row.get("criteria")
        if not isinstance(outcomes, dict):
            raise ValueError(f"review criterion outcomes required: {eid}")
        for cid, outcome in outcomes.items():
            if cid not in criteria or criteria[cid]["movement_id"] != row.get("movement_id"):
                raise ValueError(f"review criterion/movement mismatch: {eid}/{cid}")
            if outcome not in {"PASS", "IMPROVE", "UNCERTAIN", "NOT_ASSESSABLE"}:
                raise ValueError(f"invalid reviewed criterion outcome: {eid}/{cid}")
        result.append({**row, "split": source["split"]})
    return result


def join_measurements(labels: list[dict], measurements: list[dict], sources: dict, expected_pins: dict) -> tuple[list[dict], dict]:
    """Join final aggregates to reviewed intervals without inventing repetitions."""
    by_source, joined, exclusions = defaultdict(list), {}, Counter()
    for label in labels:
        by_source[(label["source_execution_id"], label["stream_id"])].append(label)
    for measure in measurements:
        if pins(measure.get("pipeline_provenance")) != expected_pins:
            raise ValueError("mixed or unexpected pipeline provenance")
        source_id = measure.get("source_execution_id", measure.get("execution_id"))
        source = sources.get(source_id)
        sid = measure.get("stream_id")
        if not source or sid not in source["streams"]:
            raise ValueError("measurement source/stream missing from manifest")
        stream = source["streams"][sid]
        if (measure.get("source_sha256") != stream["sha256"] or measure.get("evidence", {}).get("view") != stream["view"]
                or any(measure.get(k) != source.get(k) for k in ("athlete_id", "capture_session_id"))):
            raise ValueError("measurement source identity/hash/view mismatch")
        timestamp = finite(measure.get("timestamp_ms"), "timestamp_ms")
        if not source["start_ms"] <= timestamp <= source["end_ms"]:
            raise ValueError("measurement timestamp exceeds capture bounds")
        context = measure.get("athlete_context")
        if context not in CONTEXTS:
            raise ValueError("measurement athlete_context must be explicit (unknown is allowed)")
        if measure.get("handedness") not in {"left", "right", "unknown"}:
            raise ValueError("measurement handedness must be explicit")
        m = measure.get("measurement", {})
        if m.get("reason") not in ALLOWED_REASONS or m.get("value") is None:
            exclusions["measurement_quality_or_unavailable"] += 1
            continue
        value = finite(m.get("value"), "measurement value")
        if not isinstance(m.get("unit"), str) or not m["unit"]:
            raise ValueError("measurement unit required")
        cid = measure.get("criterion_id")
        eligible = [r for r in by_source[(source_id, sid)] if r["start_ms"] <= timestamp <= r["end_ms"] and cid in r["criteria"]]
        # Adjacent annotations share a boundary: the aggregate span disambiguates.
        span = (measure.get("measurement_start_ms"), measure.get("measurement_end_ms"))
        if all(v is not None for v in span):
            a, b = (finite(v, "measurement span") for v in span)
            if not source["start_ms"] <= a <= b <= timestamp:
                raise ValueError("measurement aggregation span is invalid")
            eligible = [r for r in eligible if r["start_ms"] <= a <= b <= r["end_ms"]]
        else:
            eligible = [r for r in eligible if r["start_ms"] == source["start_ms"] and r["end_ms"] == source["end_ms"]]
        if len(eligible) != 1:
            exclusions["no_unique_reviewed_aggregate_interval"] += 1
            continue
        label = eligible[0]
        if label["handedness"] != measure["handedness"]:
            raise ValueError("measurement/review handedness mismatch; replay with reviewed context")
        if label["criteria"][cid] not in {"PASS", "IMPROVE"}:
            exclusions["review_abstention"] += 1
            continue
        key = (label["execution_id"], sid, cid)
        if key in joined:
            raise ValueError("multiple runtime aggregates map to one reviewed repetition; review separate repetitions")
        joined[key] = {**measure, "source_execution_id": source_id, "execution_id": label["execution_id"],
                       "split": label["split"], "label": label["criteria"][cid], "value": value, "unit": m["unit"],
                       "view": stream["view"], "feature_id": m.get("feature_id"), "timestamp_ms": timestamp}
    return list(joined.values()), dict(exclusions)


def fit_measurement_floors(evidence: dict | None, sources: dict, expected_pins: dict, min_pairs: int = 3) -> tuple[dict, dict]:
    """Lock floors to independent train-only repeatability evidence, never label error.

    Paired values are repeated measurements of the SAME reference observation,
    not two executions by an athlete. The protocol/reviewer attest that meaning.
    """
    if not evidence:
        return {}, {"status": "missing_repeatability_evidence"}
    if (evidence.get("method") != "paired_absolute_difference_quantile" or not known(evidence.get("protocol_id"))
            or evidence.get("review_status") != "reviewed" or not known(evidence.get("reviewer_id"))):
        raise ValueError("reviewed repeatability protocol and paired-difference method required")
    if pins(evidence.get("pipeline_provenance")) != expected_pins:
        raise ValueError("repeatability pipeline differs from measurements")
    quantile = finite(evidence.get("quantile"), "repeatability quantile")
    if not 0 < quantile < 1:
        raise ValueError("repeatability quantile must be between zero and one")
    groups, ids = defaultdict(list), set()
    for pair in evidence.get("pairs", []):
        pid = pair.get("pair_id")
        source = sources.get(pair.get("source_execution_id"))
        if not known(pid) or pid in ids or not source:
            raise ValueError("repeatability pairs need unique IDs and manifest sources")
        ids.add(pid)
        if source["split"] != "train":
            raise ValueError("held-out repeatability evidence cannot fit measurement floors")
        if pair.get("source_sha256") not in {s["sha256"] for s in source["streams"].values()}:
            raise ValueError("repeatability source hash mismatch")
        if not known(pair.get("unit")):
            raise ValueError("repeatability unit required")
        difference = abs(finite(pair.get("measurement_a"), "measurement_a") - finite(pair.get("measurement_b"), "measurement_b"))
        groups[pair["unit"]].append((difference, pair["source_execution_id"]))
    floors, detail = {}, {}
    for unit, pairs in groups.items():
        # Multiple pair IDs from one recording do not establish independent support.
        source_count = len({source for _, source in pairs})
        detail[unit] = {"pairs": len(pairs), "source_executions": source_count}
        if len(pairs) >= min_pairs and source_count >= min_pairs:
            values = sorted(d for d, _ in pairs)
            index = (len(values) - 1) * quantile
            floor = values[math.floor(index)] * (1 - index % 1) + values[math.ceil(index)] * (index % 1)
            floors[unit] = floor
            detail[unit]["floor"] = floor
        else:
            detail[unit]["blocker"] = "insufficient_independent_repeatability_pairs"
    return floors, {"status": "proposal_requires_measurement_review", "method": evidence["method"],
                    "protocol_id": evidence["protocol_id"], "quantile": quantile, "units": detail}


def metrics(rows: list[dict], states: list[str]) -> dict:
    matrix = {truth: {state: 0 for state in ("PASS", "IMPROVE", "UNCERTAIN")} for truth in ("PASS", "IMPROVE")}
    for row, state in zip(rows, states):
        matrix[row["label"]][state] += 1
    n = len(rows)
    passed, improved = (sum(matrix[truth].values()) for truth in ("PASS", "IMPROVE"))
    decided = sum(state != "UNCERTAIN" for state in states)
    correct = matrix["PASS"]["PASS"] + matrix["IMPROVE"]["IMPROVE"]
    return {"executions": n, "athletes": len({r["athlete_id"] for r in rows if known(r["athlete_id"])}),
            "confusion": matrix, "coverage": decided / n if n else None,
            "accuracy_when_decided": correct / decided if decided else None,
            "accuracy_including_abstentions": correct / n if n else None,
            "false_correction_rate": matrix["PASS"]["IMPROVE"] / passed if passed else None,
            "false_acceptance_rate": matrix["IMPROVE"]["PASS"] / improved if improved else None}


def weighted_loss(rows: list[dict], states: list[str], costs: dict) -> float:
    # Each outcome has equal weight; within it each athlete has equal weight.
    groups = defaultdict(list)
    for row, state in zip(rows, states):
        cost = costs["abstention"] if state == "UNCERTAIN" else 0 if state == row["label"] else costs["false_acceptance"] if state == "PASS" else costs["false_correction"]
        groups[(row["label"], row["athlete_id"])].append(cost)
    by_label = defaultdict(list)
    for (label, _), values in groups.items():
        by_label[label].append(statistics.mean(values))
    return statistics.mean(statistics.mean(values) for values in by_label.values())


def validate_search(search: dict) -> dict:
    out = deepcopy(search)
    for key in ("relative_candidates", "context_scale_candidates", "consistency_candidates"):
        if not isinstance(out.get(key), list) or not out[key]:
            raise ValueError(f"explicit nonempty {key} search grid required")
    if any(not 0 <= finite(v, "relative") <= .5 for v in out["relative_candidates"]):
        raise ValueError("relative candidates must be between zero and 0.5")
    if any(finite(v, "context scale") <= 0 for v in out["context_scale_candidates"]):
        raise ValueError("context scales must be positive")
    for config in out["consistency_candidates"]:
        if type(config.get("enabled")) is not bool:
            raise ValueError("consistency enabled must be boolean")
        if config["enabled"]:
            if (type(config.get("window")) is not int or type(config.get("min_reps")) is not int
                    or not 2 <= config["min_reps"] < config["window"] <= 100
                    or finite(config.get("k_sd"), "k_sd") <= 0 or not 0 < finite(config.get("fail_fraction"), "fail_fraction") <= 1):
                raise ValueError("invalid bounded consistency candidate")
    for key in ("false_acceptance", "false_correction", "abstention"):
        if finite(out.get("costs", {}).get(key), key) <= 0:
            raise ValueError("all explicit error/abstention costs must be positive")
    out.setdefault("min_train_per_outcome", 3)
    out.setdefault("min_train_athletes", 2)
    out.setdefault("min_coverage", .6)
    out.setdefault("max_threshold_candidates", 33)
    if (type(out["min_train_per_outcome"]) is not int or out["min_train_per_outcome"] < 3
            or type(out["min_train_athletes"]) is not int or out["min_train_athletes"] < 2
            or not 0 < finite(out["min_coverage"], "min_coverage") <= 1
            or type(out["max_threshold_candidates"]) is not int or not 3 <= out["max_threshold_candidates"] <= 65):
        raise ValueError("support requires >=3 repetitions/outcome, >=2 train athletes and bounded search")
    return out


def threshold_candidates(ev: dict, rows: list[dict], maximum: int) -> list[dict]:
    values = sorted({abs(r["value"]) if ev["kind"] == "max_abs" else r["value"] for r in rows})
    # Variance creates an uncertainty region as well as the crisp boundary.
    # Interior quartiles explore that region; this is an explicitly bounded
    # train-data grid, not a claim of a globally optimal continuous solution.
    candidates = sorted(set(values + [a + (b - a) * fraction for a, b in zip(values, values[1:]) for fraction in (.25, .5, .75)]))
    if len(candidates) > maximum:
        candidates = sorted({candidates[round(i * (len(candidates) - 1) / (maximum - 1))] for i in range(maximum)})
    if ev["kind"] == "range":
        choices = [dict(ev, range=[lo, hi]) for lo, hi in itertools.combinations_with_replacement(candidates, 2)]
    else:
        choices = [dict(ev, limit=value) for value in candidates if ev["kind"] != "ordering" or 0 <= value <= 1]
    return [deepcopy(ev)] + choices


def evaluate(rows: list[dict], ev: dict, profile: dict) -> dict:
    if not rows:
        return {"status": "missing_heldout_split", "executions": 0}
    try:
        states = predict(rows, ev, profile)
    except ValueError as error:
        return {"status": "not_evaluable", "reason": str(error), "executions": len(rows)}
    result = {"status": "evaluated_fixed_proposal", **metrics(rows, states), "strata": {},
              "known_athlete_identity_for_all_rows": all(known(row["athlete_id"]) for row in rows),
              "independent_validation_established": False}
    for field in ("athlete_id", "view", "athlete_context", "handedness"):
        result["strata"][field] = {}
        for value in sorted({r[field] for r in rows}):
            indices = [i for i, r in enumerate(rows) if r[field] == value]
            result["strata"][field][value] = metrics([rows[i] for i in indices], [states[i] for i in indices])
    return result


def fit_groups(rows: list[dict], criteria: dict, floors: dict, search: dict, effective_evaluators: dict | None = None) -> tuple[list[dict], list[dict]]:
    grouped, proposals, blocked = defaultdict(list), [], []
    for row in rows:
        key = tuple(row.get(k) for k in ("criterion_id", "unit", "view", "athlete_context", "handedness", "feature_id"))
        grouped[key].append(row)
    for key, group in sorted(grouped.items(), key=lambda item: str(item[0])):
        cid, unit, view, context, hand, feature = key
        scope = dict(zip(("criterion_id", "unit", "view", "athlete_context", "handedness", "feature_id"), key))
        adapter = (effective_evaluators or {}).get(cid)
        ev = deepcopy(adapter["evaluator"] if adapter else criteria[cid]["evaluator"])
        validate_evaluator(ev)
        train = [r for r in group if r["split"] == "train"]
        support = Counter(r["label"] for r in train)
        athletes = {r["athlete_id"] for r in train if known(r["athlete_id"])}
        reasons = []
        if ev["kind"] not in KINDS:
            reasons.append("unsupported_evaluator_requires_pinned_measurement_adapter")
        if adapter and adapter.get("unit") is not None and adapter["unit"] != unit:
            reasons.append("measurement_unit_differs_from_pinned_adapter")
        views = criteria[cid].get("view_constraints", "any")
        contexts = criteria[cid].get("athlete_context", "any")
        if views != "any" and view not in views:
            reasons.append("view_outside_criterion_scope")
        if contexts != "any" and context not in contexts:
            reasons.append("context_outside_criterion_scope")
        if unit not in floors:
            reasons.append("missing_independent_measurement_floor")
        if any(support[label] < search["min_train_per_outcome"] for label in ("PASS", "IMPROVE")):
            reasons.append("insufficient_reviewed_train_outcomes")
        if (len(athletes) < search["min_train_athletes"] or any(not known(r["athlete_id"]) for r in train)
                or any(len({r["athlete_id"] for r in train if r["label"] == label and known(r["athlete_id"])}) < search["min_train_athletes"] for label in ("PASS", "IMPROVE"))):
            reasons.append("insufficient_known_independent_train_athletes")
        if reasons:
            blocked.append({"scope": scope, "reasons": reasons, "train_outcomes": dict(support), "known_train_athletes": len(athletes)})
            continue
        best, evaluated_candidates = None, 0
        for evaluator in threshold_candidates(ev, train, search["max_threshold_candidates"]):
            for relative, scale, consistency in itertools.product(search["relative_candidates"], search["context_scale_candidates"], search["consistency_candidates"]):
                if consistency["enabled"] and not continuity_supported(train, consistency, min_athletes=search["min_train_athletes"]):
                    continue
                # An existing per-criterion override otherwise shadows the fitted profile.
                candidate = dict(evaluator, human_variance_relative=relative)
                profile = {"relative": relative, "measurement_floor": {unit: floors[unit]},
                           "context_scale": {context: scale}, "consistency": consistency}
                states = predict(train, candidate, profile)
                report = metrics(train, states)
                if report["coverage"] < search["min_coverage"]:
                    continue
                evaluated_candidates += 1
                loss = weighted_loss(train, states, search["costs"])
                # Stable ties prefer coverage and less complex variance; no held-out access.
                rank = (loss, -report["coverage"], int(consistency["enabled"]), relative, abs(scale - 1))
                if best is None or rank < best[0]:
                    best = (rank, candidate, profile, report)
        if best is None:
            blocked.append({"scope": scope, "reasons": ["no_candidate_meets_training_coverage_and_continuity"]})
            continue
        rank, evaluator, profile, train_report = best
        heldout = {split: evaluate([r for r in group if r["split"] == split], evaluator, profile) for split in ("val", "test")}
        proposals.append({"scope": scope, "status": "proposal_requires_coach_and_measurement_review",
                          "selection_split": "train", "proposed_evaluator": evaluator, "human_variance": profile,
                          "effective_evaluator_adapter": adapter,
                          "train": {**train_report, "weighted_loss": rank[0], "candidate_count": evaluated_candidates,
                                    "candidate_policy": "training values and interval quartiles, bounded by max_threshold_candidates; existing threshold included"},
                          "heldout": heldout, "production_eligible": False,
                          "limitations": ["Scoped proposal; not a global pack profile or an approval.",
                                          "Relative allowance and context scale can be statistically non-identifiable; effective band is the measured quantity.",
                                          "Held-out results describe only the athletes/views/contexts with reviewed outcomes."]})
    return proposals, blocked


def run_fit(*, manifests: list[dict], rubric: dict, labels: list[dict], assignments: dict,
            measurements: list[dict], expected_pins: dict | None, floor_evidence: dict | None,
            search: dict | None, readiness: bool = False, effective_evaluators: dict | None = None) -> dict:
    sources = source_index(manifests)
    criteria = {c["criterion_id"]: c for c in rubric["criteria"]}
    reviewed = validate_labels(labels, assignments, sources, criteria) if labels else []
    blockers = []
    if not reviewed:
        blockers.append("missing_independently_reviewed_PASS_IMPROVE_annotations")
    if not measurements:
        blockers.append("missing_runtime_measurement_export")
    expected_pins = pins(expected_pins) if expected_pins is not None else None
    if measurements and expected_pins is None:
        raise ValueError("expected pipeline provenance required for measurements")
    units = resolve_feature_units(rubric.get("features", []))
    for measure in measurements:
        measurement = measure.get("measurement", {})
        feature_id = measurement.get("feature_id")
        if feature_id in units and units[feature_id] != measurement.get("unit"):
            raise ValueError("measurement unit differs from pinned feature definition")
    rows, exclusions = join_measurements(reviewed, measurements, sources, expected_pins) if measurements else ([], {})
    if reviewed and measurements and not rows:
        blockers.append("no_supported_reviewed_runtime_measurement_pairs")
    floors, floor_report = fit_measurement_floors(floor_evidence, sources, expected_pins) if expected_pins else ({}, {"status": "missing_repeatability_evidence"})
    if not floors:
        blockers.append("missing_supported_train_only_repeatability_floors")
    if not search:
        blockers.append("missing_explicit_search_objective_and_candidates")
    reviewed_outcomes = Counter(outcome for row in reviewed for outcome in row["criteria"].values())
    source_athletes = {s.get("athlete_id") for s in sources.values() if known(s.get("athlete_id"))}
    split_counts = dict(Counter(s["split"] for s in sources.values()))
    if len(source_athletes) < 2:
        blockers.append("single_or_unknown_athlete_source_cannot_establish_generalization")
    for split in ("val", "test"):
        if not split_counts.get(split):
            blockers.append(f"missing_{split}_source_split")
    proposals, blocked = [], []
    if search:
        search = validate_search(search)
    if not readiness and search:
        proposals, blocked = fit_groups(rows, criteria, floors, search, effective_evaluators)
    return {"schema_version": "1.0.0", "mode": "readiness" if readiness else "fit", "production_eligible": False,
            "sport_pack_mutated": False, "coach_approval_inferred": False,
            "source_executions": len(sources), "known_source_athletes": len(source_athletes), "source_split_counts": split_counts,
            "reviewed_executions": len(reviewed), "reviewed_outcomes": dict(reviewed_outcomes),
            "declared_criteria": len(criteria), "criteria_with_joined_measurements": len({r["criterion_id"] for r in rows}),
            "joined_measurements": len(rows), "measurement_exclusions": exclusions,
            "pipeline_provenance": expected_pins, "measurement_floors": floor_report, "search": search,
            "blockers": blockers, "blocked_scopes": blocked, "proposals": proposals,
            "claim": "Offline proposals only. Capture identity labels and current engine verdicts are not reviewed technique outcomes."}
