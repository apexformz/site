"""Refresh existing provisional static reference data without regenerating rules or phases.

Run extract_reference_vectors.ts first, then seal/validate the pack after this tool.
Existing thresholds, taxonomy, criteria and phase graphs remain byte-for-byte intact.
New or removed reference models need a separate explicit pack review.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.gen_squash_pack import rms
from tools.prepare_capture_dataset import digest, write_json


def refresh(manifest: Path, vectors: Path, pack: Path, report_path: Path):
    data = json.loads(vectors.read_text(encoding="utf-8"))
    source = json.loads(manifest.read_text(encoding="utf-8"))
    refs = data["vectors"]
    files = {p.stem: p for p in (pack / "models/reference").glob("*.json")}
    eligible = {mid for mid, values in refs.items() if len(values) >= 2}
    if set(files) != eligible:
        raise ValueError("reference model membership changed; explicit pack review required")
    frozen = {name: digest(pack / name) for name in ("phase_graphs.json", "technique_criteria.json", "movement_catalog.json", "feedback_templates.json")}
    staged = []
    for mid, p in files.items():
        model = json.loads(p.read_text(encoding="utf-8"))
        if model.get("validation_status") != "provisional" or model["features"] != data["features"]:
            raise ValueError("only matching existing provisional reference models may be refreshed")
        values = refs[mid]
        best = None
        for other, candidates in refs.items():
            if other == mid:
                continue
            for a in values:
                for b in candidates:
                    if a["view"] != b["view"]:
                        continue
                    distance = rms(a["values"], b["values"], model["weights"])
                    if distance is not None and (best is None or distance < best[0]):
                        best = (distance, other)
        old_hash = digest(p)
        model.update(reference_vectors=[v["values"] for v in values], reference_views=[v["view"] for v in values],
                     reference_handedness=[v.get("handedness", "unknown") for v in values],
                     reference_handedness_assumed=[v.get("handedness_assumed", True) for v in values],
                     nearest_other_movement={"movement_id": best[1], "rms_deg": round(best[0], 1)} if best else None)
        model["source_dataset"] = {"dataset_version": source["dataset_version"], "manifest_sha256": digest(manifest),
                                    "reference_vectors_sha256": digest(vectors), "parent_reference_sha256": old_hash}
        model["provenance"] = (f"Capture-labeled Data Capture static poses ({len(values)} captures), extracted with deployed feature engine and global quality checks. "
                               "Pixel orientation corrected only for audited exact sources; source handedness is recorded, never inferred. "
                               "Weighted RMS to same-view references. One athlete; technique correctness and thresholds remain unvalidated.")
        staged.append((p, model, old_hash))
    for p, model, _ in staged:
        write_json(p, model)
    if any(digest(pack / name) != value for name, value in frozen.items()):
        raise ValueError("unrelated pack assets changed during reference refresh")
    report = {"status": "completed", "dataset_version": source["dataset_version"], "dataset_sha256": digest(manifest),
              "captures_used": data["captures_used"], "captures_skipped": data["captures_skipped"], "rejected_frames": data["rejected_frames"],
              "models": len(staged), "validation_status": "provisional", "unchanged_assets": frozen,
              "files": [{"path": str(p), "parent_sha256": old, "sha256": digest(p)} for p, _, old in staged]}
    write_json(report_path, report)
    print(json.dumps({k: v for k, v in report.items() if k not in ("files", "unchanged_assets")}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--vectors", type=Path, required=True)
    ap.add_argument("--pack", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    args = ap.parse_args()
    refresh(args.manifest, args.vectors, args.pack, args.report)
