"""Regenerate label_schema.json and the class lists in the squash train configs from the sealed pack.

    python ml/sports/squash/sync_from_pack.py
"""
from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[3]
PACK = ROOT / "sport-packs" / "squash"
HERE = pathlib.Path(__file__).resolve().parent


def load(name: str) -> dict:
    return json.loads((PACK / name).read_text(encoding="utf-8"))


def build_label_schema() -> dict:
    manifest = load("manifest.json")
    movements = load("movement_catalog.json")["movements"]
    graphs = {g["movement_id"]: g for g in load("phase_graphs.json")["graphs"]}
    criteria = load("technique_criteria.json")["criteria"]
    by_mov: dict[str, list[str]] = {}
    for c in criteria:
        by_mov.setdefault(c["movement_id"], []).append(c["criterion_id"])
    out = {
        "schema_version": "1.0.0",
        "sport_pack_id": manifest["id"],
        "sport_pack_version": manifest["version"],
        "unknown_label": "UNKNOWN",
        "criterion_outcomes": ["PASS", "IMPROVE", "UNCERTAIN", "NOT_ASSESSABLE"],
        "views": ["front", "back", "left", "right", "front_left", "front_right", "back_left", "back_right", "top"],
        "execution_attributes": {
            "corner": ["front_left", "front_right", "back_left", "back_right", None],
            "service_box": ["left", "right", None],
            "static": [True, False],
        },
        "taxonomy": [{"family_id": fam["id"], "name": fam["name"], "type": fam["type"], "groups": [{"group_id": g["id"], "name": g["name"], "members": g["members"]} for g in fam["groups"]]} for fam in load("movement_catalog.json").get("taxonomy", {}).get("families", [])],
        "movements": [
            {
                "movement_id": m["id"],
                "canonical_name": m["canonical_name"],
                "type": m["type"],
                "aliases": [a["name"] for a in m["aliases"] if a["status"] == "approved"],
                "permitted_views": m["permitted_views"],
                "phases": [{"phase_id": p["id"], "kind": p["kind"], "contact_evidence": p["contact_evidence"]} for p in graphs[m["id"]]["phases"]],
                "criteria": by_mov.get(m["id"], []),
                "hard_negatives": [s["movement_id"] for s in m.get("similar", []) if s.get("hard_negative")],
                "family_id": m.get("family_id"),
                "group_id": m.get("group_id"),
                "data_status": m.get("data_status"),
            }
            for m in movements
        ],
    }
    return out


def classes(schema: dict) -> list[str]:
    dyn = [m["movement_id"] for m in schema["movements"] if m["type"] == "dynamic"]
    return dyn + [schema["unknown_label"]]


def main() -> None:
    schema = build_label_schema()
    (HERE / "label_schema.json").write_text(json.dumps(schema, indent=2) + "\n", encoding="utf-8")
    cls = classes(schema)
    for name in ("train_config.tcn.json", "train_config.stgcnpp.json"):
        p = HERE / name
        cfg = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
        cfg["classes"] = cls
        p.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    print(f"label schema: {len(schema['movements'])} movements, {len(cls)} recognizer classes")


if __name__ == "__main__":
    main()
