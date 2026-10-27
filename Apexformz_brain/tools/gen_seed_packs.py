"""
One-time scaffold generator for the pickleball and table_tennis seed packs.

The emitted JSON files are the artifacts of record (declarative sport data, TRD 05).
This script only exists so the two structurally identical seed packs stay consistent;
re-run it with `python tools/gen_seed_packs.py` and then `npm run seal:packs`.

Every numeric value emitted here is an engineering seed marked provisional with
TODO_REQUIRES_VALIDATION. Nothing is an authoritative rule or biomechanical cutoff.
"""
from __future__ import annotations

import json
import pathlib
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1] / "sport-packs"

COMMON_FEATURES = [
    {"id": "left_knee_angle", "kind": "angle_at", "params": {"a": "left_hip", "b": "left_knee", "c": "left_ankle", "dims": "2d"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"},
    {"id": "right_knee_angle", "kind": "angle_at", "params": {"a": "right_hip", "b": "right_knee", "c": "right_ankle", "dims": "2d"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"},
    {"id": "max_knee_angle", "kind": "max_of", "params": {"features": ["left_knee_angle", "right_knee_angle"]}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"},
    {"id": "lead_knee_angle", "kind": "min_of", "params": {"features": ["left_knee_angle", "right_knee_angle"]}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"},
    {"id": "dominant_elbow_angle", "kind": "angle_at", "params": {"a": "dominant_shoulder", "b": "dominant_elbow", "c": "dominant_wrist", "dims": "2d"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"},
    {"id": "dominant_elbow_velocity", "kind": "angular_velocity", "params": {"of": "dominant_elbow_angle", "window_ms": 150, "method": "finite"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any"},
    {"id": "dominant_arm_elevation", "kind": "angle_at", "params": {"a": "dominant_hip", "b": "dominant_shoulder", "c": "dominant_elbow", "dims": "2d"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"},
    {"id": "trunk_lateral_lean", "kind": "line_inclination", "params": {"from": ["left_hip", "right_hip"], "to": ["left_shoulder", "right_shoulder"], "reference": "vertical"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": ["front", "back"], "unit": "deg"},
    {"id": "shoulder_hip_twist", "kind": "segment_orientation", "params": {"from": "left_shoulder", "to": "right_shoulder", "plane": "xz"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": ["front", "back"], "unit": "deg", "description": "Shoulder line orientation in the horizontal plane using model depth; depth ambiguity is a known failure mode"},
    {"id": "stance_width_ratio", "kind": "interjoint_distance_ratio", "params": {"a": "left_ankle", "b": "right_ankle", "c": "left_shoulder", "d": "right_shoulder", "dims": "2d"}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": ["front", "back"], "unit": "ratio"},
    {"id": "hip_centre_x_image", "kind": "center_of_keypoints", "params": {"landmarks": ["left_hip", "right_hip"], "axis": "x"}, "version": "1.0.0", "coordinate_system": "image_normalized", "view_applicability": "any", "unit": "normalized"},
    {"id": "hip_centre_y_image", "kind": "center_of_keypoints", "params": {"landmarks": ["left_hip", "right_hip"], "axis": "y"}, "version": "1.0.0", "coordinate_system": "image_normalized", "view_applicability": "any", "unit": "normalized"},
    {"id": "body_motion", "kind": "stability_variability", "params": {"of": "hip_centre_x_image", "window_ms": 600, "stat": "std", "min_samples": 4}, "version": "1.0.0", "coordinate_system": "image_normalized", "view_applicability": "any"},
    {"id": "hip_vertical_velocity", "kind": "time_derivative", "params": {"of": "hip_centre_y_image", "window_ms": 150, "method": "finite"}, "version": "1.0.0", "coordinate_system": "image_normalized", "view_applicability": "any"},
    {"id": "stroke_sequencing", "kind": "relative_phase_timing", "params": {"features": ["lead_knee_angle", "dominant_elbow_angle"], "window_ms": 1500}, "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any", "unit": "score"},
]

GENERIC_TEXT = {
    "AMBIGUOUS_SUBJECT": "Two people are in view. Please make sure only you are in the frame.",
    "FRAMING_INVALID": "Step back so your whole body, including your feet, is visible.",
    "MISSING_JOINT": "Some joints are hidden. Keep your full body in view.",
    "LOW_CONFIDENCE": "Tracking is unsteady. Improve lighting and face the camera.",
    "VIEW_INVALID": "This check needs a different camera angle; it is paused for now.",
    "TIME_GAP": "Tracking paused. Resume when you are ready.",
    "TRACK_CHANGED": "Lost track of you for a moment. Checks restart now.",
    "HANDEDNESS_UNKNOWN": "Set your paddle hand in the session setup to enable arm checks.",
    "CAPABILITY_MISSING": "Paddle or ball tracking is not active, so contact checks are off.",
    "CONTACT_UNOBSERVED": "Ball contact cannot be seen from body tracking alone.",
}


def uid(sport: str, name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"apexformz://{sport}/{name}"))


def static_graph(sport: str, mid: str) -> dict:
    return {
        "id": f"pg.{mid}", "movement_id": mid, "kind": "static_hold", "window_ms": 1500, "confirm_hold_ms": 600,
        "phases": [{
            "id": "hold", "name": "Ready hold", "kind": "hold", "contact_evidence": "none", "min_duration_ms": 600, "max_duration_ms": None,
            "enter": [
                {"feature": "body_motion", "op": "lt", "value": 0.006, "validation_status": "provisional"},
                {"feature": "max_knee_angle", "op": "lt", "value": 175, "validation_status": "provisional"},
            ],
            "hold_ms": 600, "cue_allowed": True,
        }],
        "edges": [], "initial": "hold", "terminal": ["hold"], "validation_status": "provisional",
        "note": "TODO_REQUIRES_VALIDATION: seed thresholds pending coach review.",
    }


def stroke_graph(sport: str, mid: str, phase_names: list[str], velocity: float) -> dict:
    """ready -> preparation -> loading -> swing -> estimated contact -> follow-through -> recovery (TRD 08/09)."""
    phases = [
        {"id": "ready", "name": "Ready", "kind": "rest", "contact_evidence": "none", "min_duration_ms": 150, "max_duration_ms": None,
         "enter": [{"feature": "body_motion", "op": "lt", "value": 0.012, "validation_status": "provisional"}], "hold_ms": 120, "cue_allowed": True},
        {"id": "backswing", "name": phase_names[0], "kind": "preparation", "contact_evidence": "none", "min_duration_ms": 60, "max_duration_ms": 1500,
         "enter": [{"feature": "dominant_elbow_velocity", "op": "abs_gt", "value": velocity * 0.4, "validation_status": "provisional"}], "hold_ms": 40, "cue_allowed": False},
        {"id": "swing", "name": phase_names[1], "kind": "action", "contact_evidence": "none", "min_duration_ms": 30, "max_duration_ms": 800,
         "enter": [{"feature": "dominant_elbow_velocity", "op": "abs_gt", "value": velocity, "validation_status": "provisional"}], "hold_ms": 30, "cue_allowed": False},
        {"id": "estimated_contact", "name": "Estimated contact", "kind": "contact", "contact_evidence": "unobserved", "min_duration_ms": 20, "max_duration_ms": 600,
         "enter": [{"feature": "dominant_elbow_velocity", "op": "abs_lt", "value": velocity * 0.6, "validation_status": "provisional"}], "hold_ms": 20, "cue_allowed": False},
        {"id": "follow_through", "name": "Follow through", "kind": "follow_through", "contact_evidence": "none", "min_duration_ms": 60, "max_duration_ms": 1200,
         "enter": [{"feature": "dominant_elbow_velocity", "op": "abs_lt", "value": velocity * 0.3, "validation_status": "provisional"}], "hold_ms": 40, "cue_allowed": False},
        {"id": "recovery", "name": "Recovery", "kind": "recovery", "contact_evidence": "none", "min_duration_ms": 100, "max_duration_ms": 3000,
         "enter": [{"feature": "body_motion", "op": "lt", "value": 0.012, "validation_status": "provisional"}], "hold_ms": 100, "cue_allowed": True},
    ]
    ids = [p["id"] for p in phases]
    edges = [{"from": a, "to": b} for a, b in zip(ids, ids[1:])] + [{"from": "recovery", "to": "ready"}]
    return {"id": f"pg.{mid}", "movement_id": mid, "kind": "dynamic_sequence", "window_ms": 3000, "abort_timeout_ms": 4000, "confirm_hold_ms": 60,
            "allow_skip": False, "phases": phases, "edges": edges, "initial": "ready", "terminal": ["recovery"], "validation_status": "provisional",
            "note": "TODO_REQUIRES_VALIDATION: generic stroke seed graph; contact is never observed from body pose and is labelled estimated/unobserved."}


def footwork_graph(sport: str, mid: str) -> dict:
    phases = [
        {"id": "ready", "name": "Ready", "kind": "rest", "contact_evidence": "none", "min_duration_ms": 150, "max_duration_ms": None,
         "enter": [{"feature": "body_motion", "op": "lt", "value": 0.006, "validation_status": "provisional"}], "hold_ms": 150, "cue_allowed": True},
        {"id": "move", "name": "Move", "kind": "action", "contact_evidence": "none", "min_duration_ms": 60, "max_duration_ms": 2500,
         "enter": [{"feature": "hip_vertical_velocity", "op": "abs_gt", "value": 0.2, "validation_status": "provisional"}], "hold_ms": 40, "cue_allowed": False},
        {"id": "settle", "name": "Settle", "kind": "recovery", "contact_evidence": "none", "min_duration_ms": 100, "max_duration_ms": 3000,
         "enter": [{"feature": "body_motion", "op": "lt", "value": 0.01, "validation_status": "provisional"}], "hold_ms": 100, "cue_allowed": True},
    ]
    return {"id": f"pg.{mid}", "movement_id": mid, "kind": "dynamic_sequence", "window_ms": 3000, "abort_timeout_ms": 4000, "confirm_hold_ms": 80,
            "phases": phases, "edges": [{"from": "ready", "to": "move"}, {"from": "move", "to": "settle"}, {"from": "settle", "to": "ready"}],
            "initial": "ready", "terminal": ["settle"], "validation_status": "provisional", "note": "TODO_REQUIRES_VALIDATION: generic footwork seed graph."}


def ready_criteria(sport: str, mid: str) -> list[dict]:
    cite = {"source": "TODO_REQUIRES_VALIDATION: coach panel review", "status": "provisional"}
    return [
        {"criterion_id": f"{mid}.stance_width", "movement_id": mid, "phase_ids": ["hold"], "required_features": ["stance_width_ratio"],
         "evaluator": {"kind": "range", "aggregate": "window_mean", "range": [1.0, 1.9], "tolerance": 0.3}, "technique_variant": None,
         "view_constraints": ["front", "back"], "missing_data_policy": "not_assessable", "severity": "medium", "weight": 1.0, "expert_citation": cite,
         "athlete_context": "any", "requires_capabilities": ["body_pose"], "validation_status": "provisional", "validation_version": "0.1-seed",
         "error_id": f"{mid}.stance_width_out_of_range"},
        {"criterion_id": f"{mid}.knee_flexion", "movement_id": mid, "phase_ids": ["hold"], "required_features": ["max_knee_angle"],
         "evaluator": {"kind": "max_value", "aggregate": "window_mean", "limit": 168, "tolerance": 8}, "technique_variant": None,
         "view_constraints": "any", "missing_data_policy": "not_assessable", "severity": "medium", "weight": 1.0, "expert_citation": cite,
         "athlete_context": "any", "requires_capabilities": ["body_pose"], "validation_status": "provisional", "validation_version": "0.1-seed",
         "error_id": f"{mid}.knees_too_straight"},
    ]


def feedback_entries(mid: str) -> list[dict]:
    return [
        {"error_id": f"{mid}.stance_width_out_of_range", "cue": {"en": "Set your feet about shoulder-width apart."}, "rationale": {"en": "A balanced base speeds up the first step."}, "demonstration_ref": None, "review_status": "draft", "cooldown_ms": 8000, "persistence_count": 3, "severity": "medium", "positive_cue": {"en": "Good base width."}},
        {"error_id": f"{mid}.knees_too_straight", "cue": {"en": "Soften your knees so you are ready to move."}, "rationale": {"en": "Straight knees delay the first step."}, "demonstration_ref": None, "review_status": "draft", "cooldown_ms": 8000, "persistence_count": 3, "severity": "medium", "positive_cue": {"en": "Nice loaded knees."}},
    ]


def build(sport: str, display: str, color: str, static_name: str, strokes: list[tuple[str, str, list[str], float]], footwork: list[tuple[str, str]],
          court_landmarks: list[tuple[str, str]], rules: list[tuple[str, str, str, bool]], equipment: list[dict], trd: str, authority: str, source_name: str, caps: list[str]):
    out = ROOT / sport
    out.mkdir(parents=True, exist_ok=True)
    static_id = f"{sport}.{static_name}"
    movements, graphs, criteria, fb = [], [], [], []

    movements.append({"uuid": uid(sport, static_name), "id": static_id, "canonical_name": static_name.replace("_", " ").capitalize(),
                      "aliases": [{"name": static_name.replace("_", " "), "locale": "en", "status": "approved"}], "type": "static",
                      "permitted_views": ["front", "back", "front_left", "front_right"], "phase_graph_id": f"pg.{static_id}", "required_capabilities": ["body_pose"],
                      "criteria": [f"{static_id}.stance_width", f"{static_id}.knee_flexion"],
                      "similar": [], "review_status": "coach_review_required", "difficulty": "beginner", "description": "Balanced base position between shots."})
    graphs.append(static_graph(sport, static_id))
    criteria.extend(ready_criteria(sport, static_id))
    fb.extend(feedback_entries(static_id))

    for name, label, phases, vel in strokes:
        mid = f"{sport}.{name}"
        movements.append({"uuid": uid(sport, name), "id": mid, "canonical_name": label, "aliases": [], "type": "dynamic",
                          "permitted_views": ["front", "left", "right"], "phase_graph_id": f"pg.{mid}", "required_capabilities": ["body_pose"],
                          "criteria": [], "similar": [], "review_status": "coach_review_required", "difficulty": "intermediate"})
        graphs.append(stroke_graph(sport, mid, phases, vel))
    for name, label in footwork:
        mid = f"{sport}.{name}"
        movements.append({"uuid": uid(sport, name), "id": mid, "canonical_name": label, "aliases": [], "type": "dynamic",
                          "permitted_views": ["front", "back", "left", "right"], "phase_graph_id": f"pg.{mid}", "required_capabilities": ["body_pose"],
                          "criteria": [], "similar": [], "review_status": "coach_review_required", "difficulty": "intermediate"})
        graphs.append(footwork_graph(sport, mid))

    # similar edges between mirror-side strokes
    ids = {m["id"] for m in movements}
    for m in movements:
        if m["id"].endswith("forehand_drive") and m["id"].replace("forehand", "backhand") in ids:
            m["similar"].append({"movement_id": m["id"].replace("forehand", "backhand"), "relation": "mirror_side", "hard_negative": True})
        if m["id"].endswith("backhand_drive") and m["id"].replace("backhand", "forehand") in ids:
            m["similar"].append({"movement_id": m["id"].replace("backhand", "forehand"), "relation": "mirror_side", "hard_negative": True})

    dump = lambda name, obj: (out / name).write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
    dump("court_geometry.json", {
        "schema_version": "1.0.0", "sport_id": sport,
        "coordinate_frame": {"id": f"{sport}_court_frame", "origin": "centre of the playing surface at the net", "axes": "+x right sideline, +y far end, +z up", "units": "m"},
        "formats": ["singles", "doubles"],
        "named_landmarks": [{"id": k, "description": d, "value_m": None, "applies_to": ["singles", "doubles"], "validation_status": "provisional", "note": "TODO_REQUIRES_VALIDATION: fill from the approved authoritative rule source."} for k, d in court_landmarks],
        "polygons": [], "validation_status": "provisional",
        "provenance": {"source": source_name, "ref": "TODO_REQUIRES_VALIDATION: edition/section", "status": "provisional"},
        "notes": ["Geometry is pack-owned declarative data; the shared Brain never hardcodes it."],
    })
    dump("competition_rules.json", {
        "schema_version": "1.0.0", "sport_id": sport,
        "rule_sets": [{"id": f"{sport}_official_rules", "authority": authority, "source": {"source": source_name, "ref": "TODO_REQUIRES_VALIDATION", "status": "provisional"},
                       "edition": None, "effective_date": None, "discipline": sport, "format": "singles_and_doubles", "locale": "en", "validation_status": "provisional",
                       "rules": [{"id": rid, "kind": kind, "text": text, "value": None, "adjudicable_from_pose": pose, "validation_status": "provisional"} for rid, kind, text, pose in rules]}],
    })
    dump("equipment_catalog.json", {"schema_version": "1.0.0", "sport_id": sport, "items": equipment})
    movement_catalog = {"schema_version": "1.0.0", "sport_id": sport, "movements": movements}
    research_path = pathlib.Path(__file__).resolve().parents[1] / "ml/sports/recognition_taxonomy_sources.json"
    if research_path.exists():
        taxonomy = json.loads(research_path.read_text(encoding="utf-8"))["taxonomies"].get(sport)
        if taxonomy:
            from refresh_recognition_taxonomies import validate
            placement = validate(movement_catalog, taxonomy)
            movement_catalog["taxonomy"] = taxonomy
            for movement in movements:
                movement["family_id"], movement["group_id"] = placement[movement["id"]]
    dump("movement_catalog.json", movement_catalog)
    dump("phase_graphs.json", {"schema_version": "1.0.0", "sport_id": sport, "graphs": graphs})
    dump("technique_criteria.json", {"schema_version": "1.0.0", "sport_id": sport, "rubric_version": "1.0.0",
                                      "aggregation": {"method": "weighted_mean_of_valid_criteria", "minimum_coverage": 0.6},
                                      "features": COMMON_FEATURES, "criteria": criteria})
    dump("feedback_templates.json", {"schema_version": "1.0.0", "sport_id": sport, "catalog_version": "1.0.0", "default_locale": "en",
                                     "policy": {"global_min_interval_ms": 6000, "positive_reinforcement_interval_ms": 15000, "max_secondary_queue": 3},
                                     "entries": fb, "generic": {k: {"en": v} for k, v in GENERIC_TEXT.items()}})
    dump("provenance.json", {"schema_version": "1.0.0", "pack_id": sport, "version": "1.0.0", "created_at": "2026-10-25",
                             "authors": ["ApexFormz Brain engineering (seed content)"],
                             "sources": [{"id": trd.lower(), "type": "internal", "citation": f"ApexFormz {trd} v1.0 (24 Oct 2026)", "status": "provisional"},
                                         {"id": "official_rules", "type": "official_rules", "citation": f"{source_name} (edition to be recorded)", "status": "provisional"},
                                         {"id": "coach_panel", "type": "coach_review", "citation": "Coach review panel (not yet convened)", "status": "provisional"}],
                             "validation_summary": {"approved": 0, "provisional": len(criteria), "disabled": 0},
                             "open_items": ["TODO_REQUIRES_VALIDATION: court/table geometry values from the approved rule edition",
                                            "TODO_REQUIRES_VALIDATION: coach panel approval of the movement ontology seeds",
                                            "TODO_REQUIRES_VALIDATION: all phase thresholds and criterion limits are engineering seeds",
                                            "TODO_REQUIRES_VALIDATION: paddle and ball adapters are unimplemented; contact criteria must abstain"]})
    dump("manifest.json", {"schema_version": "1.0.0", "id": sport, "version": "1.0.0", "minimum_core_version": "1.0.0",
                           "supported_platforms": ["web", "android", "ios"], "capabilities": caps,
                           "dependencies": [{"id": "common_features", "version": "^1.0"}],
                           "game_rules": "competition_rules.json", "court_geometry": "court_geometry.json", "equipment_catalog": "equipment_catalog.json",
                           "movements": "movement_catalog.json", "phase_graphs": "phase_graphs.json", "technique_rubrics": "technique_criteria.json",
                           "feedback_templates": "feedback_templates.json", "provenance": "provenance.json", "models": [], "asset_hashes": {},
                           "signature": {"algorithm": "none"},
                           "display": {"name": display, "description": f"{display} seed pack: ontology, generic phase graphs and ready-position criteria pending coach review.", "color": color, "status": "seed"}})
    print(f"wrote {sport}: {len(movements)} movements, {len(graphs)} graphs, {len(criteria)} criteria")


if __name__ == "__main__":
    build(
        "pickleball", "Pickleball", "#00ff88", "ready_position",
        strokes=[("forehand_drive", "Forehand drive", ["Preparation", "Swing"], 220.0), ("backhand_drive", "Backhand drive", ["Preparation", "Swing"], 220.0),
                 ("dink", "Dink", ["Preparation", "Soft swing"], 90.0), ("volley", "Volley", ["Preparation", "Punch"], 160.0),
                 ("serve", "Serve", ["Backswing", "Swing"], 200.0), ("overhead", "Overhead", ["Preparation", "Swing"], 260.0)],
        footwork=[("split_step", "Split step"), ("recovery", "Recovery")],
        court_landmarks=[("court_length", "Baseline to baseline"), ("court_width", "Sideline to sideline"), ("non_volley_zone_depth", "Net to non-volley zone line"), ("net_height_centre", "Net height at centre"), ("net_height_posts", "Net height at posts")],
        rules=[("two_bounce", "official", "The two-bounce rule applies after the serve; adjudication requires ball bounce evidence.", False),
               ("non_volley_zone", "official", "Volleying while touching the non-volley zone is a fault; requires foot and ball contact evidence.", False),
               ("serve_rules", "official", "Serve motion and contact height are restricted; requires paddle and ball visibility.", False),
               ("scoring", "official", "Side-out scoring variants are rule-edition specific.", False),
               ("training_ready_reset", "coaching_heuristic", "Return to the ready position after each shot.", True)],
        equipment=[{"id": "paddle", "object_class": "pickleball_paddle", "description": "Paddle in the dominant hand", "tracking": "optional_adapter", "adapter_capability": "optional_implement", "validation_status": "provisional"},
                   {"id": "ball", "object_class": "pickleball", "description": "Perforated plastic ball", "tracking": "offline_only", "adapter_capability": "optional_projectile", "validation_status": "provisional", "note": "Ball is small in frame; live tracking is unreliable on mobile cameras."}],
        trd="TRD 08 Pickleball Sport Brain", authority="USA Pickleball / IFP (to be confirmed)", source_name="Official pickleball rulebook",
        caps=["body_pose", "optional_implement", "optional_projectile"],
    )
    build(
        "table_tennis", "Table Tennis", "#6e56cf", "ready_stance",
        strokes=[("forehand_drive", "Forehand drive", ["Backswing", "Acceleration"], 240.0), ("backhand_drive", "Backhand drive", ["Backswing", "Acceleration"], 240.0),
                 ("forehand_topspin", "Forehand topspin", ["Backswing", "Acceleration"], 300.0), ("backhand_topspin", "Backhand topspin", ["Backswing", "Acceleration"], 300.0),
                 ("push", "Push", ["Backswing", "Push"], 120.0), ("block", "Block", ["Preparation", "Block"], 100.0), ("serve", "Serve", ["Toss", "Acceleration"], 200.0)],
        footwork=[("footwork_recovery", "Footwork recovery")],
        court_landmarks=[("table_length", "Table length"), ("table_width", "Table width"), ("table_height", "Playing surface height"), ("net_height", "Net height"), ("net_overhang", "Net overhang beyond the sideline")],
        rules=[("serve_toss", "official", "The ball must be tossed near-vertically to a minimum height during service; requires ball visibility.", False),
               ("bounce_sequence", "official", "Legal return requires the correct bounce sequence; requires ball tracking.", False),
               ("scoring", "official", "Game and match point thresholds are defined by the authoritative rules.", False),
               ("training_compact_stroke", "coaching_heuristic", "Keep strokes compact and recover to the ready stance between shots.", True)],
        equipment=[{"id": "paddle", "object_class": "table_tennis_racket", "description": "Racket/paddle in the dominant hand", "tracking": "optional_adapter", "adapter_capability": "optional_implement", "validation_status": "provisional"},
                   {"id": "ball", "object_class": "table_tennis_ball", "description": "40 mm class ball", "tracking": "offline_only", "adapter_capability": "optional_projectile", "validation_status": "provisional", "note": "Phone frame rates are inadequate for bounce and spin inference."}],
        trd="TRD 09 Table Tennis Sport Brain", authority="International Table Tennis Federation", source_name="ITTF Handbook",
        caps=["body_pose", "optional_implement", "optional_projectile"],
    )
