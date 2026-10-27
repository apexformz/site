"""
Generate the squash sport engine pack from the labeled Data Capture catalog and the data-driven taxonomy.

Inputs
  ml/sports/squash/source_catalog.json      every labeled squash movement (ids, names, categories, instructions)
  ml/sports/squash/taxonomy.json            family -> group -> movement hierarchy measured on the recordings
  ml/sports/squash/similarity_report.json   per-movement nearest pose neighbours (hard negatives)
  ml/sports/squash/reference_vectors.json   expert reference postures for static movements (optional)

Outputs (sport-packs/squash/)
  movement_catalog.json (with taxonomy), phase_graphs.json, technique_criteria.json, feedback_templates.json,
  provenance.json, manifest.json, models/reference/*.json
  ml/sports/squash/reference_feature_specs.json (feature specs used by tools/extract_reference_vectors.ts)

The court geometry, competition rules and equipment catalog are hand-written from the WSF documents and are NOT
touched here.

Two independent structures:
  * the TAXONOMY (recognition) comes from measured pose similarity plus label semantics (build_taxonomy.py);
  * the TEMPLATE (phase graph + criteria) comes from the movement's own motion instruction in the catalog.
A family may therefore mix templates (e.g. forward travel and forward lunges look alike to the camera but are
segmented and coached differently).

Every phase threshold and criterion limit is a provisional seed (TODO_REQUIRES_VALIDATION). Expert references come
from one expert athlete and are provisional until more athletes are captured.

  npm run build:squash-engine       (taxonomy -> specs -> reference vectors -> pack -> seal -> validate)
"""
from __future__ import annotations

import json
import math
import pathlib
import re
import argparse
import hashlib
import shutil
import uuid
import importlib.util

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "sport-packs" / "squash"
KIT = ROOT / "ml" / "sports" / "squash"
SPORT = "squash"
V = "1.0.0"
CITE_COACH = {"source": "TODO_REQUIRES_VALIDATION: squash coach panel review of seed cutoffs", "status": "provisional"}


def install_extracted_dynamic_references(out):
    """Preserve optional extracted trajectory models across a full pack rebuild."""
    spec = importlib.util.spec_from_file_location("dynamic_reference_installer", ROOT / "tools/install_dynamic_references.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.install_dynamic_references(out)
CITE_LUNGE = {"source": "Coaching heuristic: lead knee above the ankle, hip-knee-ankle near a right angle (Squash Magazine, Strength Training for Squash Part V: Lunging, 2010); coach approval pending", "url": "https://squashmagazine.com/2010/01/strength-training-for-squash-part-v-lunging/", "status": "provisional"}
CITE_KIN = {"source": "Kinematic differences between skill levels in the squash forehand drive, volley and drop (ResearchGate 340657676): skilled players show faster racket velocity and more closed face at impact; drop uses less joint motion", "status": "provisional"}
CITE_T = {"source": "Coaching heuristic: recover to the T after each shot (multiple coaching sources, e.g. SquashSkills, Squash Empire); coach approval pending", "status": "provisional"}
CITE_DATA = {"source": "ApexFormz Data Capture squash recordings (catalog 1.0.0, expert athlete ATH_0005, front/back/left views); one athlete, TODO_REQUIRES_VALIDATION on more athletes", "status": "provisional"}
ALL_VIEWS = ["front", "back", "left", "right"]
STROKE_VIEWS = ["back", "left", "right"]


def uid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"apexformz://{SPORT}/{name}"))


def f(id_, kind, params, cs="body_relative", views="any", unit=None, desc=None):
    d = {"id": id_, "kind": kind, "params": params, "version": V, "coordinate_system": cs, "view_applicability": views}
    if unit:
        d["unit"] = unit
    if desc:
        d["description"] = desc
    return d


FEATURES = [
    f("left_knee_angle", "angle_at", {"a": "left_hip", "b": "left_knee", "c": "left_ankle", "dims": "2d"}, unit="deg"),
    f("right_knee_angle", "angle_at", {"a": "right_hip", "b": "right_knee", "c": "right_ankle", "dims": "2d"}, unit="deg"),
    f("lead_knee_angle", "min_of", {"features": ["left_knee_angle", "right_knee_angle"]}, unit="deg", desc="More flexed knee = lunging leg"),
    f("max_knee_angle", "max_of", {"features": ["left_knee_angle", "right_knee_angle"]}, unit="deg"),
    f("left_hip_angle", "angle_at", {"a": "left_shoulder", "b": "left_hip", "c": "left_knee", "dims": "2d"}, unit="deg", desc="Trunk-thigh angle (hip flexion proxy)"),
    f("right_hip_angle", "angle_at", {"a": "right_shoulder", "b": "right_hip", "c": "right_knee", "dims": "2d"}, unit="deg"),
    f("lead_knee_velocity", "angular_velocity", {"of": "lead_knee_angle", "window_ms": 150, "method": "finite"}),
    f("dominant_elbow_angle", "angle_at", {"a": "dominant_shoulder", "b": "dominant_elbow", "c": "dominant_wrist", "dims": "2d"}, unit="deg"),
    f("nondominant_elbow_angle", "angle_at", {"a": "nondominant_shoulder", "b": "nondominant_elbow", "c": "nondominant_wrist", "dims": "2d"}, unit="deg"),
    f("dominant_elbow_velocity", "angular_velocity", {"of": "dominant_elbow_angle", "window_ms": 150, "method": "finite"}, desc="Proxy for swing speed; racket speed itself needs the implement adapter"),
    f("dominant_arm_elevation", "angle_at", {"a": "dominant_hip", "b": "dominant_shoulder", "c": "dominant_elbow", "dims": "2d"}, unit="deg"),
    f("nondominant_arm_elevation", "angle_at", {"a": "nondominant_hip", "b": "nondominant_shoulder", "c": "nondominant_elbow", "dims": "2d"}, unit="deg"),
    f("dominant_wrist_rel_y", "landmark_offset", {"a": "dominant_wrist", "b": "dominant_shoulder", "axis": "y"}, unit="normalized", desc="Racket-hand height relative to the shoulder in torso lengths; negative = above the shoulder (racket prepared high)"),
    f("dominant_wrist_jerk", "path_smoothness", {"landmark": "dominant_wrist", "window_ms": 500}, desc="RMS jerk of the racket hand path; lower is smoother"),
    f("trunk_lateral_lean", "line_inclination", {"from": ["left_hip", "right_hip"], "to": ["left_shoulder", "right_shoulder"], "reference": "vertical"}, views=["front", "back"], unit="deg"),
    f("trunk_forward_lean", "line_inclination", {"from": ["left_hip", "right_hip"], "to": ["left_shoulder", "right_shoulder"], "reference": "vertical"}, views=["left", "right"], unit="deg"),
    f("shoulder_line_xz", "segment_orientation", {"from": "left_shoulder", "to": "right_shoulder", "plane": "xz"}, views=["back", "front"], unit="deg", desc="Shoulder rotation toward the side wall using model depth; depth ambiguity is a known failure mode"),
    f("stance_width_ratio", "interjoint_distance_ratio", {"a": "left_ankle", "b": "right_ankle", "c": "left_shoulder", "d": "right_shoulder", "dims": "2d"}, views=["front", "back"], unit="ratio"),
    f("left_knee_ankle_offset_x", "landmark_offset", {"a": "left_knee", "b": "left_ankle", "axis": "x"}, views=["front", "back"], unit="normalized"),
    f("right_knee_ankle_offset_x", "landmark_offset", {"a": "right_knee", "b": "right_ankle", "axis": "x"}, views=["front", "back"], unit="normalized"),
    f("hip_centre_x_image", "center_of_keypoints", {"landmarks": ["left_hip", "right_hip"], "axis": "x"}, cs="image_normalized", unit="normalized"),
    f("hip_centre_y_image", "center_of_keypoints", {"landmarks": ["left_hip", "right_hip"], "axis": "y"}, cs="image_normalized", unit="normalized"),
    f("body_motion", "stability_variability", {"of": "hip_centre_x_image", "window_ms": 600, "stat": "std", "min_samples": 4}, cs="image_normalized", desc="Whole-body stillness proxy (sideways in the image); not a centre of mass"),
    f("hip_motion_y", "stability_variability", {"of": "hip_centre_y_image", "window_ms": 600, "stat": "std", "min_samples": 4}, cs="image_normalized", desc="Vertical hip movement in the image: travel toward or away from a front/back camera"),
    f("body_travel", "max_of", {"features": ["body_motion", "hip_motion_y"]}, cs="image_normalized", desc="Travel in any image direction (max of horizontal and vertical hip variability)"),
    f("hip_vertical_velocity", "time_derivative", {"of": "hip_centre_y_image", "window_ms": 150, "method": "finite"}, cs="image_normalized"),
    f("nose_x_image", "landmark_coordinate", {"landmark": "nose", "axis": "x"}, cs="image_normalized", unit="normalized"),
    f("head_stability", "stability_variability", {"of": "nose_x_image", "window_ms": 500, "stat": "std", "min_samples": 4}, cs="image_normalized", desc="Head stillness through the swing"),
    f("stroke_sequencing", "relative_phase_timing", {"features": ["lead_knee_angle", "dominant_elbow_angle"], "window_ms": 1500}, unit="score", desc="1.0 when the legs reach peak speed before the racket arm"),
]
# View-agnostic joint angles used for the expert-reference posture comparison (all in degrees).
REFERENCE_FEATURES = ["left_knee_angle", "right_knee_angle", "left_hip_angle", "right_hip_angle", "dominant_elbow_angle", "nondominant_elbow_angle", "dominant_arm_elevation", "nondominant_arm_elevation"]
REFERENCE_WEIGHTS = [1.0, 1.0, 0.8, 0.8, 0.6, 0.4, 0.6, 0.4]


def cond(feature, op, value):
    return {"feature": feature, "op": op, "value": value, "validation_status": "provisional"}


def phase(id_, name, kind, enter, min_ms, max_ms=None, hold=60, cue=False, contact="none"):
    return {"id": id_, "name": name, "kind": kind, "contact_evidence": contact, "min_duration_ms": min_ms, "max_duration_ms": max_ms, "enter": enter, "hold_ms": hold, "cue_allowed": cue}


def chain(ids):
    return [{"from": a, "to": b} for a, b in zip(ids, ids[1:])] + [{"from": ids[-1], "to": ids[0]}]


def dyn_graph(mid, phases, initial, terminal, window=3000, abort=6000, confirm=80, allow_skip=False, note="seed"):
    return {"id": f"pg.{mid}", "movement_id": mid, "kind": "dynamic_sequence", "window_ms": window, "abort_timeout_ms": abort, "confirm_hold_ms": confirm, "allow_skip": allow_skip,
            "phases": phases, "edges": chain([p["id"] for p in phases]), "initial": initial, "terminal": [terminal], "validation_status": "provisional", "note": f"TODO_REQUIRES_VALIDATION: {note}"}


STROKE_PARAMS = {
    "drive": dict(prep_height=-0.15, swing_vel=250.0, contact_vel=150.0, note="drive seed: preparation = racket hand above shoulder, swing = fast elbow extension"),
    "volley": dict(prep_height=-0.25, swing_vel=200.0, contact_vel=120.0, note="volley seed: higher preparation, shorter punch"),
    "drop": dict(prep_height=-0.1, swing_vel=120.0, contact_vel=80.0, note="drop seed: slow controlled swing, low thresholds"),
    "lob": dict(prep_height=-0.1, swing_vel=200.0, contact_vel=120.0, note="lob seed: upward follow-through not observable without racket tracking"),
    "serve": dict(prep_height=-0.15, swing_vel=200.0, contact_vel=120.0, note="serve seed: foot-in-box needs court calibration; ball flight needs ball tracking"),
}


def stroke_graph(mid, variant):
    p = STROKE_PARAMS[variant]
    phases = [
        phase("ready", "Ready", "rest", [cond("body_motion", "lt", 0.012)], 150, None, 120, True),
        phase("preparation", "Racket preparation", "preparation", [cond("dominant_wrist_rel_y", "lt", p["prep_height"])], 60, 2500, 60, False),
        phase("swing", "Swing", "action", [cond("dominant_elbow_velocity", "abs_gt", p["swing_vel"])], 30, 900, 30, False),
        phase("estimated_contact", "Estimated contact", "contact", [cond("dominant_elbow_velocity", "abs_lt", p["contact_vel"])], 20, 600, 20, False, "unobserved"),
        phase("follow_through", "Follow through", "follow_through", [cond("dominant_elbow_velocity", "abs_lt", 60)], 60, 1500, 40, False),
        phase("recovery", "Recovery to the T", "recovery", [cond("body_motion", "lt", 0.012)], 100, 3500, 100, True),
    ]
    return dyn_graph(mid, phases, "ready", "recovery", allow_skip=True, note=f"{p['note']}; ball contact is never observed from body pose and is labelled estimated/unobserved")


def lunge_graph(mid):
    phases = [
        phase("ready", "Ready", "rest", [cond("lead_knee_angle", "gt", 148)], 150, None, 150, True),
        phase("drive", "Drive out", "action", [cond("lead_knee_angle", "lt", 138)], 80, 1500, 60, False),
        phase("bottom", "Lunge bottom (estimated contact)", "contact", [cond("lead_knee_angle", "lt", 125)], 60, 1500, 60, False, "unobserved"),
        phase("recovery", "Push back", "recovery", [cond("lead_knee_angle", "gt", 150)], 100, 3000, 100, True),
    ]
    return dyn_graph(mid, phases, "ready", "recovery", abort=4500, confirm=100, note="lunge seed thresholds (knee angle 148/138/125/150)")


def travel_graph(mid):
    phases = [
        phase("ready", "Ready", "rest", [cond("body_travel", "lt", 0.01)], 150, None, 120, True),
        phase("move", "Travel", "action", [cond("body_travel", "gt", 0.02)], 150, 4000, 80, False),
        phase("settle", "Settle and square up", "recovery", [cond("body_travel", "lt", 0.012)], 120, 3000, 120, True),
    ]
    return dyn_graph(mid, phases, "ready", "settle", window=4000, abort=7000, note="travel seed: hip variability thresholds 0.010/0.020/0.012 image units")


def split_graph(mid):
    phases = [
        phase("ready", "Ready", "rest", [cond("body_motion", "lt", 0.006)], 150, None, 150, True),
        phase("hop", "Hop", "action", [cond("hip_vertical_velocity", "abs_gt", 0.25)], 60, 800, 40, False),
        phase("land", "Land", "recovery", [cond("body_motion", "lt", 0.01)], 100, 1500, 100, True),
    ]
    return dyn_graph(mid, phases, "ready", "land", window=2000, abort=3000, note="split-step seed")


def recovery_graph(mid):
    phases = [
        phase("displaced", "Away from the T", "preparation", [cond("body_travel", "gt", 0.02)], 100, None, 60, False),
        phase("recovering", "Moving back", "recovery", [cond("body_travel", "lt", 0.012)], 100, 3000, 100, True),
        phase("ready", "Ready", "rest", [cond("body_travel", "lt", 0.006), cond("max_knee_angle", "lt", 175)], 150, None, 150, True),
    ]
    return dyn_graph(mid, phases, "displaced", "ready", abort=5000, note="recovery seed; the T position itself needs court calibration")


def compound_recovery_graph(mid, primitive, variant):
    """Keep the named action and observe its recovery separately from arm settling."""
    g = stroke_graph(mid, variant) if primitive == "stroke" else lunge_graph(mid)
    if primitive == "stroke":
        # An arm that has stopped swinging has not demonstrated a recovery.
        # Reuse the authored travel onset, followed by a separate still endpoint.
        g["phases"][-1] = phase("recovery", "Recovery movement", "recovery", [cond("body_travel", "gt", 0.02)], 100, 4000, 80, False)
    g["phases"].append(phase("recovered_ready", "Ready after recovery", "rest", [cond("body_travel", "lt", 0.006), cond("max_knee_angle", "lt", 175)], 150, None, 150, True))
    g["edges"] = chain([p["id"] for p in g["phases"]])
    g["terminal"] = ["recovered_ready"]
    g["allow_skip"] = False
    g["window_ms"] = 6000
    g["abort_timeout_ms"] += 4000
    g["note"] += "; named compound preserves action then observed recovery then ready; no claim of reaching the court T without calibration"
    return g


def static_graph(mid, extra_conditions=(), name="Hold"):
    return {"id": f"pg.{mid}", "movement_id": mid, "kind": "static_hold", "window_ms": 1500, "confirm_hold_ms": 600,
            "phases": [phase("hold", name, "hold", [cond("body_motion", "lt", 0.006)] + list(extra_conditions), 600, None, 600, True)],
            "edges": [], "initial": "hold", "terminal": ["hold"], "validation_status": "provisional", "note": "TODO_REQUIRES_VALIDATION: stillness and posture thresholds are seeds."}


# ---------------------------------------------------------------- template assignment from the catalog instruction
STATIC_BY_INSTRUCTION = [
    ("Keep knees soft", "ready"), ("Stand with feet set", "neutral"), ("Face more toward the play", "ready"),
    ("Turn the body side-on", "hitting"), ("Turn the torso and draw", "preparation"), ("Position the body on the", "hitting"),
    ("Lower the center of mass", "defensive"), ("Shift weight forward", "attacking"), ("Step into the named low reach", "lunge_hold"),
    ("Extend toward the ball", "reach_hold"), ("Freeze after contact", "follow_through"),
]
DYNAMIC_BY_INSTRUCTION = [
    ("Meet the ball before it bounces", ("stroke", "volley")), ("Open the racket face", ("stroke", "lob")),
    ("Use a short, controlled racket path", ("stroke", "drop")), ("Swing the racket forward", ("stroke", "drive")),
    ("Turn to the forehand side", ("stroke", "drive")), ("Turn to the backhand side", ("stroke", "drive")),
    ("Move toward the forehand side", ("stroke", "drive")), ("Move toward the backhand side", ("stroke", "drive")),
    ("Redirect the racket", ("stroke", "drive")), ("Step into the named lunge", ("lunge", None)),
    ("Push back toward the ready area", ("recovery", None)), ("Plant and turn", ("travel", None)),
    ("Push off rapidly", ("travel", None)), ("Shorten the steps", ("travel", None)), ("Step sideways", ("travel", None)),
    ("Travel in the named direction", ("travel", None)),
]


def compound_template_for(m: dict):
    """Names specify composition; imported generic instructions only describe its tail."""
    if m["movement_type"] != "dynamic":
        return None
    parts = re.split(r"\s*(?:\+|→|->)\s*", m["name"].lower())
    if len(parts) != 2 or parts[1] != "recovery":
        return None
    action = parts[0]
    if action == "lunge":
        return "lunge_recovery", None
    if re.search(r"\b(swing|shot|forehand|backhand|volley|attack)\b", action):
        variant = "volley" if "volley" in action else "drop" if "drop" in action else "lob" if "lob" in action else "drive"
        return "stroke_recovery", variant
    return None


def named_action_template_for(m: dict):
    compound = compound_template_for(m)
    if compound:
        return compound
    # Two imported shot labels inherited a generic travel instruction. A shot
    # still needs the arm-action profile; ordinary court travel is unchanged.
    if m["movement_type"] == "dynamic" and m["instruction"].startswith("Travel in the named direction") and re.search(r"\bshot\b", m["name"].lower()):
        return "stroke", "drive"
    return None


def template_for(m: dict):
    name = m["name"].lower()
    ins = m["instruction"]
    if m["movement_type"] == "static":
        for prefix, t in STATIC_BY_INSTRUCTION:
            if ins.startswith(prefix):
                return t, None
        # "Hold the named body and racket position ..." -> read the name
        if "lunge" in name:
            return "lunge_hold", None
        if "reach" in name:
            return "reach_hold", None
        if "follow-through" in name:
            return "follow_through", None
        if "balance" in name:
            return "balance_hold", None
        if any(w in name for w in ("hitting", "pose", "kill-shot", "shot position")):
            return "hitting", None
        if "defensive" in name:
            return "defensive", None
        return "ready", None
    named_action = named_action_template_for(m)
    if named_action:
        return named_action
    if ins.startswith("Move from"):
        target = re.sub(r".*→", "", m["name"]).strip().lower()
        source = m["name"].split("→")[0].strip().lower()
        if target in ("t", "recovery", "recovery stance") or source in ("shot", "lunge", "forehand", "backhand", "volley", "hitting position"):
            return "recovery", None
        return "travel", None
    if ins.startswith("Perform the named footwork"):
        if "split" in name:
            return "split", None
        if "reach" in name:
            return "lunge", None
        if "swing" in name:
            return "stroke", "drive"
        return "travel", None
    for prefix, t in DYNAMIC_BY_INSTRUCTION:
        if ins.startswith(prefix):
            return t
    return "travel", None


# ---------------------------------------------------------------- criteria and shared cues
def criterion(cid, mid, phases, feats, ev, error_id, sev="medium", weight=1.0, views="any", policy="not_assessable", cite=CITE_COACH, caps=None, selector=None, context="any", desc=None):
    c = {"criterion_id": cid, "movement_id": mid, "phase_ids": phases, "required_features": feats, "evaluator": ev, "technique_variant": None,
         "view_constraints": views, "missing_data_policy": policy, "severity": sev, "weight": weight, "expert_citation": cite, "athlete_context": context,
         "requires_capabilities": caps or ["body_pose"], "validation_status": "provisional", "validation_version": "0.2-seed", "error_id": error_id}
    if selector:
        c["feature_selector"] = selector
    if desc:
        c["description"] = desc
    return c


CUES = {}


def cue(key, text, rationale, sev="medium", positive=None, cooldown=8000, persistence=2):
    eid = f"{SPORT}.cue.{key}"
    if eid not in CUES:
        e = {"error_id": eid, "cue": {"en": text}, "rationale": {"en": rationale}, "demonstration_ref": None, "review_status": "draft", "cooldown_ms": cooldown, "persistence_count": persistence, "severity": sev}
        if positive:
            e["positive_cue"] = {"en": positive}
        CUES[eid] = e
    return eid


def static_criteria(mid, tmpl, ref_model):
    C = []
    hold = ["hold"]
    knees = lambda limit, key="knees_too_straight", text="Soften your knees so you can push off either way.": C.append(criterion(  # noqa: E731
        f"{mid}.knee_flexion", mid, hold, ["max_knee_angle"], {"kind": "max_value", "aggregate": "window_mean", "limit": limit, "tolerance": 8}, cue(key, text, "Straight knees delay the first step.", positive="Nice loaded knees."), desc="Knees flexed in this position."))
    width = lambda lo, hi: C.append(criterion(  # noqa: E731
        f"{mid}.stance_width", mid, hold, ["stance_width_ratio"], {"kind": "range", "aggregate": "window_mean", "range": [lo, hi], "tolerance": 0.3}, cue("stance_width", "Adjust your base: feet about shoulder-width apart or a little wider.", "A balanced base lets you move to any corner.", positive="Good base width."), views=["front", "back"]))
    racket_up = lambda limit: C.append(criterion(  # noqa: E731
        f"{mid}.racket_up", mid, hold, ["dominant_wrist_rel_y"], {"kind": "max_value", "aggregate": "window_mean", "limit": limit, "tolerance": 0.2}, cue("racket_hand_low", "Keep the racket up and in front.", "A low racket costs preparation time on the next shot.", sev="low"), sev="low", weight=0.75, desc="Racket hand not hanging low."))
    balance = lambda limit=12: C.append(criterion(  # noqa: E731
        f"{mid}.balance", mid, hold, ["trunk_lateral_lean"], {"kind": "max_abs", "aggregate": "window_mean", "limit": limit, "tolerance": 6}, cue("trunk_lateral_lean", "Keep your shoulders level over your hips.", "Lateral lean shifts weight off the balls of the feet.", sev="low"), sev="low", weight=0.5, views=["front", "back"]))
    if tmpl in ("ready", "neutral"):
        knees(165 if tmpl == "ready" else 172); width(1.0, 1.9); racket_up(0.35); balance()
    elif tmpl == "defensive":
        knees(155, "stay_low", "Sit lower: bend the knees and keep the racket compact."); width(1.2, 2.2); racket_up(0.35); balance()
    elif tmpl == "attacking":
        knees(162); racket_up(0.15); balance()
    elif tmpl == "preparation":
        knees(165)
        C.append(criterion(f"{mid}.racket_prepared", mid, hold, ["dominant_wrist_rel_y"], {"kind": "max_value", "aggregate": "window_mean", "limit": -0.05, "tolerance": 0.2}, cue("late_preparation", "Get the racket up and back before the ball arrives.", "Early preparation turns a rushed hit into a controlled downswing.", positive="Nice early preparation."), weight=1.5, desc="Racket hand raised to about shoulder height or above."))
        balance()
    elif tmpl == "hitting":
        C.append(criterion(f"{mid}.lead_knee_flexed", mid, hold, ["lead_knee_angle"], {"kind": "range", "aggregate": "window_mean", "range": [90, 155], "tolerance": 15}, cue("no_knee_bend", "Bend the front knee and get down to the ball.", "Hitting from an upright stance loses reach and control.", positive="Good low position."), cite=CITE_LUNGE, desc="Front knee flexed in the hitting position."))
        balance(15)
    elif tmpl == "lunge_hold":
        C.append(criterion(f"{mid}.lead_knee_depth", mid, hold, ["lead_knee_angle"], {"kind": "range", "aggregate": "window_mean", "range": [80, 120], "tolerance": 15}, cue("lead_knee_depth", "Let the front knee load to about a right angle.", "A deep, controlled lunge drops the hips and reaches the ball with balance.", positive="Good lunge depth."), weight=1.5, cite=CITE_LUNGE))
        C.append(criterion(f"{mid}.knee_foot_alignment", mid, hold, ["left_knee_ankle_offset_x", "right_knee_ankle_offset_x", "left_knee_angle", "right_knee_angle"], {"kind": "max_abs", "aggregate": "window_mean", "limit": 0.25, "tolerance": 0.15},
                           cue("knee_not_over_foot", "Keep your front knee over your foot.", "The knee finishing above the ankle protects the joint and lets you push back.", sev="high", positive="Knee lined up well."), sev="high", weight=2.0, views=["front", "back"], cite=CITE_LUNGE,
                           selector={"mode": "key_min", "candidates": ["left_knee_ankle_offset_x", "right_knee_ankle_offset_x"], "keys": ["left_knee_angle", "right_knee_angle"]}))
        C.append(criterion(f"{mid}.trunk_forward_lean", mid, hold, ["trunk_forward_lean"], {"kind": "max_abs", "aggregate": "window_mean", "limit": 40, "tolerance": 10}, cue("excessive_trunk_lean", "Stay taller through the chest as you reach.", "Excess forward lean slows the push back."), views=["left", "right"]))
    elif tmpl == "reach_hold":
        C.append(criterion(f"{mid}.lead_knee_flexed", mid, hold, ["lead_knee_angle"], {"kind": "max_value", "aggregate": "window_mean", "limit": 140, "tolerance": 15}, cue("no_knee_bend", "Bend the front knee and get down to the ball.", "Hitting from an upright stance loses reach and control.", positive="Good low position."), cite=CITE_LUNGE))
        C.append(criterion(f"{mid}.torso_not_collapsed", mid, hold, ["trunk_forward_lean"], {"kind": "max_abs", "aggregate": "window_mean", "limit": 45, "tolerance": 10}, cue("torso_collapsed", "Reach with the arm and legs, not by folding the torso.", "A collapsed torso makes the push back slower and less balanced."), views=["left", "right"]))
    elif tmpl == "follow_through":
        C.append(criterion(f"{mid}.follow_through_height", mid, hold, ["dominant_wrist_rel_y"], {"kind": "max_value", "aggregate": "window_mean", "limit": 0.1, "tolerance": 0.3}, cue("low_follow_through", "Finish the swing high toward your target.", "A high follow-through keeps length on drives and lobs.", sev="low"), sev="low", weight=0.75))
        balance(15)
    elif tmpl == "balance_hold":
        balance(10)
    if ref_model:
        C.append(criterion(f"{mid}.expert_reference", mid, hold, list(REFERENCE_FEATURES), {"kind": "reference_nearest", "aggregate": "window_mean", "model_reference": ref_model, "min_confidence": 0.5},
                           cue("posture_vs_reference", "Match the reference position more closely: check knee bend and arm position.", "This compares your joint angles with the recorded expert position for the same camera view.", positive="Close to the reference position."),
                           weight=1.0, policy="uncertain", cite=CITE_DATA, desc="Joint angles compared with the recorded expert captures of this position (nearest same-view reference, weighted RMS in degrees)."))
    return C


def dynamic_criteria(mid, tmpl, variant):
    compound = tmpl in ("stroke_recovery", "lunge_recovery")
    if compound:
        tmpl = tmpl.removesuffix("_recovery")
    C = []
    if tmpl == "lunge":
        C.append(criterion(f"{mid}.lead_knee_depth", mid, ["bottom"], ["lead_knee_angle"], {"kind": "range", "aggregate": "phase_min", "range": [80, 120], "tolerance": 15}, cue("lead_knee_depth", "Lunge a little longer and let the front knee load to about a right angle.", "A deep, controlled lunge drops the hips and reaches the ball with balance.", positive="Good lunge depth."), weight=1.5, cite=CITE_LUNGE, desc="Lead knee near a right angle at the bottom of the lunge."))
        C.append(criterion(f"{mid}.knee_foot_alignment", mid, ["bottom"], ["left_knee_ankle_offset_x", "right_knee_ankle_offset_x", "left_knee_angle", "right_knee_angle"], {"kind": "max_abs", "aggregate": "phase_mean", "limit": 0.25, "tolerance": 0.15},
                           cue("knee_not_over_foot", "Keep your front knee over your foot as you lunge.", "The knee finishing above the ankle protects the joint and lets you push back.", sev="high", positive="Knee lined up well."), sev="high", weight=2.0, views=["front", "back"], cite=CITE_LUNGE,
                           selector={"mode": "key_min", "candidates": ["left_knee_ankle_offset_x", "right_knee_ankle_offset_x"], "keys": ["left_knee_angle", "right_knee_angle"]}, desc="Lead knee finishes above the ankle, not pushed beyond the toes."))
        C.append(criterion(f"{mid}.trunk_forward_lean", mid, ["bottom"], ["trunk_forward_lean"], {"kind": "max_abs", "aggregate": "phase_max", "limit": 35, "tolerance": 10}, cue("excessive_trunk_lean", "Stay taller through the chest as you reach.", "Excess forward lean slows the push back."), views=["left", "right"]))
        C.append(criterion(f"{mid}.recovery_time", mid, ["recovery"], [], {"kind": "phase_duration", "aggregate": "phase_end", "limit": 1200, "tolerance": 400, "params": {"phase_id": "recovery", "from_phase_id": "bottom", "measure": "since_phase_start"}}, cue("slow_recovery", "Push back off the front leg and recover faster.", "Quick recovery keeps every corner in reach.", sev="low", positive="Quick recovery."), sev="low", weight=0.75, cite=CITE_T, desc="Time from reaching the bottom of the lunge until standing back up (recovery phase entered)."))
        C.append(criterion(f"{mid}.sequencing", mid, ["bottom", "recovery"], ["stroke_sequencing"], {"kind": "ordering", "aggregate": "latest", "limit": 1.0, "expected_order": ["lead_knee_angle", "dominant_elbow_angle"]}, cue("arm_before_legs", "Let the legs lead; the racket arm comes through last.", "Leg-first sequencing transfers power and keeps balance.", sev="low"), sev="low", weight=0.5, policy="uncertain", context=["intermediate", "advanced"]))
    elif tmpl == "split":
        C.append(criterion(f"{mid}.landing_width", mid, ["land"], ["stance_width_ratio"], {"kind": "range", "aggregate": "phase_mean", "range": [1.0, 2.0], "tolerance": 0.3}, cue("landing_width", "Land the split step with your feet about shoulder-width apart.", "A balanced landing lets you push off in any direction."), views=["front", "back"]))
        C.append(criterion(f"{mid}.landing_knees", mid, ["land"], ["max_knee_angle"], {"kind": "max_value", "aggregate": "phase_mean", "limit": 165, "tolerance": 8}, cue("landing_knees_straight", "Land softer with bent knees so you are loaded to move.", "Stiff landings lose the elastic push-off.")))
    elif tmpl == "recovery":
        C.append(criterion(f"{mid}.recovery_time", mid, ["recovering"], [], {"kind": "phase_duration", "aggregate": "phase_end", "limit": 1500, "tolerance": 500, "params": {"phase_id": "ready", "from_phase_id": "recovering", "measure": "since_phase_start"}}, cue("slow_recovery", "Get back quicker after the shot.", "From the T every corner is reachable.", sev="low", positive="Good recovery."), sev="low", cite=CITE_T, desc="Time from starting to move back until ready again."))
        C.append(criterion(f"{mid}.ready_knees", mid, ["ready"], ["max_knee_angle"], {"kind": "max_value", "aggregate": "phase_mean", "limit": 165, "tolerance": 8}, cue("knees_too_straight", "Soften your knees once you are back.", "Loaded knees shorten the next first step.")))
    elif tmpl == "travel":
        C.append(criterion(f"{mid}.stay_low_moving", mid, ["move"], ["max_knee_angle"], {"kind": "max_value", "aggregate": "phase_mean", "limit": 168, "tolerance": 8}, cue("upright_while_moving", "Stay low as you move: keep the knees bent.", "A low centre lets you stop and change direction quickly.", positive="Nice low movement."), desc="Knees stay flexed during the travel phase."))
        C.append(criterion(f"{mid}.balanced_arrival", mid, ["settle"], ["trunk_lateral_lean"], {"kind": "max_abs", "aggregate": "phase_mean", "limit": 15, "tolerance": 8}, cue("off_balance_arrival", "Arrive balanced: shoulders level over the hips.", "A balanced arrival lets you hit or push off immediately.", sev="low"), sev="low", weight=0.75, views=["front", "back"]))
        C.append(criterion(f"{mid}.ready_on_arrival", mid, ["settle"], ["max_knee_angle"], {"kind": "max_value", "aggregate": "phase_mean", "limit": 165, "tolerance": 8}, cue("knees_too_straight", "Soften your knees once you are back.", "Loaded knees shorten the next first step."), weight=0.75))
        C.append(criterion(f"{mid}.travel_time", mid, ["settle"], [], {"kind": "phase_duration", "aggregate": "phase_end", "limit": 2500, "tolerance": 800, "params": {"phase_id": "settle", "from_phase_id": "move", "measure": "since_phase_start"}}, cue("slow_travel", "Move with quicker, shorter steps.", "Shorter steps get you there sooner and balanced.", sev="low"), sev="low", weight=0.5, desc="Time from starting to move until settled (seed limit; depends on the distance covered)."))
    else:  # stroke
        prep_limit = STROKE_PARAMS[variant]["prep_height"] + 0.05
        C.append(criterion(f"{mid}.early_preparation", mid, ["preparation", "swing"], ["dominant_wrist_rel_y"], {"kind": "max_value", "aggregate": "phase_min", "limit": prep_limit, "tolerance": 0.2}, cue("late_preparation", "Get the racket up earlier, before the ball arrives.", "Early preparation turns a rushed hit into a controlled downswing.", positive="Nice early preparation."), weight=1.5, views=STROKE_VIEWS, desc="Racket hand raised above shoulder level before the swing starts."))
        C.append(criterion(f"{mid}.head_stillness", mid, ["swing", "estimated_contact"], ["head_stability"], {"kind": "stability", "aggregate": "latest", "limit": 0.012, "tolerance": 0.01, "min_confidence": 0.6}, cue("head_moving", "Keep your head still through contact.", "A still head keeps the eyes on the ball and the body balanced.", sev="low"), sev="low", weight=0.75, policy="uncertain"))
        C.append(criterion(f"{mid}.balance", mid, ["swing", "estimated_contact", "follow_through"], ["trunk_lateral_lean"], {"kind": "max_abs", "aggregate": "phase_max", "limit": 20, "tolerance": 10}, cue("off_balance", "Stay balanced over your front foot through the shot.", "Leaning sideways through contact costs accuracy and recovery speed.", sev="low"), sev="low", weight=0.5, views=["front", "back"]))
        C.append(criterion(f"{mid}.lunge_into_shot", mid, ["swing", "estimated_contact"], ["lead_knee_angle"], {"kind": "range", "aggregate": "phase_min", "range": [90, 155], "tolerance": 15}, cue("no_knee_bend", "Bend the front knee and get down to the ball.", "Hitting from an upright stance loses reach and control.", positive="Good low position at contact."), cite=CITE_LUNGE, desc="Front knee flexed at contact rather than hitting from an upright stance."))
        C.append(criterion(f"{mid}.swing_smoothness", mid, ["swing", "estimated_contact", "follow_through"], ["dominant_wrist_jerk"], {"kind": "max_value", "aggregate": "phase_mean", "limit": 600, "tolerance": 400, "min_confidence": 0.6}, cue("jerky_swing", "Smooth the swing: one continuous motion from preparation to follow-through.", "Smooth acceleration gives repeatable contact.", sev="low"), sev="low", weight=0.5, policy="uncertain", cite=CITE_KIN))
        C.append(criterion(f"{mid}.recovery_time", mid, ["recovery"], [], {"kind": "phase_duration", "aggregate": "phase_end", "limit": 1500, "tolerance": 500, "params": {"phase_id": "recovery", "from_phase_id": "estimated_contact", "measure": "since_phase_start"}}, cue("slow_recovery_after_shot", "After the shot, move straight back toward the T.", "Recovering to the T keeps every corner in reach.", sev="low", positive="Good recovery to the T."), sev="low", weight=0.75, cite=CITE_T, desc="Time from estimated contact until still again (recovery phase entered)."))
        C.append(criterion(f"{mid}.sequencing", mid, ["estimated_contact", "follow_through"], ["stroke_sequencing"], {"kind": "ordering", "aggregate": "latest", "limit": 1.0, "expected_order": ["lead_knee_angle", "dominant_elbow_angle"]}, cue("arm_before_legs", "Let the legs lead; the racket arm comes through last.", "Leg-first sequencing transfers power and keeps balance.", sev="low"), sev="low", weight=0.5, policy="uncertain", context=["intermediate", "advanced"]))
        if variant == "drop":
            C.append(criterion(f"{mid}.controlled_swing_speed", mid, ["swing"], ["dominant_elbow_velocity"], {"kind": "max_value", "aggregate": "phase_max", "limit": 400, "tolerance": 200}, cue("swing_too_fast", "Slow the swing and push the ball into the corner.", "The drop is a controlled push, not a hit.", positive="Soft hands on the drop."), cite=CITE_KIN))
        if variant in ("drive", "lob", "serve"):
            C.append(criterion(f"{mid}.follow_through_height", mid, ["follow_through"], ["dominant_wrist_rel_y"], {"kind": "max_value", "aggregate": "phase_min", "limit": 0.1, "tolerance": 0.3}, cue("low_follow_through", "Finish the swing high toward your target.", "A high follow-through keeps length on drives and lobs.", sev="low"), sev="low", weight=0.5, views=STROKE_VIEWS))
        C.append(criterion(f"{mid}.racket_contact_height", mid, ["estimated_contact"], [], {"kind": "equipment_dependent", "aggregate": "phase_end", "params": {"requires_contact": True, "equipment": "racket", "measurement_unit": "normalized"}}, cue("contact_height", "Meet the ball at a consistent height.", "Shown only when racket tracking evidence exists."), caps=["optional_implement"],
                           cite={"source": "TODO_REQUIRES_VALIDATION: requires racket tracking adapter and coach review", "status": "provisional"}, desc="Racket head height at estimated contact; abstains without the implement adapter."))
        if variant == "serve":
            C.append(criterion(f"{mid}.foot_in_box", mid, ["estimated_contact"], [], {"kind": "equipment_dependent", "aggregate": "phase_end", "params": {"equipment": "court_lines", "measurement_unit": "m"}}, cue("foot_fault_risk", "Keep one foot clearly inside the service box as you strike the serve.", "Rule 5.7.2 requires one foot inside the box with no part touching a boundary line."), caps=["calibrated_scale"],
                               cite={"source": "WSF Rules 2025 5.7.2 (one foot inside the service box at contact); adjudication needs calibrated court lines", "status": "provisional"}, desc="Distance of the planted foot from the service box boundary at contact; needs court-line calibration. Never a fault call."))
    if compound:
        for c in C:
            if c["criterion_id"].endswith(".recovery_time"):
                c["phase_ids"] = ["recovery"]
                c["evaluator"]["params"]["phase_id"] = "recovered_ready"
                c["evaluator"]["params"]["from_phase_id"] = "follow_through" if tmpl == "stroke" else "bottom"
                c["description"] = "Time from the observed action endpoint until ready after the separately observed recovery; court T position is not inferred."
        C.append(criterion(f"{mid}.ready_knees", mid, ["recovered_ready"], ["max_knee_angle"], {"kind": "max_value", "aggregate": "phase_mean", "limit": 165, "tolerance": 8}, cue("knees_too_straight", "Soften your knees once you are back.", "Loaded knees shorten the next first step.")))
    return C


def dynamic_graph(mid, tmpl, variant):
    if tmpl in ("stroke_recovery", "lunge_recovery"):
        return compound_recovery_graph(mid, tmpl.removesuffix("_recovery"), variant)
    return {"stroke": lambda: stroke_graph(mid, variant), "lunge": lambda: lunge_graph(mid), "travel": lambda: travel_graph(mid),
            "split": lambda: split_graph(mid), "recovery": lambda: recovery_graph(mid)}[tmpl]()


def movement_description(m):
    compound = compound_template_for(m)
    if not compound:
        if named_action_template_for(m):
            return f"Perform the {m['name'].lower()} with racket preparation, a controlled swing and balanced follow-through, then recover. Body pose can assess technique geometry; racket and ball contact need equipment evidence."
        return m["instruction"]
    action = re.split(r"\s*(?:\+|→|->)\s*", m["name"])[0]
    return f"Perform the {action.lower()}, then recover and finish in a balanced ready stance with soft knees. Body-position feedback covers the action and recovery; reaching the court T requires court calibration."


# ---------------------------------------------------------------- human variance (sport-specific; the core is inert)
HUMAN_VARIANCE = {
    "relative": 0.05,
    "measurement_floor": {"deg": 5, "deg_per_s": 25, "normalized": 0.03, "normalized_per_s3": 2, "ratio": 0.05, "ms": 80, "score": 0.1},
    "context_scale": {"novice": 1.5, "intermediate": 1.0, "advanced": 0.8, "unknown": 1.0},
    "consistency": {"enabled": True, "window": 8, "min_reps": 3, "k_sd": 2.0, "fail_fraction": 0.5},
    "validation_status": "provisional",
    "note": "TODO_REQUIRES_VALIDATION: squash variance profile seeded from the racket-sport variability literature; per-criterion allowances are to be fitted on repeated executions in the recordings.",
}
VARIANCE_BY_FAMILY = [
    (("stance_width", "landing_width"), 0.10),
    (("early_preparation", "racket_up", "racket_prepared", "follow_through_height", "racket_hand"), 0.15),
    (("swing_smoothness", "head_stillness", "controlled_swing_speed", "jerky"), 0.20),
    (("recovery_time", "travel_time"), 0.10),
    (("sequencing",), 0.10),
    (("expert_reference",), 0.10),
    (("knee_foot_alignment",), 0.05),
]


def variance_allowance(criterion_id: str, kind: str) -> float:
    for keys, value in VARIANCE_BY_FAMILY:
        if any(k in criterion_id for k in keys):
            return value
    return 0.10 if kind == "equipment_dependent" else 0.05


# ---------------------------------------------------------------- legacy seed ids (kept resolvable for stored sessions and drills)
LEGACY_ALIASES = {
    "squash.static.0056": ["squash.ready_position_t", "ready position", "T position"],
    "squash.dynamic.0009": ["squash.split_step", "split step"],
    "squash.dynamic.0021": ["squash.lunge", "lunge"],
    "squash.dynamic.0031": ["squash.forehand_drive"],
    "squash.dynamic.0041": ["squash.backhand_drive"],
    "squash.dynamic.0034": ["squash.forehand_volley"],
    "squash.dynamic.0044": ["squash.backhand_volley"],
    "squash.dynamic.0035": ["squash.forehand_drop"],
    "squash.dynamic.0045": ["squash.backhand_drop"],
    "squash.dynamic.0052": ["squash.boast", "boast"],
    "squash.dynamic.0053": ["squash.lob", "lob"],
    "squash.dynamic.0015": ["squash.recovery_to_t", "recovery to the T"],
}
# Movements the sport needs that the capture catalog does not contain yet.
PACK_ONLY = [
    {"movement_id": "squash.serve", "name": "Serve", "movement_type": "dynamic", "category": "Serve and return", "instruction": "Serve from the service box with one foot inside the box at contact, striking the front wall between the service line and the out line.", "template": ("stroke", "serve")},
    {"movement_id": "squash.return_of_serve", "name": "Return of serve", "movement_type": "dynamic", "category": "Serve and return", "instruction": "Return the serve, often on the volley, from the back quarter with early preparation.", "template": ("stroke", "volley")},
]


def graph_template(g):
    ids = {p["id"] for p in g["phases"]}
    if g["kind"] == "static_hold":
        return "static"
    for key, t in (("swing", "stroke"), ("bottom", "lunge"), ("move", "travel"), ("hop", "split"), ("displaced", "recovery")):
        if key in ids:
            return t
    return "other"


def load_phase_calibration(max_specificity_loss=0.05):
    """Accepted per-template threshold adjustments from tools/calibrate_phase_graphs.ts (expert recordings, no phase labels).
    An adjustment is accepted only if it does not raise activation on other templates' clips by more than
    max_specificity_loss; the report is kept so the decision is auditable."""
    path = KIT / "phase_calibration.json"
    if not path.exists():
        return {}, {}
    rep = json.loads(path.read_text(encoding="utf-8"))
    accepted, decisions = {}, {}
    for t, r in rep.get("templates", {}).items():
        b, best = r["baseline"], r["best"]
        ok = best["adjust"] and best["foreign_activation"] <= b["foreign_activation"] + max_specificity_loss and best["sensitivity"] > b["sensitivity"]
        decisions[t] = {"accepted": bool(ok), "adjust": best["adjust"], "sensitivity": [round(b["sensitivity"], 3), round(best["sensitivity"], 3)], "foreign_activation": [round(b["foreign_activation"], 3), round(best["foreign_activation"], 3)]}
        if ok:
            accepted[t] = best["adjust"]
    return accepted, decisions


def apply_phase_calibration(g, accepted, decisions):
    t = graph_template(g)
    adj = accepted.get(t)
    if not adj:
        return g
    for ph in g["phases"]:
        for c in ph["enter"]:
            a = adj.get(c["feature"])
            if a and isinstance(c["value"], (int, float)):
                c["value"] = round(c["value"] * a.get("scale", 1) + a.get("offset", 0), 4)
    d = decisions[t]
    g["note"] = (g.get("note", "") + f" Calibrated on the expert recordings (key-phase activation {d['sensitivity'][0]:.2f} -> {d['sensitivity'][1]:.2f}, "
                 f"other movements {d['foreign_activation'][0]:.2f} -> {d['foreign_activation'][1]:.2f}; tools/calibrate_phase_graphs.ts). Still provisional: no phase labels exist.").strip()
    return g


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def rms(a, b, w):
    num = den = 0.0
    for x, y, k in zip(a, b, w):
        if x is None or y is None:
            continue
        num += k * (x - y) ** 2
        den += k
    return math.sqrt(num / den) if den else None


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    (KIT / "reference_feature_specs.json").write_text(json.dumps({"features": FEATURES, "reference_features": REFERENCE_FEATURES}, indent=1) + "\n", encoding="utf-8")
    src = json.loads((KIT / "source_catalog.json").read_text(encoding="utf-8"))
    tax = json.loads((KIT / "taxonomy.json").read_text(encoding="utf-8"))
    sim = json.loads((KIT / "similarity_report.json").read_text(encoding="utf-8"))
    refs_path = KIT / "reference_vectors.json"
    refs = json.loads(refs_path.read_text(encoding="utf-8")) if refs_path.exists() else None
    catalog = {m["movement_id"]: m for m in src["movements"]}
    coverage = {**sim["static"]["view_coverage"], **sim["dynamic"]["view_coverage"]}
    neighbours = {**sim["static"]["neighbours"], **sim["dynamic"]["neighbours"]}

    # ---- taxonomy: data families + uncovered catalog movements + pack-only movements
    families = []
    placement = {}
    for fam in tax["families"]:
        groups = [{"id": g["id"], "name": g["name"], "members": list(g["members"]), "evidence": {"pose_within_mean": g.get("pose_within_mean")}} for g in fam["groups"]]
        families.append({"id": fam["id"], "name": fam["name"], "type": fam["type"], "description": fam.get("description"), "groups": groups,
                         "evidence": {**fam["evidence"], "medoid": fam.get("medoid"), "name_source": fam.get("name_source"), "generated_name": fam.get("generated_name")}})
    # uncovered: nearest family by shared catalog category / name words (no pose data to measure)
    def words(m):
        return set(re.findall(r"[a-z]+", (m["name"] + " " + m["category"]).lower())) - {"movement", "movements", "stance", "squash", "the"}
    for u in tax["uncovered"]:
        # Refreshed hierarchies include catalogue-only labels in explicit semantic groups.
        if any(u["movement_id"] in g["members"] for fm in families for g in fm["groups"]):
            continue
        m = catalog[u["movement_id"]]
        cands = [fm for fm in families if fm["type"] == m["movement_type"]]
        best = max(cands, key=lambda fm: (sum(len(words(m) & words(catalog[x])) for g in fm["groups"] for x in g["members"] if x in catalog) / max(1, sum(len(g["members"]) for g in fm["groups"]))))
        gid = f"{best['id'].replace('squash.family.', 'squash.group.')}.awaiting_capture"
        grp = next((g for g in best["groups"] if g["id"] == gid), None)
        if not grp:
            grp = {"id": gid, "name": "Awaiting usable recordings", "members": [], "evidence": {"note": "placed by label words only; no usable pose capture"}}
            best["groups"].append(grp)
        grp["members"].append(m["movement_id"])
    serve_family = {"id": "squash.family.dynamic.serve_and_return", "name": "Serve and return (not yet captured)", "type": "dynamic",
                    "description": "Serve and return of serve: required by the WSF rules but not yet in the capture catalog; coached from seed templates until recordings exist.",
                    "groups": [{"id": "squash.group.dynamic.serve_and_return.all", "name": "Serve and return", "members": [p["movement_id"] for p in PACK_ONLY]}], "evidence": {"note": "pack-defined; no capture data"}}
    families.append(serve_family)
    for fam in families:
        for g in fam["groups"]:
            for mid in g["members"]:
                placement[mid] = (fam["id"], g["id"])

    # ---- reference models for static movements
    models = []
    model_files = {}
    ref_vectors = (refs or {}).get("vectors", {})
    if refs:
        assert refs["features"] == REFERENCE_FEATURES, "reference_vectors.json was extracted with a different feature list; re-run tools/extract_reference_vectors.ts"
    discriminability = {}
    for mid, vecs in ref_vectors.items():
        if len(vecs) < 2:
            continue
        # nearest other movement's same-view reference (how separable this posture is from its neighbours)
        best = None
        for other, ovecs in ref_vectors.items():
            if other == mid:
                continue
            for a in vecs:
                for b in ovecs:
                    if a["view"] != b["view"]:
                        continue
                    d = rms(a["values"], b["values"], REFERENCE_WEIGHTS)
                    if d is not None and (best is None or d < best[0]):
                        best = (d, other)
        discriminability[mid] = best
        path = f"models/reference/{mid}.json"
        model_files[path] = {
            "kind": "reference_set", "movement_id": mid, "features": REFERENCE_FEATURES, "weights": REFERENCE_WEIGHTS,
            "reference_vectors": [[(x if x is not None else None) for x in v["values"]] for v in vecs],
            "reference_views": [v["view"] for v in vecs],
            "reference_handedness": [v.get("handedness", "unknown") for v in vecs],
            "reference_handedness_assumed": [v.get("handedness_assumed", True) for v in vecs],
            "unit": "deg",
            "threshold": 15.0, "tolerance": 10.0, "validation_status": "provisional",
            "nearest_other_movement": {"movement_id": best[1], "rms_deg": round(best[0], 1)} if best else None,
            "provenance": f"Expert-labeled captures ({len(vecs)} captures) from the squash Data Capture collection, extracted with the deployed feature engine after global pose-quality checks; source handedness is recorded per vector, never inferred. Unknown or assumed handedness blocks dominant-side reference assessment. Weighted RMS distance in degrees to the nearest same-view reference. One athlete: TODO_REQUIRES_VALIDATION.",
        }
        models.append({"role": "reference_set", "path": path, "version": V, "format": "json", "required": False})

    # ---- movements, graphs, criteria
    phase_accepted, phase_decisions = load_phase_calibration()
    movements, graphs, criteria = [], [], []
    ordered = [m for m in src["movements"] if m["movement_id"] in placement] + PACK_ONLY
    for m in ordered:
        mid = m["movement_id"]
        tmpl, variant = m.get("template") or template_for(m)
        static = m["movement_type"] == "static"
        ref_path = f"models/reference/{mid}.json" if f"models/reference/{mid}.json" in model_files else None
        if static:
            extra = []
            if tmpl in ("lunge_hold", "reach_hold"):
                vals = [v["values"][:2] for v in ref_vectors.get(mid, [])]
                lead = [min(x for x in pair if x is not None) for pair in vals if any(x is not None for x in pair)]
                ceiling = min(165.0, round(max(lead) + 20.0, 0)) if lead else 150.0
                extra.append(cond("lead_knee_angle", "lt", ceiling))
            else:
                extra.append(cond("max_knee_angle", "lt", 178))
            graphs.append(static_graph(mid, extra, name=m["name"]))
            cs = static_criteria(mid, tmpl, ref_path)
        else:
            g = dynamic_graph(mid, tmpl, variant)
            graphs.append(apply_phase_calibration(g, phase_accepted, phase_decisions))
            cs = dynamic_criteria(mid, tmpl, variant)
        criteria.extend(cs)
        fam_id, grp_id = placement[mid]
        cov = coverage.get(mid, {})
        if mid in catalog:
            data_status = "captured" if cov else "no_training_data"
        else:
            data_status = "no_capture_data"
        aliases = [{"name": a, "locale": "en", "status": "approved"} for a in LEGACY_ALIASES.get(mid, [])]
        aliases.append({"name": m["name"], "locale": "en", "status": "proposed"})  # names are not keys (catalog note)
        sim_edges = []
        seen = set()
        group_members = next(g for fam in families if fam["id"] == fam_id for g in fam["groups"] if g["id"] == grp_id)["members"]
        # Measured pose neighbours first (relation records the distance, and the shared group when there is one),
        # then the rest of the group, up to 6 hard negatives in total.
        for n in neighbours.get(mid, []):
            o = n["movement_id"]
            if o != mid and o not in seen:
                rel = f"pose_neighbour:{n['pose_distance']}" + (",same_group" if o in group_members else "")
                sim_edges.append({"movement_id": o, "relation": rel, "hard_negative": True}); seen.add(o)
        for other in group_members:
            if other != mid and other not in seen and len(sim_edges) < 6:
                sim_edges.append({"movement_id": other, "relation": "same_group", "hard_negative": True}); seen.add(other)
        desc = movement_description(m)
        if ref_path and discriminability.get(mid):
            d, other = discriminability[mid]
            desc += f" Nearest other recorded position: {catalog[other]['name']} ({d:.0f} deg RMS)."
        movements.append({
            "uuid": uid(mid), "id": mid, "canonical_name": m["name"], "aliases": aliases, "type": m["movement_type"],
            "permitted_views": ALL_VIEWS, "phase_graph_id": f"pg.{mid}", "required_capabilities": ["body_pose"],
            "criteria": [c["criterion_id"] for c in cs], "similar": sim_edges, "review_status": "coach_review_required",
            "description": desc, "family_id": fam_id, "group_id": grp_id, "data_status": data_status,
            "source": {"catalog_id": mid if mid in catalog else None, "catalog_version": src["version"] if mid in catalog else None, "category": m["category"], "instruction": m["instruction"],
                       "captures": int(sum(cov.values())) if cov else 0, "views": sorted(cov.keys())},
        })
        movements[-1]["source"] = {k: v for k, v in movements[-1]["source"].items() if v is not None}

    for c in criteria:
        c["evaluator"]["human_variance_relative"] = variance_allowance(c["criterion_id"], c["evaluator"]["kind"])

    taxonomy = {
        "version": tax.get("version", V), "levels": ["family", "group", "movement"], "validation_status": "provisional",
        "method": {k: v for k, v in tax["method"].items() if k != "datasets"},
        "recognition": {"group_threshold": 0.6, "family_threshold": 0.6, "margin": 0.1, "validation_status": "provisional"},
        "families": families,
    }

    generic = {k: {"en": v} for k, v in {
        "AMBIGUOUS_SUBJECT": "Two people are in view. Make sure only the practising player is on court in frame.",
        "FRAMING_INVALID": "Step back so your whole body, including your feet, is visible in the camera.",
        "MISSING_JOINT": "Some joints are hidden. Keep your full body in view, racket arm included.",
        "LOW_CONFIDENCE": "Tracking is unsteady. Improve lighting and avoid standing in front of the glass reflections.",
        "VIEW_INVALID": "This check needs a different camera angle; it is paused for now.",
        "TIME_GAP": "Tracking paused. Resume when you are ready.",
        "TRACK_CHANGED": "Lost track of you for a moment. Checks restart now.",
        "HANDEDNESS_UNKNOWN": "Set your racket hand in the session setup to enable swing checks.",
        "CAPABILITY_MISSING": "Racket tracking is not active, so contact-height checks are off.",
        "CONTACT_UNOBSERVED": "Ball contact cannot be seen from body tracking alone.",
        "SAFETY": "Keep your training partner outside the swing arc and wear protective eyewear.",
        "WITHIN_NORMAL_VARIANCE": "That repetition was within your normal range of variation; no correction.",
        "MOVEMENT_NOT_CONFIRMED": "This looks like a different movement from your selected drill, so technique tips are paused. Switch drills or return to the selected movement.",
    }.items()}

    def dump(name, obj, indent=1):
        p = OUT / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, indent=indent, ensure_ascii=False) + "\n", encoding="utf-8")

    # remove stale reference models
    ref_dir = OUT / "models" / "reference"
    if ref_dir.exists():
        for old in ref_dir.glob("*.json"):
            if f"models/reference/{old.name}" not in model_files:
                old.unlink()
    for path, body in model_files.items():
        dump(path, body)
    dump("movement_catalog.json", {"schema_version": V, "sport_id": SPORT, "taxonomy": taxonomy, "movements": movements})
    dump("phase_graphs.json", {"schema_version": V, "sport_id": SPORT, "graphs": graphs})
    dump("technique_criteria.json", {"schema_version": V, "sport_id": SPORT, "rubric_version": V, "aggregation": {"method": "weighted_mean_of_valid_criteria", "minimum_coverage": 0.6, "human_variance": HUMAN_VARIANCE}, "features": FEATURES, "criteria": criteria})
    dump("feedback_templates.json", {"schema_version": V, "sport_id": SPORT, "catalog_version": V, "default_locale": "en", "policy": {"global_min_interval_ms": 6000, "positive_reinforcement_interval_ms": 15000, "max_secondary_queue": 3}, "entries": list(CUES.values()), "generic": generic})
    n_static = sum(1 for m in movements if m["type"] == "static")
    n_dyn = len(movements) - n_static
    captured = sum(1 for m in movements if m["data_status"] == "captured")
    dump("provenance.json", {
        "schema_version": V, "pack_id": SPORT, "version": V, "created_at": "2026-10-25", "authors": ["ApexFormz Brain engineering (squash engine)"],
        "sources": [
            {"id": "wsf_court_spec_2017", "type": "official_rules", "citation": "WSF Specifications for Squash Courts, January 2017 edition (171128_Court-Specifications.pdf)", "url": "https://www.worldsquash.sport/wp-content/uploads/2021/08/171128_Court-Specifications.pdf", "accessed": "2026-10-25", "status": "approved"},
            {"id": "wsf_singles_rules_2025", "type": "official_rules", "citation": "World Squash Singles Rules 2025 V1.2, effective 1 September 2025", "url": "https://www.worldsquash.sport/wp-content/uploads/2025/07/250901_World-Squash-Rules-of-Singles-Squash-2025-V1.2.2.pdf", "accessed": "2026-10-25", "status": "approved"},
            {"id": "wsf_eyewear", "type": "official_rules", "citation": "WSF protective eyewear guidance and Rules Appendix 4", "url": "https://www.worldsquash.sport/eyewear/", "accessed": "2026-10-25", "status": "approved"},
            {"id": "data_capture_catalog", "type": "dataset", "citation": f"ApexFormz Data Capture movement catalog {src['version']} (squash subset: {len(src['movements'])} labeled movements), {src['source']['uri']} sha256 {src['source']['sha256'][:16]}...", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "data_capture_recordings", "type": "dataset", "citation": "ApexFormz Data Capture squash recordings: 616 usable pose captures of one expert athlete (front, back, left views), used for the taxonomy, hard-negative edges and expert reference postures", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "kinematics_drive_volley_drop", "type": "literature", "citation": "The kinematic differences between skill levels in the squash forehand drive, volley and drop strokes (ResearchGate publication 340657676)", "url": "https://www.researchgate.net/publication/340657676", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "brumann_2021", "type": "literature", "citation": "Brumann, Kukuk, Reinsberger. Evaluation of open-source and pre-trained deep CNNs for player detection and motion analysis in squash. Sensors 2021, 21(13):4550", "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC8271826", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "coaching_lunge", "type": "coach_review", "citation": "Squash Magazine, Strength Training for Squash Part V: Lunging (2010); Onyx Squash Academy, Mastering the Squash Lunge", "url": "https://squashmagazine.com/2010/01/strength-training-for-squash-part-v-lunging/", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "coaching_shots", "type": "coach_review", "citation": "Squash Empire and Winning Squash shot guides; SquashSkills fundamentals (shot descriptions, T recovery, split step)", "url": "https://www.squashempire.com/complete-guide-squash-shots/", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "variability_literature", "type": "literature", "citation": "Bartlett, Wheat & Robins 2007, Sports Biomechanics 6(2); Bankosz & Winiarski 2020, J Sports Sci Med 19; between-day running kinematics reliability (SEM 0.6-2.6 deg, MDC 1.5-7.2 deg)", "url": "https://doi.org/10.1080/14763140701322994", "accessed": "2026-10-25", "status": "provisional"},
            {"id": "coach_panel", "type": "coach_review", "citation": "Squash coach panel for taxonomy, ontology and rubric approval (to be convened)", "status": "provisional"},
            {"id": "athlete_attestations", "type": "internal", "citation": "Project-owner attestation for athlete ATH_0005 (coach): right-handed; consent from coach and club granted for training and evaluation (signed, stamped documents held offline); ml/sports/squash/athlete_attestations.json", "accessed": "2026-10-25", "status": "approved"},
        ],
        "validation_summary": {"approved": 0, "provisional": len(criteria), "disabled": 0},
        "open_items": [
            "TODO_REQUIRES_VALIDATION: the family -> group taxonomy is measured on one expert athlete; re-run ml/sports/squash/build_taxonomy.py when more athletes are captured and confirm with the coach panel",
            "TODO_REQUIRES_VALIDATION: family names are engineering proposals (ml/sports/squash/taxonomy_names.json) pending coach review",
            "TODO_REQUIRES_VALIDATION: expert-labeled reference postures come from one right-handed athlete (handedness attested by the project owner, ml/sports/squash/athlete_attestations.json); add athletes before trusting reference comparisons for other body types and for left-handed players",
            "TODO_REQUIRES_VALIDATION: consent for the coach and club is attested by the project owner (signed, stamped documents held offline); the Data Capture records themselves still show the consent status as unknown and should be updated at source",
            "TODO_REQUIRES_VALIDATION: phase-graph thresholds for strokes, lunges and court travel were calibrated on the expert recordings without phase labels (ml/sports/squash/phase_calibration.json); key phases are reached on only 38-60 percent of the expert's own clips and on 25-36 percent of other movements' clips, so phase detection is not reliable. Coaches should correct ml/sports/squash/phase_prelabels.jsonl to train a learned segmenter",
            "TODO_REQUIRES_VALIDATION: criterion ranges and limits are seeds; the recordings carry no technique-correctness labels",
            "TODO_REQUIRES_VALIDATION: group/family recognition gates (0.6 probability, 0.1 margin) are not calibrated: on unseen camera views accuracy on accepted answers stays near 33-42 percent at any gate (ml/runs/squash/cross_view/cross_view_report.json), so no gate yields reliable recognition with one athlete",
            "TODO_REQUIRES_VALIDATION: serve and return of serve are pack-defined and not yet in the capture catalog",
            "TODO_REQUIRES_VALIDATION: racket tracking (optional_implement) and court-line calibration (calibrated_scale) adapters must be wired before contact-height and foot-in-box criteria can leave NOT_ASSESSABLE",
            "TODO_REQUIRES_VALIDATION: feedback cues are drafts pending coach review; strict mode never speaks them",
            "TODO_REQUIRES_VALIDATION: human variance profile to be fitted per criterion from repeated executions",
            "TODO_REQUIRES_VALIDATION: racket and ball specification figures to be confirmed on the WSF specification pages",
        ],
    })
    dump("manifest.json", {"schema_version": V, "id": SPORT, "version": V, "minimum_core_version": "1.0.0", "supported_platforms": ["web", "android", "ios"],
                           "capabilities": ["body_pose", "optional_implement", "optional_projectile", "calibrated_scale"],
                           "dependencies": [{"id": "common_features", "version": "^1.0"}],
                           "game_rules": "competition_rules.json", "court_geometry": "court_geometry.json", "equipment_catalog": "equipment_catalog.json", "movements": "movement_catalog.json",
                           "phase_graphs": "phase_graphs.json", "technique_rubrics": "technique_criteria.json", "feedback_templates": "feedback_templates.json", "provenance": "provenance.json",
                           "models": models, "asset_hashes": {}, "signature": {"algorithm": "none"},
                           "display": {"name": "Squash", "description": f"Squash sports engine: {len(movements)} movements ({n_static} static, {n_dyn} dynamic; {captured} backed by labeled recordings) organised into {len(families)} families and {sum(len(fm['groups']) for fm in families)} groups measured on the data; WSF court and rules.", "color": "#38bdf8", "status": "pilot"}}, indent=2)
    reference_install = install_extracted_dynamic_references(OUT)
    print(f"squash pack: {len(movements)} movements ({n_static} static / {n_dyn} dynamic, {captured} captured), {len(families)} families, {sum(len(fm['groups']) for fm in families)} groups, {len(graphs)} graphs, {len(criteria)} base criteria, {len(CUES)} shared cues, {len(models)} static reference models; dynamic references: {reference_install}")


def update_dynamic_templates_only(out=OUT, backup=None):
    """Repair named actions without regenerating static references or unrelated pack entries.

    The caller must seal/sign the changed pack afterwards using the standard pack tooling.
    The full build uses the same graph, criterion and description functions.
    """
    source = json.loads((KIT / "source_catalog.json").read_text(encoding="utf-8"))
    selected = {m["movement_id"]: m for m in source["movements"] if named_action_template_for(m)}
    names = ("movement_catalog.json", "phase_graphs.json", "technique_criteria.json", "provenance.json")
    before = {p.relative_to(out).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob("*") if p.is_file()}
    if backup:
        backup.mkdir(parents=True, exist_ok=True)
        for name in (*names, "manifest.json"):
            if not (backup / name).exists():
                shutil.copy2(out / name, backup / name)
        if not (backup / "asset-hashes-before.json").exists():
            (backup / "asset-hashes-before.json").write_text(json.dumps(before, indent=2) + "\n", encoding="utf-8")
    documents = {name: json.loads((out / name).read_text(encoding="utf-8")) for name in names}
    accepted, decisions = load_phase_calibration()
    graphs, criteria = {}, {}
    for mid, m in selected.items():
        tmpl, variant = template_for(m)
        graphs[mid] = apply_phase_calibration(dynamic_graph(mid, tmpl, variant), accepted, decisions)
        criteria[mid] = dynamic_criteria(mid, tmpl, variant)
        for c in criteria[mid]:
            c["evaluator"]["human_variance_relative"] = variance_allowance(c["criterion_id"], c["evaluator"]["kind"])
        criteria[mid].extend(c for c in documents["technique_criteria.json"]["criteria"] if c["movement_id"] == mid and c["evaluator"]["kind"] == "dynamic_reference")
    documents["phase_graphs.json"]["graphs"] = [graphs.get(g["movement_id"], g) for g in documents["phase_graphs.json"]["graphs"]]
    for m in documents["movement_catalog.json"]["movements"]:
        if m["id"] in selected:
            m["criteria"] = [c["criterion_id"] for c in criteria[m["id"]]]
            m["description"] = movement_description(selected[m["id"]])
    replaced = set()
    updated = []
    for c in documents["technique_criteria.json"]["criteria"]:
        mid = c["movement_id"]
        if mid not in selected:
            updated.append(c)
        elif mid not in replaced:
            updated.extend(criteria[mid])
            replaced.add(mid)
    if replaced != set(selected):
        raise ValueError("compound movement absent from existing criteria")
    documents["technique_criteria.json"]["criteria"] = updated
    documents["provenance.json"]["validation_summary"] = {status: sum(c["validation_status"] == status for c in updated) for status in ("approved", "provisional", "disabled")}
    known_cues = {e["error_id"] for e in json.loads((out / "feedback_templates.json").read_text(encoding="utf-8"))["entries"]}
    if any(c["error_id"] not in known_cues for cs in criteria.values() for c in cs):
        raise ValueError("compound criterion references an absent cue")
    for name, document in documents.items():
        (out / name).write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    after = {p.relative_to(out).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob("*") if p.is_file()}
    changed = [name for name in after if before.get(name) != after[name]]
    if set(changed) - set(names):
        raise AssertionError("unrelated pack assets changed")
    report = {"movement_ids": sorted(selected), "changed_assets": changed, "before": before, "after": after, "seal_required": True}
    if backup:
        (backup / "update-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dynamic-template-repair-only", "--compound-recovery-only", dest="dynamic_template_repair_only", action="store_true", help="Repair named compound/shot graphs and criteria only, retaining unrelated pack entries; seal afterwards")
    parser.add_argument("--backup-dir", type=pathlib.Path)
    args = parser.parse_args()
    if args.dynamic_template_repair_only:
        result = update_dynamic_templates_only(backup=args.backup_dir)
        print(json.dumps({k: result[k] for k in ("movement_ids", "changed_assets", "seal_required")}, indent=2))
    else:
        build()
