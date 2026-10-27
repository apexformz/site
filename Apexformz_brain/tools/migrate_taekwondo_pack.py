"""
Migrate the legacy ApexFormz taekwondo data into a Brain sport pack.

Sources (original repo, read-only):
  apps/ai-service/app/data/reference_movements.json        -> phase blueprints and triggers
  apps/ai-service/app/data/taekwondo_reference_frames.json -> expert joint-angle frames (3 camera views)

Output: sport-packs/taekwondo/* plus models/*.json reference sets consumed by the
`reference_nearest` criterion evaluator. Everything emitted is provisional and
labelled legacy_migrated: the legacy angle blueprints were hand-authored, so no
value here is an approved coaching cutoff (TRD 15: never invent thresholds).

  python tools/migrate_taekwondo_pack.py [path-to-original-Apexformz-repo]
  npm run seal:packs
"""
from __future__ import annotations

import json
import pathlib
import sys
import uuid

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / "Apexformz"
DATA = SRC / "apps" / "ai-service" / "app" / "data"
OUT = ROOT / "sport-packs" / "taekwondo"
SPORT = "taekwondo"

# Legacy joint angle triplets (shared core features, generic human geometry).
TRIPLETS = {
    "left_elbow": ("left_shoulder", "left_elbow", "left_wrist"),
    "right_elbow": ("right_shoulder", "right_elbow", "right_wrist"),
    "left_shoulder": ("left_hip", "left_shoulder", "left_elbow"),
    "right_shoulder": ("right_hip", "right_shoulder", "right_elbow"),
    "left_hip": ("left_shoulder", "left_hip", "left_knee"),
    "right_hip": ("right_shoulder", "right_hip", "right_knee"),
    "left_knee": ("left_hip", "left_knee", "left_ankle"),
    "right_knee": ("right_hip", "right_knee", "right_ankle"),
}
# Legacy FrameMatcher weights (biomechanical importance used by the old scorer).
LEGACY_WEIGHTS = {"left_hip": 1.5, "right_hip": 1.5, "left_knee": 1.6, "right_knee": 1.6, "left_shoulder": 0.7, "right_shoulder": 0.7, "left_elbow": 0.4, "right_elbow": 0.4}
LEGACY_CUES = {
    "left_hip": "Adjust your left hip angle.", "right_hip": "Adjust your right hip angle.",
    "left_knee": "Correct your left knee bend.", "right_knee": "Correct your right knee bend.",
    "left_shoulder": "Fix your left shoulder position.", "right_shoulder": "Fix your right shoulder position.",
    "left_elbow": "Adjust your left arm.", "right_elbow": "Adjust your right arm.",
}
DISPLAY_NAMES = {
    "ap_chagi_front_kick": ("Ap chagi (front kick)", ["ap chagi", "front kick"]),
    "dollyo_chagi_roundhouse_kick": ("Dollyo chagi (roundhouse kick)", ["dollyo chagi", "roundhouse kick"]),
    "yeop_chagi_side_kick": ("Yeop chagi (side kick)", ["yeop chagi", "side kick"]),
    "dwi_chagi_back_kick": ("Dwi chagi (back kick)", ["dwi chagi", "back kick"]),
    "miro_chagi_push_kick": ("Miro chagi (push kick)", ["miro chagi", "push kick"]),
    "bandae_dollyo_chagi_reverse_roundhouse": ("Bandae dollyo chagi (reverse roundhouse)", ["bandae dollyo chagi", "reverse roundhouse"]),
    "twio_ap_chagi_jumping_front_kick": ("Twio ap chagi (jumping front kick)", ["twio ap chagi", "jumping front kick"]),
    "twio_dollyo_chagi_jumping_roundhouse": ("Twio dollyo chagi (jumping roundhouse)", ["twio dollyo chagi", "jumping roundhouse"]),
    "baka_chagi_side_slide_roundhouse": ("Baka chagi (side slide roundhouse)", ["baka chagi"]),
    "preamble_dollyo_chagi_front_leg_slide": ("Front-leg slide dollyo chagi", ["preamble dollyo chagi"]),
}


def uid(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"apexformz://{SPORT}/{name}"))


def features() -> list[dict]:
    out = []
    for joint, (a, b, c) in TRIPLETS.items():
        out.append({"id": f"{joint}_angle", "kind": "angle_at", "params": {"a": a, "b": b, "c": c, "dims": "2d"}, "version": "1.0.0",
                    "coordinate_system": "body_relative", "view_applicability": "any", "unit": "deg"})
        out.append({"id": f"{joint}_velocity", "kind": "angular_velocity", "params": {"of": f"{joint}_angle", "window_ms": 150, "method": "finite"},
                    "version": "1.0.0", "coordinate_system": "body_relative", "view_applicability": "any"})
    out.append({"id": "hip_centre_x_image", "kind": "center_of_keypoints", "params": {"landmarks": ["left_hip", "right_hip"], "axis": "x"}, "version": "1.0.0", "coordinate_system": "image_normalized", "view_applicability": "any", "unit": "normalized"})
    out.append({"id": "body_motion", "kind": "stability_variability", "params": {"of": "hip_centre_x_image", "window_ms": 600, "stat": "std", "min_samples": 4}, "version": "1.0.0", "coordinate_system": "image_normalized", "view_applicability": "any"})
    return out


def convert_trigger(trigger, notes: list[str], mid: str, phase: str) -> list[dict]:
    if trigger == "initial" or not isinstance(trigger, dict):
        return []
    joint = trigger.get("joint", "")
    metric = trigger.get("metric", "")
    thr = float(trigger.get("threshold", 0))
    if metric == "angle_above":
        return [{"feature": f"{joint}_angle", "op": "gt", "value": thr, "validation_status": "provisional"}]
    if metric == "angle_below":
        return [{"feature": f"{joint}_angle", "op": "lt", "value": thr, "validation_status": "provisional"}]
    if metric == "angular_velocity":
        notes.append(f"TODO_REQUIRES_VALIDATION: {mid}/{phase} legacy angular_velocity threshold {thr} has ambiguous units (legacy mixed deg/frame and deg/s); re-fit on recordings")
        direction = trigger.get("direction", "positive")
        return [{"feature": f"{joint}_velocity", "op": "gt" if direction == "positive" else "lt", "value": thr, "validation_status": "provisional"}]
    notes.append(f"TODO_REQUIRES_VALIDATION: unsupported legacy trigger {metric} in {mid}/{phase}")
    return []


def main() -> None:
    movements_src = json.loads((DATA / "reference_movements.json").read_text(encoding="utf-8"))[SPORT]
    frames_src = json.loads((DATA / "taekwondo_reference_frames.json").read_text(encoding="utf-8"))
    (OUT / "models").mkdir(parents=True, exist_ok=True)

    notes: list[str] = []
    movements, graphs, criteria, feedback, models, hashes_models = [], [], [], [], [], []
    for key, cfg in movements_src.items():
        if cfg.get("type") != "dynamic":
            continue
        mid = f"{SPORT}.{key}"
        name, aliases = DISPLAY_NAMES.get(key, (key.replace("_", " "), []))
        phases_cfg = cfg["phases"]
        phases = []
        for i, p in enumerate(phases_cfg):
            pname = p["name"]
            kind = "rest" if i == 0 else ("recovery" if i == len(phases_cfg) - 1 else "action")
            contact = "unobserved" if any(k in pname for k in ("strike", "impact", "extension")) else "none"
            lo, hi = (p.get("duration_range_ms") or [50, None])[:2]
            enter = convert_trigger(p.get("trigger", "initial"), notes, mid, pname)
            if i == 0 and not enter:
                enter = [{"feature": "body_motion", "op": "lt", "value": 0.008, "validation_status": "provisional"}]
            phases.append({"id": pname, "name": pname.replace("_", " ").capitalize(), "kind": kind, "contact_evidence": contact,
                           "min_duration_ms": max(30, int(lo or 50) // 2), "max_duration_ms": (int(hi) * 3 if hi else None) if i else None,
                           "enter": enter, "hold_ms": 60 if i else 150, "cue_allowed": kind != "action"})
        ids = [p["id"] for p in phases]
        edges = [{"from": a, "to": b} for a, b in zip(ids, ids[1:])] + [{"from": ids[-1], "to": ids[0]}]
        graphs.append({"id": f"pg.{mid}", "movement_id": mid, "kind": "dynamic_sequence", "window_ms": 3000, "abort_timeout_ms": 5000, "confirm_hold_ms": 120,
                       "allow_skip": True, "phases": phases, "edges": edges, "initial": ids[0], "terminal": [ids[-1]], "validation_status": "provisional",
                       "note": "Migrated from legacy reference_movements.json phase blueprint (hand-authored). TODO_REQUIRES_VALIDATION."})

        # Reference sets from expert frames
        ref = frames_src.get(key)
        crit_ids = []
        if ref and ref.get("frames"):
            feats = [f"{j}_angle" for j in TRIPLETS]
            weights = [LEGACY_WEIGHTS[j] for j in TRIPLETS]
            def vectors(frames):
                return [[(None if (fr.get(j, -1) is None or fr.get(j, -1) < 0) else round(float(fr[j]), 2)) for j in TRIPLETS] for fr in frames]
            for role, frames, phase_ids, thr in (("start", ref.get("start_frames") or ref["frames"][:6], [ids[0]], 20.0), ("frames", ref["frames"], ids[1:], 25.0)):
                path = f"models/{key}_{role}.json"
                model = {"kind": "reference_set", "movement_id": mid, "features": feats, "weights": weights, "reference_vectors": vectors(frames),
                         "threshold": thr, "tolerance": 15.0, "validation_status": "provisional",
                         "provenance": "Legacy taekwondo_reference_frames.json extracted from front/left/right expert videos; weighted RMS distance in degrees. TODO_REQUIRES_VALIDATION."}
                (OUT / path).write_text(json.dumps(model, indent=1) + "\n", encoding="utf-8")
                models.append({"role": "reference_set", "path": path, "version": "legacy-1.0.0", "format": "json", "required": False})
                cid = f"{mid}.{'stance_match' if role == 'start' else 'form_match'}"
                eid = f"{cid}_off"
                crit_ids.append(cid)
                criteria.append({"criterion_id": cid, "movement_id": mid, "phase_ids": phase_ids, "required_features": feats,
                                 "evaluator": {"kind": "reference_nearest", "aggregate": "phase_mean", "model_reference": path, "tolerance": 15.0, "min_confidence": 0.5},
                                 "technique_variant": None, "view_constraints": ["front", "left", "right"], "missing_data_policy": "not_assessable",
                                 "severity": "medium", "weight": 1.0 if role == "start" else 2.0,
                                 "expert_citation": {"source": "Legacy expert reference videos (3 views); coach review pending", "status": "provisional"},
                                 "athlete_context": "any", "requires_capabilities": ["body_pose"], "validation_status": "provisional", "validation_version": "legacy-1.0.0",
                                 "error_id": eid, "description": f"Weighted joint-angle distance to the nearest expert {'start stance' if role == 'start' else 'movement'} frame."})
                feedback.append({"error_id": eid, "cue": {"en": "Match the reference stance more closely." if role == "start" else "Your kick shape differs from the reference; check knee and hip angles."},
                                 "rationale": {"en": "Nearest-expert-frame distance exceeded the provisional tolerance."}, "demonstration_ref": None, "review_status": "draft",
                                 "cooldown_ms": 8000, "persistence_count": 2, "severity": "medium", "positive_cue": {"en": "Good match to the reference."}})
        else:
            notes.append(f"TODO_REQUIRES_VALIDATION: no expert frames for {key}; criteria omitted")

        movements.append({"uuid": uid(key), "id": mid, "canonical_name": name, "aliases": [{"name": a, "locale": "en", "status": "approved"} for a in aliases],
                          "type": "dynamic", "permitted_views": ["front", "left", "right"], "phase_graph_id": f"pg.{mid}", "required_capabilities": ["body_pose"],
                          "criteria": crit_ids, "similar": [], "review_status": "coach_review_required", "difficulty": "intermediate",
                          "description": f"Migrated from legacy ApexFormz taekwondo blueprint '{key}'."})

    # similar edges: jumping variants vs base kicks
    by_id = {m["id"] for m in movements}
    for m in movements:
        base = m["id"].replace("twio_", "")
        if m["id"] != base and base in by_id:
            m["similar"].append({"movement_id": base, "relation": "jumping_variant_of", "hard_negative": True})

    dump = lambda n, o: (OUT / n).write_text(json.dumps(o, indent=2) + "\n", encoding="utf-8")
    generic = {k: {"en": v} for k, v in {
        "AMBIGUOUS_SUBJECT": "Two people are in view. Please make sure only you are in the frame.",
        "FRAMING_INVALID": "Step back so your whole body, including your feet, is visible.",
        "MISSING_JOINT": "Some joints are hidden. Keep your full body in view.",
        "LOW_CONFIDENCE": "Tracking is unsteady. Improve lighting and face the camera.",
        "VIEW_INVALID": "This check needs a front, left or right camera view.",
        "TIME_GAP": "Tracking paused. Resume when you are ready.",
        "TRACK_CHANGED": "Lost track of you for a moment. Checks restart now.",
        "MODEL_UNAVAILABLE": "Reference data for this kick is not loaded.",
    }.items()}
    dump("court_geometry.json", {"schema_version": "1.0.0", "sport_id": SPORT, "coordinate_frame": {"id": "taekwondo_mat_frame", "origin": "centre of the contest area", "axes": "+x right, +y away from camera, +z up", "units": "m"},
                                 "formats": ["kyorugi", "poomsae"], "named_landmarks": [{"id": "contest_area_side", "description": "Side length of the contest area", "value_m": None, "validation_status": "provisional", "note": "TODO_REQUIRES_VALIDATION: fill from the approved World Taekwondo rule edition."}],
                                 "polygons": [], "validation_status": "provisional", "provenance": {"source": "World Taekwondo Competition Rules", "ref": "TODO_REQUIRES_VALIDATION", "status": "provisional"}, "notes": ["Legacy data contained no court geometry."]})
    dump("competition_rules.json", {"schema_version": "1.0.0", "sport_id": SPORT, "rule_sets": [{"id": "wt_kyorugi", "authority": "World Taekwondo", "source": {"source": "WT Competition Rules", "ref": "TODO_REQUIRES_VALIDATION", "status": "provisional"}, "edition": None, "effective_date": None, "discipline": "kyorugi", "format": "individual", "locale": "en", "validation_status": "provisional",
                                    "rules": [{"id": "scoring", "kind": "official", "text": "Point values for kicks and punches are defined by the authoritative rules and electronic scoring systems.", "value": None, "adjudicable_from_pose": False, "validation_status": "provisional"},
                                              {"id": "training_rechamber", "kind": "coaching_heuristic", "text": "Re-chamber the kicking leg before returning to stance.", "adjudicable_from_pose": True, "validation_status": "provisional"}]}]})
    dump("equipment_catalog.json", {"schema_version": "1.0.0", "sport_id": SPORT, "items": [{"id": "hogu", "object_class": "body_protector", "description": "Chest protector", "tracking": "none", "adapter_capability": None, "validation_status": "provisional"},
                                                                                           {"id": "pss", "object_class": "sensor_system", "description": "Protector and scoring system", "tracking": "optional_adapter", "adapter_capability": "optional_sensor", "validation_status": "provisional", "note": "Scoring events come from the PSS, never from pose."}]})
    dump("movement_catalog.json", {"schema_version": "1.0.0", "sport_id": SPORT, "movements": movements})
    dump("phase_graphs.json", {"schema_version": "1.0.0", "sport_id": SPORT, "graphs": graphs})
    dump("technique_criteria.json", {"schema_version": "1.0.0", "sport_id": SPORT, "rubric_version": "1.0.0-legacy", "aggregation": {"method": "weighted_mean_of_valid_criteria", "minimum_coverage": 0.5}, "features": features(), "criteria": criteria})
    dump("feedback_templates.json", {"schema_version": "1.0.0", "sport_id": SPORT, "catalog_version": "1.0.0-legacy", "default_locale": "en", "policy": {"global_min_interval_ms": 6000, "positive_reinforcement_interval_ms": 15000, "max_secondary_queue": 2}, "entries": feedback, "generic": generic})
    dump("provenance.json", {"schema_version": "1.0.0", "pack_id": SPORT, "version": "1.0.0", "created_at": "2026-10-25", "authors": ["ApexFormz Brain engineering (legacy migration)"],
                             "sources": [{"id": "legacy_blueprints", "type": "legacy_data", "citation": "Original ApexFormz apps/ai-service/app/data/reference_movements.json (hand-authored phase blueprints)", "status": "provisional"},
                                         {"id": "legacy_expert_frames", "type": "legacy_data", "citation": "Original ApexFormz taekwondo_reference_frames.json extracted with MediaPipe from front/left/right expert videos", "status": "provisional"},
                                         {"id": "coach_panel", "type": "coach_review", "citation": "Coach review panel (not yet convened)", "status": "provisional"}],
                             "validation_summary": {"approved": 0, "provisional": len(criteria), "disabled": 0},
                             "open_items": sorted(set(notes)) + ["TODO_REQUIRES_VALIDATION: legacy angle blueprints and expert-frame distances are not approved coaching cutoffs",
                                                                 "TODO_REQUIRES_VALIDATION: legacy DTW trajectory scoring and ST-GCN grading remain on the Python service; not migrated"]})
    dump("manifest.json", {"schema_version": "1.0.0", "id": SPORT, "version": "1.0.0", "minimum_core_version": "1.0.0", "supported_platforms": ["web", "android", "ios"], "capabilities": ["body_pose", "optional_sensor"],
                           "dependencies": [{"id": "common_features", "version": "^1.0"}], "game_rules": "competition_rules.json", "court_geometry": "court_geometry.json", "equipment_catalog": "equipment_catalog.json",
                           "movements": "movement_catalog.json", "phase_graphs": "phase_graphs.json", "technique_rubrics": "technique_criteria.json", "feedback_templates": "feedback_templates.json", "provenance": "provenance.json",
                           "models": models, "asset_hashes": {}, "signature": {"algorithm": "none"},
                           "display": {"name": "Taekwondo (legacy migration)", "description": "Ten kicks migrated from the original ApexFormz blueprints and expert reference frames. Provisional; the legacy Python pipeline remains the default for this sport.", "color": "#FFD700", "status": "legacy_migrated"}})
    print(f"wrote taekwondo pack: {len(movements)} movements, {len(graphs)} graphs, {len(criteria)} criteria, {len(models)} reference models, {len(set(notes))} notes")


if __name__ == "__main__":
    main()
