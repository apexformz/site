"""Attach source-label coverage, including failed captures, after preparation."""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.prepare_capture_dataset import digest, write_json


def annotate_source_coverage(inventory_path: Path, out_dir: Path) -> dict:
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    report_path = out_dir / "preparation_report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    inventory_sha = digest(inventory_path)
    if report["source_inventory_sha256"] != inventory_sha:
        raise ValueError("Preparation report does not match this source inventory")
    records = [r for r in inventory["records"] if r.get("local_path") and not r.get("superseded")
               and r.get("validation", {}).get("eligible_media", False)
               and r.get("consent", {}).get("status") not in {"WITHDRAWN", "PENDING"}
               and (r.get("source_movement_id") or r.get("source_movement_name"))]
    failures = {failure["record_id"]: failure["reason"] for failure in report["failures"]}
    catalogs, prepared_outputs = {}, []
    for task, mode in (("static_pose", "static"), ("dynamic_movement", "dynamic")):
        selected = [r for r in records if (r.get("movement_type") or ("static" if r["media_kind"] == "image" else "dynamic")) == mode]
        manifest_path = out_dir / f"dataset_{task}.json"
        manifest = None
        prepared_ids = set()
        if task in report["datasets"]:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if manifest["provenance"]["processing_config"]["inventory_sha256"] != inventory_sha:
                raise ValueError(f"{task} manifest does not match this source inventory")
            prepared_ids = {stream["source_record_id"] for stream in manifest["view_streams"]}
        catalog = {}
        for record in selected:
            label = record.get("source_movement_id") or record["source_movement_name"]
            entry = catalog.setdefault(label, {"name": record.get("source_movement_name") or label,
                                               "source_capture_count": 0, "prepared_capture_count": 0,
                                               "exclusion_reasons": Counter()})
            entry["source_capture_count"] += 1
            if record["record_id"] in prepared_ids:
                entry["prepared_capture_count"] += 1
            else:
                reason = failures.get(record["record_id"], "not_in_prepared_dataset")
                entry["exclusion_reasons"][reason] += 1
        catalogs[task] = {label: {**entry, "exclusion_reasons": dict(entry["exclusion_reasons"])} for label, entry in sorted(catalog.items())}
        if manifest is not None:
            manifest["source_label_catalog"] = catalogs[task]
            prepared_outputs.append((manifest_path, manifest))
    # Validate both manifests before changing either one.
    for path, manifest in prepared_outputs:
        write_json(path, manifest)
    report["source_label_catalog"] = catalogs
    write_json(report_path, report)
    return catalogs


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    args = parser.parse_args()
    catalogs = annotate_source_coverage(args.inventory, args.out_dir)
    print(json.dumps({task: {"source_classes": len(labels),
                            "source_captures": sum(x["source_capture_count"] for x in labels.values()),
                            "prepared_captures": sum(x["prepared_capture_count"] for x in labels.values()),
                            "classes_lost_in_preparation": [label for label, x in labels.items() if not x["prepared_capture_count"]]}
                      for task, labels in catalogs.items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
