"""Export capture-linked squash review tasks and validate independently reviewed labels.

This never infers phases, technique outcomes, handedness, or coach approval. It
does not modify the capture manifests, models, splits, or sport pack.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTCOMES = {"PASS", "IMPROVE", "UNCERTAIN", "NOT_ASSESSABLE"}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n" for row in rows), encoding="utf-8")


def export_review(manifest_paths: list[Path], pack_dir: Path, out: Path, inventory: Path | None = None):
    catalog = read_json(pack_dir / "movement_catalog.json")
    if catalog.get("sport_id") != "squash":
        raise ValueError("Only the squash pack is supported")
    movements = {m["id"]: m for m in catalog["movements"]}
    graphs = {g["movement_id"]: g for g in read_json(pack_dir / "phase_graphs.json")["graphs"]}
    criteria = read_json(pack_dir / "technique_criteria.json")["criteria"]
    local_media = {}
    if inventory:
        local_media = {r["record_id"]: r.get("local_path") for r in read_json(inventory)["records"]}
    sources, tasks, pins, split_groups = {}, [], [], {}
    for manifest_path in manifest_paths:
        manifest = read_json(manifest_path)
        if manifest.get("sport_pack_id") != "squash":
            raise ValueError(f"Non-squash manifest: {manifest_path}")
        pins.append({"path": str(manifest_path.resolve()), "sha256": digest(manifest_path)})
        streams = {s["view_stream_id"]: s for s in manifest["view_streams"]}
        assignments = manifest["splits"]["assignments"]
        for execution in manifest["executions"]:
            eid, mid = execution["execution_id"], execution["movement_id"]
            if eid in sources or mid not in movements:
                raise ValueError(f"Duplicate execution or unknown movement: {eid}, {mid}")
            split = assignments.get(eid)
            if split not in {"train", "val", "test"}:
                raise ValueError(f"Missing split for {eid}")
            for group in (execution.get("athlete_id"), execution.get("capture_session_id"), execution.get("source_sha256")):
                if group and group != "unknown":
                    if group in split_groups and split_groups[group] != split:
                        raise ValueError(f"Split leakage for {group}")
                    split_groups[group] = split
            source = {**execution, "split": split, "streams": {}}
            for sid in execution["view_stream_ids"]:
                stream = streams[sid]
                uri = stream.get("object_uri", "")
                if not uri.startswith("s3://apexformz-datacapture-") or "/raw/squash/" not in uri:
                    raise ValueError(f"Source is not squash Data Capture: {sid}")
                if stream.get("extraction", {}).get("orientation_policy") != "encoded":
                    raise ValueError(f"Expected encoded landscape extraction: {sid}")
                source["streams"][sid] = {
                    "source_uri": uri, "source_sha256": stream["sha256"],
                    "source_version_id": stream.get("source_version_id"), "view": stream["view"],
                    "handedness": stream.get("handedness", "unknown"), "handedness_source": stream.get("handedness_source", "capture_dataset"),
                    "orientation_policy": "encoded", "local_media_path": local_media.get(stream.get("source_record_id")),
                    "orientation_override": stream.get("extraction", {}).get("orientation_override"),
                    "pose_path": str((manifest_path.parent / stream["pose_path"]).resolve()),
                    "pose_sha256": stream["pose_sha256"],
                }
                tasks.append({
                    "execution_id": eid if len(execution["view_stream_ids"]) == 1 else f"{eid}/{sid}",
                    "source_execution_id": eid, "stream_id": sid, "movement_id": mid,
                    "review_status": "pending", "annotator_id": None, "annotation_version": None,
                    "start_ms": None, "end_ms": None, "static": execution["static"],
                    "view": stream["view"], "handedness": stream.get("handedness", "unknown"), "phases": [],
                    "criteria": {cid: None for cid in movements[mid]["criteria"]},
                    "disagreement": None,
                })
            sources[eid] = source
    pack_pins = {name: digest(pack_dir / name) for name in ("movement_catalog.json", "phase_graphs.json", "technique_criteria.json")}
    bundle = {"schema_version": "1.0.0", "sport_pack_id": "squash", "manifests": pins,
              "pack_dir": str(pack_dir.resolve()), "pack_sha256": pack_pins, "sources": sources,
              "instructions": [
                  "Copy tasks.template.jsonl to a separate reviewed file; never use pending tasks as training labels.",
                  "Supply real annotator_id, positive annotation_version and review_status reviewed; retain original reviews separately.",
                  "Mark execution boundaries and phases on the source monotonic millisecond clock; static photos have start=end=0 and no duration phases.",
                  "Split repeated movements into unique execution_ids with the same source_execution_id; the source split is inherited.",
                  "Review movement identity independently. Use UNKNOWN only for an actually reviewed unknown movement.",
                  "Fill every applicable criterion with PASS, IMPROVE, UNCERTAIN or NOT_ASSESSABLE. Never infer PASS from an expert movement-name label.",
                  "Use the rubric file for phase IDs, views and capabilities. Body pose cannot verify ball contact.",
                  "Confirm the handedness copied from the source dataset; keep unknown when no reviewed value exists. Do not rotate encoded landscape pixels using the incorrect media metadata.",
                  "When a stream supplies orientation_override, display original media with exactly its audited rotate_degrees_ccw transform; corrected pose coordinates already include that transform. Do not rotate the corrected poses again.",
                  "Unresolved disagreements block fitting. Keep duplicate expert reviews separately for agreement analysis and adjudication.",
              ]}
    # A new folder prevents accidental destruction of completed human annotations.
    out.mkdir(parents=True, exist_ok=False)
    write_json(out / "bundle.json", bundle)
    write_jsonl(out / "tasks.template.jsonl", tasks)
    write_json(out / "rubric.json", {"movements": list(movements.values()), "graphs": list(graphs.values()), "criteria": criteria})
    return {"sources": len(sources), "review_tasks": len(tasks), "reviewed": 0, "out": str(out)}


def finite_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_reviews(bundle: dict, rubric: dict, rows: list[dict]):
    """Validate all rows before emitting any fitting inputs; return canonical rows and splits."""
    movements = {m["id"]: m for m in rubric["movements"]}
    graphs = {g["movement_id"]: g for g in rubric["graphs"]}
    seen, occupied, result, assignments = set(), {}, [], {}
    for index, row in enumerate(rows, 1):
        def require(condition, reason):
            if not condition:
                raise ValueError(f"row {index}: {reason}")
        require(isinstance(row, dict), "annotation must be an object")
        eid = row.get("execution_id")
        require(isinstance(eid, str) and bool(eid.strip()) and eid not in seen, "unique execution_id required")
        seen.add(eid)
        source = bundle["sources"].get(row.get("source_execution_id"))
        require(source is not None, "unknown source_execution_id")
        stream = source["streams"].get(row.get("stream_id"))
        require(stream is not None, "stream does not belong to the source capture")
        require(row.get("review_status") == "reviewed", "review_status must be reviewed")
        annotator = row.get("annotator_id")
        require(isinstance(annotator, str) and bool(annotator.strip()) and not annotator.startswith("importer:"), "real annotator_id required")
        version = row.get("annotation_version")
        require(type(version) is int and version > 0, "positive annotation_version required")
        require("disagreement" in row and row["disagreement"] is None, "unresolved disagreement cannot be fitted")
        require(row.get("view") == stream["view"], "view differs from the captured stream")
        require(row.get("handedness") in {"left", "right", "unknown"}, "invalid handedness")
        require(type(row.get("static")) is bool and row["static"] == source["static"], "static/dynamic type must match source")
        mid = row.get("movement_id")
        require(mid == "UNKNOWN" or mid in movements, "unknown movement ID")
        movement = movements.get(mid)
        if movement:
            require((movement["type"] == "static") == row["static"], "movement type mismatch")
        start, end = row.get("start_ms"), row.get("end_ms")
        require(finite_number(start) and finite_number(end), "finite execution boundaries required")
        photo = source["static"] and source["start_ms"] == source["end_ms"]
        require(source["start_ms"] <= start <= end <= source["end_ms"], "boundaries exceed source capture")
        require(photo or start < end, "dynamic/hold executions need positive duration")
        phases = row.get("phases")
        require(isinstance(phases, list), "phases must be a list")
        if mid == "UNKNOWN" or photo:
            require(not phases, "unknown movements and single photos cannot supply temporal phases")
        allowed_phases = {p["id"] for p in graphs[mid]["phases"]} if movement else set()
        edges = {(e["from"], e["to"]) for e in graphs[mid].get("edges", [])} if movement else set()
        previous_phase, previous_end = None, start
        for phase in phases:
            require(isinstance(phase, dict), "phase must be an object")
            pid, ps, pe = phase.get("phase_id"), phase.get("start_ms"), phase.get("end_ms")
            require(pid in allowed_phases, "invalid phase ID")
            require(previous_phase is None or (previous_phase, pid) in edges, "transition is absent from the phase graph")
            require(finite_number(ps) and finite_number(pe), "finite phase boundaries required")
            require(previous_end <= ps < pe <= end, "phase boundaries overlap or exceed execution")
            previous_phase = pid
            previous_end = pe
        outcomes = row.get("criteria")
        require(isinstance(outcomes, dict), "criteria must be an object")
        expected = set(movement["criteria"]) if movement else set()
        require(set(outcomes) == expected, "supply exactly the movement's criteria (NOT_ASSESSABLE where unobservable)")
        require(all(isinstance(v, str) and v in OUTCOMES for v in outcomes.values()), "missing or invalid criterion outcome")
        key = (row["source_execution_id"], row["stream_id"])
        for a, b in occupied.get(key, []):
            require(not (photo or max(a, start) < min(b, end)), "overlapping executions/duplicate photo review; adjudicate separately")
        occupied.setdefault(key, []).append((start, end))
        assignments[eid] = source["split"]
        result.append({**row, "athlete_id": source["athlete_id"], "capture_session_id": source["capture_session_id"],
                       "source_sha256": stream["source_sha256"], "split": source["split"]})
    if not result:
        raise ValueError("No reviewed annotations supplied")
    return result, {"assignments": assignments, "strategy": "inherited_from_pinned_capture_manifests"}


def verify_bundle(bundle_path: Path, *, verify_local_files: bool = False):
    """Verify source provenance without treating pending review tasks as human labels."""
    bundle = read_json(bundle_path)
    source_ids = set()
    pose_files, media_files = {}, {}
    for pin in bundle["manifests"]:
        manifest_path = Path(pin["path"])
        if digest(manifest_path) != pin["sha256"]:
            raise ValueError("Capture manifest changed; export a new review bundle")
        manifest = read_json(manifest_path)
        streams = {s["view_stream_id"]: s for s in manifest["view_streams"]}
        for execution in manifest["executions"]:
            eid = execution["execution_id"]
            source_ids.add(eid)
            snapshot = bundle["sources"].get(eid, {})
            if (any(snapshot.get(k) != v for k, v in execution.items())
                    or snapshot.get("split") != manifest["splits"]["assignments"].get(eid)
                    or set(snapshot.get("streams", {})) != set(execution["view_stream_ids"])):
                raise ValueError(f"Review bundle source differs from pinned manifest: {eid}")
            for sid in execution["view_stream_ids"]:
                stream = streams[sid]
                expected = {"source_uri": stream["object_uri"], "source_sha256": stream["sha256"],
                            "source_version_id": stream.get("source_version_id"), "view": stream["view"],
                            "handedness": stream.get("handedness", "unknown"), "handedness_source": stream.get("handedness_source", "capture_dataset"),
                            "pose_path": str((manifest_path.parent / stream["pose_path"]).resolve()),
                            "pose_sha256": stream["pose_sha256"], "orientation_policy": stream["extraction"]["orientation_policy"],
                            "orientation_override": stream.get("extraction", {}).get("orientation_override")}
                if any(snapshot["streams"][sid].get(k) != v for k, v in expected.items()):
                    raise ValueError(f"Review bundle stream differs from pinned manifest: {sid}")
                if verify_local_files:
                    pose_files[expected["pose_path"]] = expected["pose_sha256"]
                    local_media = snapshot["streams"][sid].get("local_media_path")
                    if not local_media:
                        raise ValueError(f"No local review media for {sid}; export with the current inventory")
                    media_files[local_media] = expected["source_sha256"]
    if set(bundle["sources"]) != source_ids:
        raise ValueError("Review bundle contains sources outside its pinned manifests")
    for name, checksum in bundle["pack_sha256"].items():
        if digest(Path(bundle["pack_dir"]) / name) != checksum:
            raise ValueError(f"Pack {name} changed; export a new review bundle")
    for name, checksum in {**pose_files, **media_files}.items():
        if digest(Path(name)) != checksum:
            raise ValueError(f"Review source file digest mismatch: {name}")
    return {"status": "passed", "sources": len(source_ids), "pose_files_verified": len(pose_files),
            "media_files_verified": len(media_files), "bundle_sha256": digest(bundle_path),
            "human_labels_validated": False, "coach_approval_inferred": False}


def validate_files(bundle_path: Path, labels_path: Path, out: Path):
    verify_bundle(bundle_path)
    bundle = read_json(bundle_path)
    # Use the pinned current pack, not an editable rubric copy, as validation authority.
    pack = Path(bundle["pack_dir"])
    rubric = {"movements": read_json(pack / "movement_catalog.json")["movements"],
              "graphs": read_json(pack / "phase_graphs.json")["graphs"]}
    rows = [json.loads(line) for line in labels_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    reviewed, splits = validate_reviews(bundle, rubric, rows)
    out.mkdir(parents=True, exist_ok=False)
    write_jsonl(out / "labels.jsonl", reviewed)
    write_json(out / "splits.json", splits)
    summary = {"reviewed_executions": len(reviewed), "executions_with_phases": sum(bool(r["phases"]) for r in reviewed),
               "criterion_outcomes": sum(len(r["criteria"]) for r in reviewed), "labels_sha256": digest(labels_path),
               "bundle_sha256": digest(bundle_path), "coach_approval_inferred": False}
    write_json(out / "validation.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export")
    export.add_argument("--manifest", action="append", type=Path, required=True)
    export.add_argument("--pack", type=Path, default=ROOT / "sport-packs/squash")
    export.add_argument("--inventory", type=Path)
    export.add_argument("--out", type=Path, required=True)
    check = commands.add_parser("validate")
    check.add_argument("--bundle", type=Path, required=True)
    check.add_argument("--labels", type=Path, required=True)
    check.add_argument("--out", type=Path, required=True)
    verify = commands.add_parser("verify", help="Verify pinned manifests, pack, poses and local media; no human review inferred")
    verify.add_argument("--bundle", type=Path, required=True)
    verify.add_argument("--out", type=Path, required=True, help="New verification report; existing files are not overwritten")
    args = parser.parse_args()
    if args.command == "export":
        report = export_review(args.manifest, args.pack, args.out, args.inventory)
    elif args.command == "validate":
        report = validate_files(args.bundle, args.labels, args.out)
    else:
        report = verify_bundle(args.bundle, verify_local_files=True)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open("x", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2, allow_nan=False)
            handle.write("\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
