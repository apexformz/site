"""Retrospective (offline) analysis of a recorded PoseFrame bundle (TRD 03/10/11).

Mirrors the edge pipeline semantics: mirror canonicalization, hip-root/torso-scale
normalization with aspect correction, pack-declared features, phase-graph driven
segmentation. Differences, all permitted offline and all flagged:
  * zero-phase Butterworth filtering (scipy filtfilt) -> ``retrospective: true``
  * the segmenter may inspect the whole sequence
Provisional rubrics never produce PASS/IMPROVE (UNCERTAIN / RUBRIC_UNVALIDATED).
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy.signal import butter, filtfilt

from apexformz_contracts import CONTRACT_VERSION, assert_valid
from apexformz_contracts.enums import LANDMARK_INDEX, MIRROR_PAIRS

MODEL_VERSION = "retrospective_segmenter@1.0.0"
MIN_VISIBILITY = 0.5
EPS = 1e-9


class AnalysisError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Signal: canonicalize + normalize (parity with packages/signal/src/coordinates.ts)
# ---------------------------------------------------------------------------

def canonicalize(frame: dict) -> List[dict]:
    lms = frame["normalized_landmarks"]
    if not frame.get("mirror"):
        return lms
    by_id = {l["id"]: l for l in lms}
    swap = {}
    for l, r in MIRROR_PAIRS:
        swap[l] = r
        swap[r] = l
    out = []
    for lm in lms:
        src = by_id.get(swap.get(lm["id"], lm["id"]), lm)
        out.append({**src, "id": lm["id"], "x": 1 - src["x"]})
    return out


def body_relative(lms: List[dict], image_size: Tuple[int, int]) -> Tuple[Optional[np.ndarray], np.ndarray, Optional[str]]:
    """Returns (coords[N,3] or None, valid[N], reason)."""
    W, H = image_size
    n = len(lms)
    coords = np.zeros((n, 3))
    valid = np.zeros(n, dtype=bool)
    for i, l in enumerate(lms):
        conf = l.get("visibility", l.get("presence", 1.0))
        conf = 1.0 if conf is None else conf
        valid[i] = conf >= MIN_VISIBILITY and all(math.isfinite(v) for v in (l["x"], l["y"]))
        coords[i] = (l["x"], l["y"], l.get("z") if l.get("z") is not None else 0.0)
    ids = [LANDMARK_INDEX[k] for k in ("left_shoulder", "right_shoulder", "left_hip", "right_hip")]
    if any(i >= n or not valid[i] for i in ids):
        return None, np.zeros(n, dtype=bool), "MISSING_JOINT"
    ls, rs, lh, rh = (coords[i] for i in ids)
    shoulder_mid = (ls + rs) / 2
    hip_mid = (lh + rh) / 2
    scale_px = math.hypot((shoulder_mid[0] - hip_mid[0]) * W, (shoulder_mid[1] - hip_mid[1]) * H)
    if scale_px < EPS:
        return None, np.zeros(n, dtype=bool), "DEGENERATE_GEOMETRY"
    body = np.empty_like(coords)
    body[:, 0] = (coords[:, 0] - hip_mid[0]) * W / scale_px
    body[:, 1] = (coords[:, 1] - hip_mid[1]) * H / scale_px
    body[:, 2] = (coords[:, 2] - hip_mid[2]) * W / scale_px
    return body, valid, None


def zero_phase_filter(series: np.ndarray, timestamps_ms: np.ndarray, cutoff_hz: float = 5.0, order: int = 2) -> np.ndarray:
    """Bidirectional Butterworth on a uniformly-resampled copy. Offline only (TRD 03)."""
    n = len(timestamps_ms)
    if n < 3 * (order + 1):
        return series
    dt = np.median(np.diff(timestamps_ms)) / 1000.0
    if dt <= 0:
        return series
    fs = 1.0 / dt
    nyq = fs / 2
    if cutoff_hz >= nyq:
        return series
    b, a = butter(order, cutoff_hz / nyq)
    return filtfilt(b, a, series, axis=0)


# ---------------------------------------------------------------------------
# Features (subset of packages/features kinds)
# ---------------------------------------------------------------------------

def _resolve(ref: str, handedness: str) -> Optional[int]:
    if ref in LANDMARK_INDEX:
        return LANDMARK_INDEX[ref]
    for prefix in ("dominant_", "nondominant_", "non_dominant_"):
        if ref.startswith(prefix):
            if handedness not in ("left", "right"):
                return None
            side = handedness if prefix == "dominant_" else ("left" if handedness == "right" else "right")
            name = f"{side}_{ref[len(prefix):]}"
            return LANDMARK_INDEX.get(name)
    return None


def _angle(a, b, c) -> Optional[float]:
    u = a[:2] - b[:2]
    v = c[:2] - b[:2]
    nu, nv = np.linalg.norm(u), np.linalg.norm(v)
    if nu < 1e-6 or nv < 1e-6:
        return None
    cross = u[0] * v[1] - u[1] * v[0]
    return math.degrees(math.atan2(abs(cross), float(np.dot(u, v))))


def _point(coords, valid, ref, handedness):
    if isinstance(ref, list):
        pts = [_point(coords, valid, r, handedness) for r in ref]
        if any(p is None for p in pts):
            return None
        return np.mean(pts, axis=0)
    i = _resolve(ref, handedness)
    if i is None or i >= len(valid) or not valid[i]:
        return None
    return coords[i]


def compute_features(specs: List[dict], body_seq: List[Optional[np.ndarray]], valid_seq: List[np.ndarray], image_seq: List[Optional[np.ndarray]],
                     timestamps: np.ndarray, handedness: str, view: str) -> Dict[str, Dict[str, Any]]:
    """Returns {feature_id: {"values": np.array (nan=invalid), "unit": str, "reason_counts": {...}}}."""
    T = len(timestamps)
    out: Dict[str, Dict[str, Any]] = {}
    order = _topo(specs)
    by_id = {s["id"]: s for s in specs}
    for fid in order:
        spec = by_id[fid]
        p = spec.get("params", {})
        kind = spec["kind"]
        values = np.full(T, np.nan)
        reasons: Dict[str, int] = {}
        unit = spec.get("unit") or "none"
        va = spec.get("view_applicability", "any")
        if va != "any" and view not in va:
            reasons["VIEW_INVALID"] = T
            out[fid] = {"values": values, "unit": unit, "reason_counts": reasons}
            continue
        if kind in ("time_derivative", "angular_velocity"):
            base = out.get(p.get("of"))
            if base is None:
                reasons["DEPENDENCY_INVALID"] = T
            else:
                b = base["values"]
                for t in range(1, T):
                    dt = (timestamps[t] - timestamps[t - 1]) / 1000.0
                    if dt > 0 and not (np.isnan(b[t]) or np.isnan(b[t - 1])):
                        values[t] = (b[t] - b[t - 1]) / dt
                    else:
                        reasons["INSUFFICIENT_HISTORY"] = reasons.get("INSUFFICIENT_HISTORY", 0) + 1
                reasons["INSUFFICIENT_HISTORY"] = reasons.get("INSUFFICIENT_HISTORY", 0) + 1
                unit = {"deg": "deg_per_s", "normalized": "normalized_per_s"}.get(base["unit"], "none")
        elif kind in ("min_of", "max_of"):
            deps = [out.get(f) for f in p.get("features", [])]
            if any(d is None for d in deps):
                reasons["DEPENDENCY_INVALID"] = T
            else:
                stack = np.vstack([d["values"] for d in deps])
                ok = ~np.isnan(stack).any(axis=0)
                agg = np.nanmin(stack, axis=0) if kind == "min_of" else np.nanmax(stack, axis=0)
                values[ok] = agg[ok]
                reasons["DEPENDENCY_INVALID"] = int((~ok).sum())
                unit = deps[0]["unit"]
        elif kind == "stability_variability":
            base = out.get(p.get("of"))
            win = p.get("window_ms", 1000)
            mins = p.get("min_samples", 3)
            if base is None:
                reasons["DEPENDENCY_INVALID"] = T
            else:
                b = base["values"]
                for t in range(T):
                    sel = (timestamps <= timestamps[t]) & (timestamps >= timestamps[t] - win)
                    vals = b[sel]
                    vals = vals[~np.isnan(vals)]
                    if len(vals) < mins:
                        reasons["INSUFFICIENT_HISTORY"] = reasons.get("INSUFFICIENT_HISTORY", 0) + 1
                    else:
                        values[t] = (vals.max() - vals.min()) if p.get("stat") == "range" else float(np.std(vals, ddof=1))
                unit = base["unit"]
        elif kind in ("angle_at", "line_inclination", "interjoint_distance_ratio", "landmark_offset", "center_of_keypoints", "landmark_coordinate"):
            cs = spec.get("coordinate_system", "body_relative")
            for t in range(T):
                coords = body_seq[t] if cs == "body_relative" else image_seq[t]
                vld = valid_seq[t]
                if coords is None:
                    reasons["NORMALIZATION_INVALID" if cs == "body_relative" else "MISSING_JOINT"] = reasons.get("NORMALIZATION_INVALID", 0) + 1
                    continue
                if kind == "angle_at":
                    pts = [_point(coords, vld, p.get(k), handedness) for k in ("a", "b", "c")]
                    if any(x is None for x in pts):
                        reasons["MISSING_JOINT"] = reasons.get("MISSING_JOINT", 0) + 1
                        continue
                    v = _angle(*pts)
                    if v is None:
                        reasons["DEGENERATE_GEOMETRY"] = reasons.get("DEGENERATE_GEOMETRY", 0) + 1
                        continue
                    values[t] = v
                    unit = spec.get("unit") or "deg"
                elif kind == "line_inclination":
                    a = _point(coords, vld, p.get("from"), handedness)
                    b = _point(coords, vld, p.get("to"), handedness)
                    if a is None or b is None:
                        reasons["MISSING_JOINT"] = reasons.get("MISSING_JOINT", 0) + 1
                        continue
                    dx, dy = b[0] - a[0], b[1] - a[1]
                    if math.hypot(dx, dy) < 1e-6:
                        reasons["DEGENERATE_GEOMETRY"] = reasons.get("DEGENERATE_GEOMETRY", 0) + 1
                        continue
                    values[t] = math.degrees(math.atan2(dx, -dy)) if p.get("reference", "vertical") == "vertical" else math.degrees(math.atan2(dy, dx))
                    unit = "deg"
                elif kind == "interjoint_distance_ratio":
                    pts = [_point(coords, vld, p.get(k), handedness) for k in ("a", "b", "c", "d")]
                    if any(x is None for x in pts):
                        reasons["MISSING_JOINT"] = reasons.get("MISSING_JOINT", 0) + 1
                        continue
                    den = np.linalg.norm(pts[2][:2] - pts[3][:2])
                    if den < 1e-6:
                        reasons["DEGENERATE_GEOMETRY"] = reasons.get("DEGENERATE_GEOMETRY", 0) + 1
                        continue
                    values[t] = float(np.linalg.norm(pts[0][:2] - pts[1][:2]) / den)
                    unit = "ratio"
                elif kind == "landmark_offset":
                    a = _point(coords, vld, p.get("a"), handedness)
                    b = _point(coords, vld, p.get("b"), handedness)
                    if a is None or b is None:
                        reasons["MISSING_JOINT"] = reasons.get("MISSING_JOINT", 0) + 1
                        continue
                    ax = {"x": 0, "y": 1, "z": 2}[p.get("axis", "x")]
                    values[t] = float(a[ax] - b[ax])
                    unit = "normalized"
                elif kind == "landmark_coordinate":
                    a = _point(coords, vld, p.get("landmark"), handedness)
                    if a is None:
                        reasons["MISSING_JOINT"] = reasons.get("MISSING_JOINT", 0) + 1
                        continue
                    values[t] = float(a[{"x": 0, "y": 1, "z": 2}[p.get("axis", "y")]])
                    unit = "normalized"
                else:  # center_of_keypoints
                    pts = [_point(coords, vld, n, handedness) for n in p.get("landmarks", [])]
                    if not pts or any(x is None for x in pts):
                        reasons["MISSING_JOINT"] = reasons.get("MISSING_JOINT", 0) + 1
                        continue
                    values[t] = float(np.mean([x[{"x": 0, "y": 1, "z": 2}[p.get("axis", "y")]] for x in pts]))
                    unit = "normalized"
        else:
            reasons["UNKNOWN_FEATURE"] = T
        out[fid] = {"values": values, "unit": unit, "reason_counts": reasons}
    return out


def _topo(specs: List[dict]) -> List[str]:
    by_id = {s["id"]: s for s in specs}
    seen: Dict[str, int] = {}
    order: List[str] = []

    def deps(s):
        p = s.get("params", {})
        d = []
        if isinstance(p.get("of"), str):
            d.append(p["of"])
        d.extend(p.get("features", []) or [])
        return d

    def visit(i, chain):
        st = seen.get(i, 0)
        if st == 2:
            return
        if st == 1:
            raise AnalysisError("PACK_VALIDATION_FAILED", f"feature cycle {'->'.join(chain + [i])}")
        s = by_id.get(i)
        if s is None:
            raise AnalysisError("PACK_VALIDATION_FAILED", f"unknown feature {i}")
        seen[i] = 1
        for d in deps(s):
            visit(d, chain + [i])
        seen[i] = 2
        order.append(i)

    for s in specs:
        visit(s["id"], [])
    return order


# ---------------------------------------------------------------------------
# Offline phase segmentation (same hold/min-duration semantics as the TS segmenter)
# ---------------------------------------------------------------------------

def _cond(cond: dict, feats, t) -> Optional[bool]:
    v = feats.get(cond["feature"], {}).get("values")
    if v is None or np.isnan(v[t]):
        return None
    x = float(v[t])
    val = cond["value"]
    op = cond["op"]
    if op == "lt":
        return x < val
    if op == "lte":
        return x <= val
    if op == "gt":
        return x > val
    if op == "gte":
        return x >= val
    if op == "abs_gt":
        return abs(x) > val
    if op == "abs_lt":
        return abs(x) < val
    lo, hi = val
    return lo <= x <= hi


def _all(conds, feats, t) -> Optional[bool]:
    res = [_cond(c, feats, t) for c in conds]
    if any(r is None for r in res):
        return None
    return all(res)


def segment(graph: dict, feats, timestamps: np.ndarray, ctx: dict) -> Tuple[List[dict], List[dict]]:
    """Returns (movement_events, executions). Causal rules applied over the full recording."""
    phases = {p["id"]: p for p in graph["phases"]}
    edges: Dict[str, List[str]] = {p: [] for p in phases}
    for e in graph["edges"]:
        edges[e["from"]].append(e["to"])
    initial = graph["initial"]
    terminal = set(graph["terminal"])
    static = graph["kind"] == "static_hold"
    confirm = graph.get("confirm_hold_ms", phases[initial].get("hold_ms", 0)) or 0
    T = len(timestamps)

    events: List[dict] = []
    executions: List[dict] = []
    seq = 0

    def ev(state, t, phase, start, end=None, reason=None, exec_id=None):
        nonlocal seq
        seq += 1
        return {
            "schema_version": CONTRACT_VERSION, "session_id": ctx["session_id"],
            "event_id": f"{ctx['session_id']}:retro:{seq:08d}", "execution_id": exec_id,
            "movement_id": ctx["movement_id"], "phase_id": phase, "start_ms": float(start), "end_ms": None if end is None else float(end),
            "confidence": 1.0, "evidence_frames": [int(ctx["frame_ids"][t])], "state": state, "model_version": MODEL_VERSION,
            "unknown_reason": reason, "contact_evidence": phases[phase]["contact_evidence"] if phase else "none",
            "retrospective": True, "sport_pack_id": ctx["sport_pack_id"], "sport_pack_version": ctx["sport_pack_version"],
        }

    state = "IDLE"
    phase = None
    entered = None
    hold_since = None
    hold_target = None
    spans: List[dict] = []
    exec_n = 0
    exec_id = None
    exec_start = None

    for t in range(T):
        ts = timestamps[t]
        if state in ("IDLE", "COMPLETE", "ABORTED"):
            r = _all(phases[initial]["enter"], feats, t)
            if r:
                state, phase, entered, hold_since = "CANDIDATE", initial, ts, ts
                events.append(ev("CANDIDATE", t, phase, ts))
            else:
                state = "IDLE"
            continue
        if state == "CANDIDATE":
            r = _all(phases[initial]["enter"], feats, t)
            if not r:
                state, phase, entered = "IDLE", None, None
                continue
            if ts - hold_since >= confirm:
                state = "CONFIRMED"
                events.append(ev("CONFIRMED", t, phase, entered))
                if static:
                    exec_n += 1
                    exec_id = f"{ctx['session_id']}:retro-exec:{exec_n}"
                    exec_start = entered
                    spans = [{"phase_id": initial, "start_ms": float(entered), "end_ms": None}]
            continue
        cur = phases[phase]
        in_phase = ts - entered
        if static:
            r = _all(cur["enter"], feats, t)
            if r is None:
                continue
            if not r:
                spans[-1]["end_ms"] = float(ts)
                if in_phase >= cur["min_duration_ms"]:
                    state = "COMPLETE"
                    events.append(ev("COMPLETE", t, phase, entered, ts, exec_id=exec_id))
                    executions.append({"execution_id": exec_id, "start_ms": float(exec_start), "end_ms": float(ts), "phases": spans, "completed": True})
                else:
                    state = "ABORTED"
                    events.append(ev("ABORTED", t, phase, entered, ts, "HOLD_TOO_SHORT", exec_id))
                phase, entered, exec_id = None, None, None
            continue
        # dynamic
        if state == "EXECUTING" and cur.get("max_duration_ms") is not None and in_phase > cur["max_duration_ms"]:
            spans[-1]["end_ms"] = float(ts)
            events.append(ev("ABORTED", t, phase, entered, ts, "PHASE_TIMEOUT", exec_id))
            executions.append({"execution_id": exec_id, "start_ms": float(exec_start), "end_ms": float(ts), "phases": spans, "completed": False})
            state, phase, entered, hold_target, exec_id = "ABORTED", None, None, None, None
            continue
        moved = False
        for target in edges[phase]:
            if target == initial:
                continue
            r = _all(phases[target]["enter"], feats, t)
            if not r:
                if hold_target == target:
                    hold_target = None
                continue
            if in_phase < cur["min_duration_ms"]:
                continue
            if hold_target != target:
                hold_target, hold_since = target, ts
            if ts - hold_since < (phases[target].get("hold_ms") or 0):
                continue
            if state == "CONFIRMED":
                exec_n += 1
                exec_id = f"{ctx['session_id']}:retro-exec:{exec_n}"
                exec_start = entered
                spans = [{"phase_id": phase, "start_ms": float(entered), "end_ms": float(ts)}]
                state = "EXECUTING"
            else:
                spans[-1]["end_ms"] = float(ts)
            phase, entered, hold_target = target, ts, None
            spans.append({"phase_id": phase, "start_ms": float(ts), "end_ms": None})
            events.append(ev("EXECUTING", t, phase, ts, exec_id=exec_id))
            moved = True
            break
        if not moved and state == "EXECUTING" and phase in terminal and in_phase >= cur["min_duration_ms"]:
            spans[-1]["end_ms"] = float(ts)
            events.append(ev("COMPLETE", t, phase, entered, ts, exec_id=exec_id))
            executions.append({"execution_id": exec_id, "start_ms": float(exec_start), "end_ms": float(ts), "phases": spans, "completed": True})
            state, phase, entered, exec_id = "COMPLETE", None, None, None
    return events, executions


# ---------------------------------------------------------------------------
# Criteria (strict mode only: provisional => UNCERTAIN)
# ---------------------------------------------------------------------------

def _agg(vals: np.ndarray, how: str) -> float:
    if how in ("latest", "phase_end"):
        return float(vals[-1])
    if how in ("window_min", "phase_min"):
        return float(vals.min())
    if how in ("window_max", "phase_max"):
        return float(vals.max())
    return float(vals.mean())


def evaluate_criteria(pack: dict, movement: dict, graph: dict, executions: List[dict], feats, timestamps: np.ndarray, ctx: dict) -> List[dict]:
    crit_by_id = {c["criterion_id"]: c for c in pack["technique_criteria"]["criteria"]}
    rubric = pack["technique_criteria"]["rubric_version"]
    sets = []
    phases = {p["id"]: p for p in graph["phases"]}
    for n, ex in enumerate(executions):
        if not ex["completed"]:
            continue
        evid = []
        for cid in movement["criteria"]:
            c = crit_by_id[cid]
            pids = c["phase_ids"] if c["phase_ids"] is not None else [s["phase_id"] for s in ex["phases"]]
            spans = [s for s in ex["phases"] if s["phase_id"] in pids and s["end_ms"] is not None]
            sel = np.zeros(len(timestamps), dtype=bool)
            for s in spans:
                sel |= (timestamps >= s["start_ms"]) & (timestamps <= s["end_ms"])
            frames = [int(f) for f in np.asarray(ctx["frame_ids"])[sel]][-60:]
            base = {
                "criterion_id": cid, "movement_id": movement["id"], "phase_id": pids[0] if pids else None,
                "confidence": {"movement": 1.0, "assessment": None}, "evidence": {"frame_ids": frames, "view": ctx["view"], "feature_ids": c["required_features"]},
                "feedback": None, "provenance": {"sport_pack": pack["manifest"]["version"], "rubric": rubric, "validation_status": c["validation_status"], "evaluator": c["evaluator"]["kind"], "provisional": c["validation_status"] != "approved"},
                "severity": c["severity"], "timestamp_ms": float(ex["end_ms"]), "retrospective": True,
            }
            unit = (c["evaluator"].get("params") or {}).get("measurement_unit", "none")

            def abstain(state, reason, value=None, unit_=unit):
                return {**base, "state": state, "score": None, "measurement": {"value": value, "unit": unit_, "reason": reason}}

            if c["validation_status"] == "disabled":
                evid.append(abstain("NOT_ASSESSABLE", "RUBRIC_DISABLED"))
                continue
            if c["view_constraints"] != "any" and ctx["view"] not in c["view_constraints"]:
                evid.append(abstain("NOT_ASSESSABLE", "VIEW_INVALID"))
                continue
            missing_cap = [cap for cap in c["requires_capabilities"] if cap not in ctx["capabilities"]]
            if missing_cap:
                evid.append(abstain("NOT_ASSESSABLE", "CAPABILITY_MISSING"))
                continue
            if c["evaluator"]["kind"] == "equipment_dependent":
                unobserved = any(phases[p]["contact_evidence"] in ("unobserved", "estimated_contact") for p in pids if p in phases)
                reason = "CONTACT_UNOBSERVED" if (c["evaluator"].get("params") or {}).get("requires_contact") and unobserved else "EQUIPMENT_UNOBSERVED"
                evid.append(abstain("NOT_ASSESSABLE", reason))
                continue
            if not spans:
                evid.append(abstain("NOT_ASSESSABLE", "PHASE_NOT_ACTIVE"))
                continue
            if c["evaluator"]["kind"] == "phase_duration":
                pid = (c["evaluator"].get("params") or {}).get("phase_id", pids[0])
                sp = [s for s in ex["phases"] if s["phase_id"] == pid and s["end_ms"] is not None]
                if not sp:
                    evid.append(abstain("NOT_ASSESSABLE", "PHASE_NOT_ACTIVE", unit_="ms"))
                    continue
                dur = sp[0]["end_ms"] - sp[0]["start_ms"]
                evid.append(abstain("UNCERTAIN", "RUBRIC_UNVALIDATED", dur, "ms") if c["validation_status"] != "approved" else abstain("UNCERTAIN", "RUBRIC_UNVALIDATED", dur, "ms"))
                continue
            fid = c["required_features"][0] if c["required_features"] else None
            if c.get("feature_selector"):
                fid = c["feature_selector"]["candidates"][0]
            f = feats.get(fid) if fid else None
            if f is None:
                evid.append(abstain("NOT_ASSESSABLE" if c["missing_data_policy"] == "not_assessable" else "UNCERTAIN", "UNKNOWN_FEATURE"))
                continue
            vals = f["values"][sel]
            vals = vals[~np.isnan(vals)]
            if len(vals) == 0:
                reason = max(f["reason_counts"], key=f["reason_counts"].get) if f["reason_counts"] else "INSUFFICIENT_HISTORY"
                evid.append(abstain("NOT_ASSESSABLE" if c["missing_data_policy"] == "not_assessable" else "UNCERTAIN", reason, unit_=f["unit"]))
                continue
            measured = _agg(vals, c["evaluator"].get("aggregate", "latest"))
            # Offline analysis runs strict: provisional cutoffs are never applied as verdicts.
            evid.append(abstain("UNCERTAIN", "RUBRIC_UNVALIDATED", measured, f["unit"]))
        required = [e for e in evid if e["state"] != "NOT_APPLICABLE" and crit_by_id[e["criterion_id"]]["validation_status"] != "disabled"]
        sets.append({
            "schema_version": CONTRACT_VERSION, "session_id": ctx["session_id"], "event_id": f"{ctx['session_id']}:retro-as:{n + 1:08d}",
            "execution_id": ex["execution_id"], "timestamp_ms": float(ex["end_ms"]), "movement_id": movement["id"], "phase_id": None,
            "criteria": evid, "score": None,
            "coverage": {"evaluated": 0, "required": len(required), "ratio": 0.0, "minimum": pack["technique_criteria"]["aggregation"]["minimum_coverage"],
                         "omitted": [{"criterion_id": e["criterion_id"], "reason": f"{e['state']}:{e['measurement']['reason']}"} for e in required]},
            "method": pack["technique_criteria"]["aggregation"]["method"], "weights": {}, "uncertainty": None,
            "rubric_version": rubric, "sport_pack_id": pack["manifest"]["id"], "sport_pack_version": pack["manifest"]["version"], "retrospective": True,
        })
    return sets


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def analyze_feature_bundle(bundle: List[dict], sport_pack: dict, movement_id: str, handedness: str = "right", view: str = "front",
                           capabilities: Optional[List[str]] = None) -> dict:
    if not bundle:
        raise AnalysisError("SCHEMA_INVALID", "empty feature bundle")
    frames = [assert_valid("poseFrame", f) for f in bundle]
    frames.sort(key=lambda f: (f["timestamp_ms"], f["frame_id"]))
    movement = next((m for m in sport_pack["movement_catalog"]["movements"] if m["id"] == movement_id), None)
    if movement is None:
        raise AnalysisError("UNKNOWN_SPORT_PACK", f"movement {movement_id} not in pack {sport_pack['manifest']['id']}")
    graph = next(g for g in sport_pack["phase_graphs"]["graphs"] if g["id"] == movement["phase_graph_id"])

    timestamps = np.array([f["timestamp_ms"] for f in frames], dtype=float)
    frame_ids = np.array([f["frame_id"] for f in frames])
    gaps = int((np.diff(timestamps) > 400).sum()) if len(timestamps) > 1 else 0

    image_seq, body_seq, valid_seq = [], [], []
    norm_fail = 0
    for f in frames:
        lms = canonicalize(f)
        img = np.array([[l["x"], l["y"], l.get("z") or 0.0] for l in lms]) if lms else None
        body, valid, reason = body_relative(lms, tuple(f["image_size"])) if lms else (None, np.zeros(0, dtype=bool), "MISSING_JOINT")
        if body is None:
            norm_fail += 1
        image_seq.append(img)
        body_seq.append(body)
        valid_seq.append(valid)

    # Zero-phase smoothing of body coordinates where a contiguous valid run exists.
    if all(b is not None for b in body_seq) and len(body_seq) >= 9:
        stack = np.stack(body_seq)  # T,N,3
        T, N, _ = stack.shape
        flat = zero_phase_filter(stack.reshape(T, -1), timestamps)
        body_seq = list(flat.reshape(T, N, 3))

    specs = _needed_specs(sport_pack, movement, graph)
    feats = compute_features(specs, body_seq, valid_seq, image_seq, timestamps, handedness, view)
    ctx = {"session_id": frames[0]["session_id"], "movement_id": movement_id, "sport_pack_id": sport_pack["manifest"]["id"],
           "sport_pack_version": sport_pack["manifest"]["version"], "frame_ids": frame_ids, "view": view,
           "capabilities": capabilities or ["body_pose"]}
    events, executions = segment(graph, feats, timestamps, ctx)
    assessments = evaluate_criteria(sport_pack, movement, graph, executions, feats, timestamps, ctx)
    for e in events:
        assert_valid("movementEvent", e)
    for a in assessments:
        assert_valid("assessmentSet", a)

    phase_stats = []
    for ex in executions:
        for s in ex["phases"]:
            if s["end_ms"] is None:
                continue
            sel = (timestamps >= s["start_ms"]) & (timestamps <= s["end_ms"])
            stats = {}
            for fid, f in feats.items():
                v = f["values"][sel]
                v = v[~np.isnan(v)]
                if len(v):
                    stats[fid] = {"min": float(v.min()), "max": float(v.max()), "mean": float(v.mean()), "samples": int(len(v)), "unit": f["unit"]}
            phase_stats.append({"execution_id": ex["execution_id"], "phase_id": s["phase_id"], "start_ms": s["start_ms"], "end_ms": s["end_ms"], "features": stats})

    return {
        "retrospective": True,
        "model_version": MODEL_VERSION,
        "processing": {"filter": "butterworth_zero_phase", "order": 2, "cutoff_hz": 5.0, "note": "offline bidirectional filtering; not comparable to live latency"},
        "frames": len(frames), "time_gaps": gaps, "normalization_failures": norm_fail,
        "movement_events": events, "executions": executions, "assessments": assessments, "phase_feature_stats": phase_stats,
        "feature_availability": {fid: {"valid_samples": int((~np.isnan(f["values"])).sum()), "reasons": f["reason_counts"], "unit": f["unit"]} for fid, f in feats.items()},
    }


def _needed_specs(pack: dict, movement: dict, graph: dict) -> List[dict]:
    all_specs = {s["id"]: s for s in pack["technique_criteria"]["features"]}
    needed: Dict[str, dict] = {}

    def add(fid):
        if fid in needed or fid not in all_specs:
            return
        needed[fid] = all_specs[fid]
        p = all_specs[fid].get("params", {})
        if isinstance(p.get("of"), str):
            add(p["of"])
        for f in p.get("features", []) or []:
            add(f)

    for c in pack["technique_criteria"]["criteria"]:
        if c["criterion_id"] in movement["criteria"]:
            for f in c["required_features"]:
                add(f)
            if c.get("feature_selector"):
                for f in c["feature_selector"]["candidates"]:
                    add(f)
    for ph in graph["phases"]:
        for cond in ph["enter"]:
            add(cond["feature"])
    return [all_specs[i] for i in all_specs if i in needed]
