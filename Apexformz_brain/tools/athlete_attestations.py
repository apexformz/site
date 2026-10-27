"""Apply owner attestations (handedness, consent) to prepared capture dataset manifests.

Data Capture records carry no handedness and an unknown consent status for some athletes. When the project owner
confirms these facts, they are recorded in ml/sports/squash/athlete_attestations.json and applied here, keeping the
original recorded value beside the attested one so the change is auditable. Nothing is inferred from pose data.

  python tools/athlete_attestations.py --attestations ml/sports/squash/athlete_attestations.json \
      data/squash/dataset_static_pose.json data/squash/dataset_dynamic_movement.json

prepare_capture_dataset.py applies the same function when given --attestations, so re-preparing keeps them.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_attestations(path: Path | None) -> dict:
    if not path:
        return {}
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return doc.get("athletes", {})


def apply_attestations(manifest: dict, attestations: dict, source: str = "athlete_attestations.json") -> dict:
    """Mutate and return the manifest. Only athletes present in `attestations` change."""
    if not attestations:
        return manifest
    applied = []
    for athlete in manifest.get("athletes", []):
        att = attestations.get(athlete.get("athlete_id"))
        if not att:
            continue
        rec = {"athlete_id": athlete["athlete_id"], "attested_by": att.get("attested_by"), "attested_at": att.get("attested_at")}
        if att.get("handedness") in ("left", "right"):
            athlete["recorded_handedness"] = athlete.get("recorded_handedness", athlete.get("handedness", "unknown"))
            athlete["handedness"] = att["handedness"]
            athlete["handedness_source"] = "owner_attestation"
            rec["handedness"] = att["handedness"]
        if att.get("consent"):
            c = att["consent"]
            consent = athlete.setdefault("consent", {})
            consent.setdefault("recorded_source_status", consent.get("source_status", "unknown"))
            consent.update({"source_status": c.get("status", consent.get("source_status")), "purpose": c.get("purpose", consent.get("purpose", [])),
                            "retention_until": c.get("retention_until", consent.get("retention_until")), "scope": c.get("scope"),
                            "evidence": c.get("evidence"), "status_source": "owner_attestation"})
            rec["consent"] = c.get("status")
        applied.append(rec)
    ids = {a["athlete_id"] for a in applied if a.get("handedness")}
    hands = {a["athlete_id"]: a["handedness"] for a in applied if a.get("handedness")}
    by_exec = {e["execution_id"]: e.get("athlete_id") for e in manifest.get("executions", [])}
    stream_athlete = {sid: e.get("athlete_id") for e in manifest.get("executions", []) for sid in e.get("view_stream_ids", [])}
    for st in manifest.get("view_streams", []):
        aid = stream_athlete.get(st.get("view_stream_id"))
        if aid in ids:
            st["handedness"] = hands[aid]
            st["handedness_source"] = "owner_attestation"
    for an in manifest.get("annotations", []):
        aid = by_exec.get(an.get("execution_id"))
        if aid in ids and isinstance(an.get("labels"), dict):
            an["labels"]["handedness"] = hands[aid]
    prov = manifest.setdefault("provenance", {}).setdefault("processing_config", {})
    prov["athlete_attestations"] = {"source": source, "applied": applied}
    # The consent blocker no longer applies once purpose and retention are attested for every athlete.
    if all(a.get("consent", {}).get("purpose") and a.get("consent", {}).get("retention_until") not in (None, "unknown") for a in manifest.get("athletes", [])):
        manifest["release_blockers"] = [b for b in manifest.get("release_blockers", []) if "training-purpose/retention" not in b]
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--attestations", type=Path, required=True)
    ap.add_argument("manifests", type=Path, nargs="+")
    a = ap.parse_args()
    att = load_attestations(a.attestations)
    for p in a.manifests:
        m = json.loads(p.read_text(encoding="utf-8"))
        apply_attestations(m, att, str(a.attestations).replace("\\", "/"))
        p.write_text(json.dumps(m, indent=2) + "\n", encoding="utf-8")
        hands = sorted({x.get("handedness") for x in m.get("athletes", [])})
        print(json.dumps({"manifest": str(p), "athletes": len(m.get("athletes", [])), "handedness": hands, "applied": m["provenance"]["processing_config"]["athlete_attestations"]["applied"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
