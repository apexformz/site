"""Derive a pinned manifest by re-extracting only exact visually audited still images.

Original media/poses are never modified. Snapshot manifests preserve original bytes;
their pose paths remain relative to the original dataset directory recorded in the
snapshot provenance. No phase, correctness, consent or athlete facts are inferred.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, as_completed
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import multiprocessing
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.prepare_capture_dataset import digest, extract_record, initialize_pose_worker, load_orientation_overrides, write_json


def derive_manifest(parent: dict, replacements: dict[str, dict], *, parent_sha256: str, audit_sha256: str, snapshot: str) -> dict:
    result = deepcopy(parent)
    cameras = {row["camera_id"]: row for row in result["cameras"]}
    seen = set()
    for stream in result["view_streams"]:
        rid = stream.get("source_record_id")
        if rid not in replacements:
            continue
        meta = replacements[rid]
        if meta["source_sha256"] != stream["sha256"] or meta["pose_model"] != result["pose_model"]:
            raise ValueError("replacement source/model differs from pinned parent")
        if meta["frames"] != 1 or meta["start_ms"] != 0 or meta["end_ms"] != 0:
            raise ValueError("a corrected still image must remain exactly one observed instant")
        if meta["video"]["width"] <= meta["video"]["height"]:
            raise ValueError("reviewed correction did not produce landscape pixels")
        stream["orientation_lineage"] = {"parent_pose_path": stream["pose_path"], "parent_pose_sha256": stream["pose_sha256"],
                                         "parent_extraction": stream["extraction"]}
        for field in ("pose_path", "pose_sha256", "extraction"):
            stream[field] = meta[field]
        stream["extraction_code_sha256"] = meta["extractor_sha256"]
        cameras[stream["camera_id"]]["resolution"] = [meta["video"]["width"], meta["video"]["height"]]
        seen.add(rid)
    if seen != set(replacements):
        raise ValueError("every replacement must match exactly one pinned source stream")
    identity = {"parent_manifest_sha256": parent_sha256, "orientation_audit_sha256": audit_sha256,
                "replacements": {rid: replacements[rid]["pose_sha256"] for rid in sorted(replacements)}}
    version = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    result["dataset_version"] = f"squash-static_pose-orientation-{version[:16]}"
    result["created_at"] = datetime.now(timezone.utc).isoformat()
    processing = result["provenance"]["processing_config"]
    processing["parent_dataset_identity"] = processing.get("dataset_identity")
    processing["dataset_identity"] = identity
    result["orientation_correction"] = {**identity, "parent_dataset_version": parent["dataset_version"],
        "parent_snapshot": snapshot, "source_media_modified": False, "unchanged_stream_count": len(result["view_streams"]) - len(replacements),
        "corrected_stream_count": len(replacements), "review_scope": "pixel orientation only; no movement/phase/technique approval"}
    return result


def apply(manifest_path: Path, inventory_path: Path, overrides_path: Path, snapshot_dir: Path, workers: int = 4) -> dict:
    if not 1 <= workers <= 8:
        raise ValueError("workers must be between 1 and 8")
    manifest_path = manifest_path.resolve()
    root = manifest_path.parent
    parent_hash = digest(manifest_path)
    parent = json.loads(manifest_path.read_text(encoding="utf-8"))
    if parent.get("sport_pack_id") != "squash" or parent.get("model_task") != "static_pose":
        raise ValueError("only the squash static-pose manifest can be corrected")
    overrides = load_orientation_overrides(overrides_path)
    audit_hash = digest(overrides_path)
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    records = {r["record_id"]: r for r in inventory["records"]}
    streams = {s["source_record_id"]: s for s in parent["view_streams"]}
    if set(overrides) - set(streams):
        raise ValueError("orientation audit contains sources outside the pinned prepared manifest")
    selected = []
    for rid, override in overrides.items():
        record, stream = records[rid], streams[rid]
        if stream["sha256"] != override["source_sha256"] or stream["object_uri"] != override["source_uri"]:
            raise ValueError("orientation audit differs from the pinned manifest source")
        if digest(Path(record["local_path"])) != stream["sha256"]:
            raise ValueError("source media checksum changed")
        if stream.get("extraction", {}).get("orientation_override"):
            raise ValueError("source already has an orientation correction; do not apply twice")
        options = {**stream["extraction"], "orientation_overrides": str(overrides_path.resolve())}
        selected.append((record, options))
    # Preserve exact prior manifests and artifacts before creating a derived dataset.
    snapshot_dir.mkdir(parents=True, exist_ok=False)
    paths = [manifest_path, root / "dataset_dynamic_movement.json", root / "preparation_report.json",
             ROOT / "ml/sports/squash/reference_vectors.json", ROOT / "ml/sports/squash/athlete_attestations.json"]
    paths += list((ROOT / "sport-packs/squash").glob("*.json"))
    paths += list((ROOT / "sport-packs/squash/models/reference").glob("*.json"))
    paths += list((ROOT / "apps/frontend/public/models/squash").glob("*"))
    pins = []
    for source in paths:
        if not source.is_file():
            continue
        target = snapshot_dir / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        checksum = digest(source)
        if digest(target) != checksum:
            raise ValueError("snapshot checksum mismatch")
        pins.append({"source": str(source), "snapshot": str(target), "sha256": checksum})
    write_json(snapshot_dir / "snapshot_provenance.json", {"original_dataset_directory": str(root), "files": pins,
        "note": "Exact byte snapshots. Relative pose paths resolve against original_dataset_directory; original media and pose files retained."})
    extracted = {}
    with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"),
                             initializer=initialize_pose_worker, initargs=(selected[0][1],)) as pool:
        pending = {pool.submit(extract_record, record, root, options): record["record_id"] for record, options in selected}
        for future in as_completed(pending):
            rid = pending[future]
            extracted[rid] = future.result()
            print(json.dumps({"corrected": len(extracted), "total": len(selected), "record_id": rid}), flush=True)
    if digest(manifest_path) != parent_hash or digest(overrides_path) != audit_hash:
        raise ValueError("parent manifest or orientation audit changed during extraction")
    updated = derive_manifest(parent, extracted, parent_sha256=parent_hash, audit_sha256=audit_hash,
                              snapshot=str((snapshot_dir / manifest_path.relative_to(ROOT)).resolve()))
    from jsonschema import Draft202012Validator
    schema = json.loads((ROOT / "ml/datasets/dataset_manifest.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(updated)
    for stream in updated["view_streams"]:
        if digest(root / stream["pose_path"]) != stream["pose_sha256"]:
            raise ValueError("derived manifest pose checksum mismatch")
    for record, _ in selected:
        if digest(Path(record["local_path"])) != streams[record["record_id"]]["sha256"]:
            raise ValueError("source media changed during extraction")
    write_json(manifest_path, updated)
    report = {"status": "completed", "manifest_path": str(manifest_path), "parent_manifest_sha256": parent_hash,
              "manifest_sha256": digest(manifest_path), "dataset_version": updated["dataset_version"],
              "orientation_audit_sha256": audit_hash, "corrected_still_images": len(extracted),
              "source_media_modified": False, "dynamic_manifest_modified": False, "snapshot": str(snapshot_dir.resolve()),
              "pose_policy": "current subject selector; original ambiguity is not overridden",
              "training_or_coaching_validation_claimed": False}
    write_json(root / "orientation_correction_report.json", report)
    print(json.dumps(report), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--overrides", type=Path, required=True)
    parser.add_argument("--snapshot-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    apply(args.manifest, args.inventory, args.overrides, args.snapshot_dir, args.workers)


if __name__ == "__main__":
    main()
