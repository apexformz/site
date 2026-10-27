"""Attach extracted dynamic references without regenerating existing coaching assets.

All references and tolerance envelopes remain provisional. No source recording,
static reference, phase graph or classifier weight is altered by this installer.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def install_dynamic_references(out: Path = ROOT / "sport-packs/squash") -> dict:
    paths = sorted((out / "models/dynamic-reference").glob("*.json"))
    if not paths:
        return {"models": 0, "criteria": 0, "seal_required": False}
    names = ["movement_catalog.json", "technique_criteria.json", "feedback_templates.json", "provenance.json", "manifest.json"]
    docs = {name: json.loads((out / name).read_text(encoding="utf-8")) for name in names}
    movement_doc, rubric, feedback, provenance, manifest = (docs[name] for name in names)
    movements = {m["id"]: m for m in movement_doc["movements"]}
    features = {f["id"]: f for f in rubric["features"]}
    new_criteria, new_entries, new_models = [], {}, []
    for path in paths:
        model = json.loads(path.read_text(encoding="utf-8"))
        mid = model.get("movement_id")
        if model.get("kind") != "dynamic_reference" or mid not in movements or movements[mid]["type"] != "dynamic":
            raise ValueError(f"invalid dynamic reference movement in {path}")
        if model.get("validation_status") != "provisional":
            raise ValueError("extracted references cannot promote their own validation status")
        rel = path.relative_to(out).as_posix()
        new_models.append({"role": "criterion_model", "path": rel, "version": model["schema_version"], "format": "json", "required": False})
        for spec in model["feature_specs"]:
            previous = features.get(spec["id"])
            if previous is not None and previous != spec:
                raise ValueError(f"conflicting feature definition: {spec['id']}")
            features[spec["id"]] = spec
        ids = [f["id"] for f in model["features"]]
        for feature in [None, *(f for f in model["features"] if f["weight"] > 0)]:
            fid = feature["id"] if feature else "sequence"
            cid = f"{mid}.dynamic_reference.{fid}"
            error_id = f"squash.cue.dynamic_reference.{fid}"
            new_criteria.append({
                "criterion_id": cid, "movement_id": mid, "phase_ids": None,
                "required_features": [fid] if feature else ids,
                "evaluator": {"kind": "dynamic_reference", "model_reference": rel, "min_confidence": 0.5,
                              "params": {"reference_feature": fid if feature else None}},
                "technique_variant": None, "view_constraints": "any", "missing_data_policy": "not_assessable",
                "severity": "medium", "weight": 1 if feature else 0.5,
                "expert_citation": {"source": "Recorded expert-labelled movement; automatic temporal alignment and tolerance envelope require coach review.", "status": "provisional"},
                "athlete_context": "any", "requires_capabilities": ["body_pose"],
                "validation_status": "provisional", "validation_version": "dynamic-reference-1",
                "error_id": error_id,
                "description": f"Compare {fid.replace('dynamic_ref_', '').replace('_', ' ')} with the selected movement's same-view recorded sequence.",
            })
            new_entries[error_id] = {
                "error_id": error_id, "cue": {"en": "Follow the recorded movement path through the full attempt."},
                "rationale": {"en": "This comparison uses an expert-labelled recording with provisional alignment and tolerances."},
                "demonstration_ref": None, "review_status": "draft", "cooldown_ms": 6000,
                "persistence_count": 2, "severity": "medium",
                "positive_cue": {"en": "That observed part follows the recorded reference." if feature else "Your observed movement follows the recorded reference."},
            }
        movements[mid]["criteria"] = [c for c in movements[mid]["criteria"] if ".dynamic_reference." not in c] + [c["criterion_id"] for c in new_criteria if c["movement_id"] == mid]
    rubric["features"] = list(features.values())
    rubric["criteria"] = [c for c in rubric["criteria"] if c["evaluator"]["kind"] != "dynamic_reference"] + new_criteria
    feedback["entries"] = [e for e in feedback["entries"] if not e["error_id"].startswith("squash.cue.dynamic_reference.")] + list(new_entries.values())
    manifest["models"] = [m for m in manifest["models"] if not m["path"].startswith("models/dynamic-reference/")] + new_models
    provenance["validation_summary"] = {status: sum(c["validation_status"] == status for c in rubric["criteria"]) for status in ("approved", "provisional", "disabled")}
    note = "TODO_REQUIRES_VALIDATION: Dynamic reference comparison uses same-view, same-handedness recorded trajectories. Boundaries and tolerance envelopes are automatic and provisional; reference matches are not independently validated technique judgements."
    notes = provenance.setdefault("open_items", [])
    notes[:] = [n for n in notes if not n.startswith("Dynamic reference comparison uses")]
    if isinstance(notes, list) and note not in notes:
        notes.append(note)
    for name, value in docs.items():
        text = json.dumps(value, indent=1, ensure_ascii=False) + "\n"
        if (out / name).read_text(encoding="utf-8") != text:
            (out / name).write_text(text, encoding="utf-8")
    return {"models": len(new_models), "criteria": len(new_criteria), "seal_required": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", type=Path, default=ROOT / "sport-packs/squash")
    args = parser.parse_args()
    print(json.dumps(install_dynamic_references(args.pack)))
