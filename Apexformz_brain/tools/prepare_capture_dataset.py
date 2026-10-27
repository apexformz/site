"""Extract real capture media and build reproducible squash training manifests.

No phase boundaries or coaching correctness labels are inferred from filenames.
Static images remain one observed frame; views and related captures never get
randomly split at frame level. A lack of independent athletes is reported.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from functools import lru_cache
from importlib.metadata import version as package_version
import json
import math
import multiprocessing
import os
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parents[1]
for package in (ROOT, ROOT / "packages/perception-py", ROOT / "packages/contracts/python"):
    sys.path.insert(0, str(package))


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def digest_json(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    partial.replace(path)


def identifiable(value: str | None) -> bool:
    return bool(value and value.lower() not in {"unknown", "unspecified", "team recording", "unknown-identity"})


def assign_splits(executions: list[dict], seed: int) -> dict:
    """Prefer athlete holdouts; otherwise retain conservative capture groups.

    Never move a lone class into a holdout at the expense of training coverage.
    When meaningful holdouts are impossible, train a development model and say so.
    """
    all_known = all(identifiable(ex.get("athlete_id")) for ex in executions)
    athlete_count = len({ex["athlete_id"] for ex in executions if identifiable(ex.get("athlete_id"))})
    athlete_disjoint = all_known and athlete_count >= 3
    # Union every shared identity, session, capture group, stream and source file.
    # A shortage of athletes must never turn repeated views of that athlete into
    # apparently independent training/validation samples.
    parents = list(range(len(executions)))

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    owners = {}
    for index, ex in enumerate(executions):
        identity = ex.get("athlete_id") if identifiable(ex.get("athlete_id")) else "unknown"
        keys = [("athlete", identity)]
        for field in ("capture_session_id", "split_group_id", "source_sha256"):
            if ex.get(field):
                keys.append((field, ex[field]))
        keys.extend(("stream", stream) for stream in ex.get("view_stream_ids", []))
        for key in keys:
            if key in owners:
                parents[find(index)] = find(owners[key])
            owners[key] = index
    groups: dict[str, list[dict]] = defaultdict(list)
    execution_groups = {ex["execution_id"]: f"group-{find(index)}" for index, ex in enumerate(executions)}
    for ex in executions:
        groups[execution_groups[ex["execution_id"]]].append(ex)
    group_classes = {g: {e["movement_id"] for e in es} for g, es in groups.items()}
    class_groups = Counter(c for cs in group_classes.values() for c in cs)
    names = sorted(groups)
    random.Random(seed).shuffle(names)
    group_split = {g: "train" for g in groups}
    target = max(1, round(len(groups) * 0.15))
    for split in ("test", "val"):
        count = 0
        for group in names:
            if group_split[group] != "train" or count >= target:
                continue
            # Each capture class must remain represented in the training set.
            if len(groups) >= 3 and all(class_groups[c] >= 2 for c in group_classes[group]):
                group_split[group] = split
                for label in group_classes[group]:
                    class_groups[label] -= 1
                count += 1
    assignments = {ex["execution_id"]: group_split[execution_groups[ex["execution_id"]]] for ex in executions}
    counts = dict(Counter(assignments.values()))
    warnings = []
    if not athlete_disjoint:
        warnings.append("Insufficient independent known athletes: grouped development split, not evidence of generalization to new athletes.")
    if not counts.get("val"):
        warnings.append("No independent validation group available; thresholds cannot be calibrated on held-out validation data.")
    if not counts.get("test"):
        warnings.append("No independent test group available; training-set accuracy must not be presented as test accuracy.")
    return {"seed": seed, "assignments": assignments, "holdouts": {"locations": [], "cameras": []},
            "strategy": "athlete_disjoint" if athlete_disjoint else "capture_group_development",
            "athlete_disjoint": athlete_disjoint, "known_athletes": athlete_count,
            "groups": len(groups), "counts": counts, "warnings": warnings}


@lru_cache(maxsize=3)
def pose_model_identity(variant: str) -> dict:
    """Resolve the actual model bytes and installed runtime before cache lookup."""
    from apexformz_perception.pose.mediapipe_backend import ensure_model
    model_path = ensure_model(variant)
    return {"model_id": "mediapipe_pose_landmarker", "version": f"{variant}/float16/1/mediapipe-{package_version('mediapipe')}",
            "delegate": "CPU", "digest": digest(model_path)}


@lru_cache(maxsize=1)
def extraction_code_digest() -> str:
    base = ROOT / "packages/perception-py/apexformz_perception"
    paths = [Path(__file__)] + [base / relative for relative in (
        "pose/mediapipe_backend.py", "pose/extract.py", "pose/base.py", "pose/keypoint_sets.py",
        "subject/bytetrack.py", "io/video.py")]
    return hashlib.sha256(json.dumps({str(path.relative_to(ROOT)): digest(path) for path in paths}, sort_keys=True).encode()).hexdigest()


def pose_cache_id(record: dict, media_hash: str, options: dict, model: dict) -> str:
    identity = {"media_sha256": media_hash, "record_id": record["record_id"], "view": record.get("view", "unknown"),
                "options": options, "pose_model": model, "extractor_sha256": extraction_code_digest(),
                "opencv_version": package_version("opencv-python"), "numpy_version": package_version("numpy")}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def load_orientation_overrides(path: Path) -> dict[str, dict]:
    """Exact, visually audited source corrections; dimensions alone never authorize rotation."""
    document = json.loads(path.read_text(encoding="utf-8"))
    if (document.get("kind") != "apexformz.source_orientation_overrides" or document.get("schema_version") != "1.0.0"
            or document.get("review_status") != "visually_verified" or not document.get("reviewer_id")):
        raise ValueError("orientation overrides require a versioned visual audit and reviewer identity")
    result = {}
    for row in document.get("records", []):
        rid, checksum = row.get("record_id"), row.get("source_sha256", "")
        size = row.get("encoded_size")
        if (not isinstance(rid, str) or not rid or rid in result
                or len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum)
                or row.get("rotate_degrees_ccw") not in (90, 180, 270)
                or not isinstance(size, list) or len(size) != 2 or any(type(v) is not int or v <= 0 for v in size)
                or not row.get("reason") or not row.get("source_uri")):
            raise ValueError("invalid or duplicate source orientation override")
        result[rid] = {**row, "audit_document_sha256": digest(path), "audit_reviewer_id": document["reviewer_id"]}
    if not result:
        raise ValueError("orientation override audit is empty")
    return result


def record_extraction_options(record: dict, media_hash: str, options: dict) -> dict:
    options = dict(options)
    audit_path = options.pop("orientation_overrides", None)
    if audit_path:
        override = load_orientation_overrides(Path(audit_path)).get(record["record_id"])
        if override:
            if (record.get("media_kind") != "image" or options.get("orientation_policy") != "encoded"
                    or media_hash != override["source_sha256"] or record.get("source", {}).get("uri") != override["source_uri"]):
                raise ValueError("orientation override does not match exact encoded image source and checksum")
            options["orientation_override"] = override
    elif options.get("orientation_override"):
        raise ValueError("orientation_override must be resolved from an audited document")
    return options


def decode_capture_image(media: Path, orientation_policy: str, orientation_override: dict | None = None):
    import cv2
    import numpy as np
    if orientation_policy not in {"metadata", "encoded"}:
        raise ValueError("orientation_policy must be metadata or encoded")
    flags = cv2.IMREAD_COLOR | (cv2.IMREAD_IGNORE_ORIENTATION if orientation_policy == "encoded" else 0)
    frame = cv2.imdecode(np.fromfile(str(media), dtype=np.uint8), flags)
    if orientation_override:
        if orientation_policy != "encoded" or frame is None:
            raise ValueError("audited orientation correction requires decoded encoded pixels")
        if [frame.shape[1], frame.shape[0]] != orientation_override["encoded_size"]:
            raise ValueError("encoded image dimensions differ from orientation audit")
        rotations = {90: cv2.ROTATE_90_COUNTERCLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_CLOCKWISE}
        frame = cv2.rotate(frame, rotations[orientation_override["rotate_degrees_ccw"]])
    return frame


def select_still_subject(people):
    from apexformz_perception.subject.bytetrack import SubjectSelector
    detections = [(person.bbox_or_from_keypoints(), person.detection_score if person.detection_score else person.confidence()) for person in people]
    selection = SubjectSelector().select(detections)
    selected = people[selection.index] if selection.index is not None and selection.index < len(people) else None
    return selected, selection


def extract_record(record: dict, out_dir: Path, options: dict) -> dict:
    import cv2
    from apexformz_contracts import assert_valid
    from apexformz_perception.pose import create_backend
    from apexformz_perception.pose.extract import extract_pose_sequence

    options = {"orientation_policy": "metadata", **options}
    if options["orientation_policy"] not in {"metadata", "encoded"}:
        raise ValueError("orientation_policy must be metadata or encoded")
    honor_orientation = options["orientation_policy"] == "metadata"
    media = Path(record["local_path"])
    media_hash = digest(media)
    if record.get("local_sha256") and media_hash != record["local_sha256"]:
        raise ValueError("Cached media SHA256 changed since S3 download")
    options = record_extraction_options(record, media_hash, options)
    expected_model = pose_model_identity(options["variant"])
    cache_id = pose_cache_id(record, media_hash, options, expected_model)
    pose_file = out_dir / "poses" / f"{cache_id}.jsonl"
    meta_file = pose_file.with_suffix(".meta.json")
    if pose_file.exists() and meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            meta = {}
        if meta.get("cache_id") == cache_id and meta.get("pose_model") == expected_model and meta.get("pose_sha256") == digest(pose_file):
            return meta
    if options.get("athlete_identity"):
        # Identity-resolved poses are produced by tools/resolve_athlete_identity.py; never fall back silently.
        raise ValueError("identity-resolved poses missing for this record; run tools/resolve_athlete_identity.py with the same extraction options")

    backend = create_backend("mediapipe", variant=options["variant"], num_poses=2, prefer_gpu=False)
    try:
        provenance = backend.provenance()
        provenance["digest"] = digest(backend.model_path)
        if provenance != expected_model:
            raise ValueError("Pose model or runtime changed during extraction setup")
        if record["media_kind"] == "image":
            frame_bgr = decode_capture_image(media, options["orientation_policy"], options.get("orientation_override"))
            if frame_bgr is None:
                raise ValueError("Image cannot be decoded")
            h, w = frame_bgr.shape[:2]
            ratio = min(1.0, options["max_side"] / max(h, w))
            if ratio < 1:
                frame_bgr = cv2.resize(frame_bgr, (round(w * ratio), round(h * ratio)))
            h, w = frame_bgr.shape[:2]
            people = backend.detect(frame_bgr, 0.0, 0)
            # Match the video/live subject policy: dominant athlete with explicit
            # ambiguity for nearby competing people of comparable size.
            selected, selection = select_still_subject(people)
            frame = backend.to_mediapipe33_pose_frame(selected, session_id=record["record_id"], frame_id=0,
                timestamp_ms=0.0, camera_id=record.get("view", "unknown"), image_size=[w, h], mirror=False,
                orientation="portrait" if h > w else "landscape", tracked_subject_id=selection.track_id,
                person_count=selection.person_count, ambiguous=selection.ambiguous, track_changed=selection.track_changed)
            frames = [frame]
            video = {"width": w, "height": h, "fps": 0, "frame_count": 1}
        else:
            from apexformz_perception.io.video import probe
            info = probe(str(media), honor_orientation=honor_orientation)
            stride = max(1, round(info.fps / options["sample_hz"])) if info.fps else 1
            result = extract_pose_sequence(str(media), backend, record["record_id"], camera_id=record.get("view", "unknown"),
                stride=stride, max_side=options["max_side"], orientation="portrait" if info.height > info.width else "landscape",
                honor_orientation=honor_orientation)
            frames, video = result.frames, result.video
        usable = 0
        for frame in frames:
            frame["provenance"] = provenance
            assert_valid("poseFrame", frame)
            landmarks = {point["id"]: point for point in frame["normalized_landmarks"]}
            roots_visible = all(landmarks.get(i, {}).get("visibility", 0) >= 0.5 for i in (11, 12, 23, 24))
            if roots_visible and not frame["quality"].get("ambiguous_people"):
                usable += 1
        if not usable:
            raise ValueError("No unambiguous frame with visible shoulders and hips for normalization")
        pose_file.parent.mkdir(parents=True, exist_ok=True)
        header = {"_header": {"source_sha256": media_hash, "pose_model": provenance, "extraction": options}}
        with pose_file.open("w", encoding="utf-8") as output:
            output.write(json.dumps(header) + "\n")
            for frame in frames:
                output.write(json.dumps(frame, allow_nan=False) + "\n")
        end_ms = frames[-1]["timestamp_ms"] if frames else 0.0
        meta = {"cache_id": cache_id, "record_id": record["record_id"], "pose_path": pose_file.relative_to(out_dir).as_posix(), "pose_sha256": digest(pose_file),
                "source_sha256": media_hash, "frames": len(frames), "usable_frames": usable,
                "start_ms": frames[0]["timestamp_ms"], "end_ms": end_ms,
                "duration_ms": end_ms + (1000 / options["sample_hz"] if record["media_kind"] == "video" else 0),
                "video": video, "pose_model": provenance, "extraction": options, "extractor_sha256": extraction_code_digest()}
        write_json(meta_file, meta)
        return meta
    finally:
        backend.close()


def build_manifest(records: list[dict], extracted: dict[str, dict], task: str, out_dir: Path, seed: int, inventory_hash: str) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    if not records:
        raise ValueError("Cannot create an empty capture dataset")
    model_signatures = {json.dumps(extracted[r["record_id"]]["pose_model"], sort_keys=True) for r in records}
    if len(model_signatures) != 1:
        raise ValueError("A dataset must use one pinned pose model/runtime; re-extract mixed versions")
    dataset_identity = {"inventory_sha256": inventory_hash, "task": task, "seed": seed,
                        "streams": sorted((r["record_id"], extracted[r["record_id"]]["pose_sha256"]) for r in records),
                        "pose_model": json.loads(next(iter(model_signatures))), "preparer_sha256": digest(Path(__file__))}
    dataset_hash = hashlib.sha256(json.dumps(dataset_identity, sort_keys=True).encode()).hexdigest()
    manifest = {"schema_version": "1.0.0", "dataset_version": f"squash-{task}-{dataset_hash[:16]}", "created_at": now,
        "sport_pack_id": "squash", "sport_pack_version": "1.0.0", "model_task": task,
        "athletes": [], "capture_sessions": [], "cameras": [], "view_streams": [], "executions": [], "annotations": [],
        "provenance": {"algorithm_commit": "unversioned-workspace", "dependency_lockfile_sha256": digest(ROOT / "package-lock.json"),
            "processing_config": {"inventory_sha256": inventory_hash, "dataset_identity": dataset_identity, "label_granularity": "capture",
                "phase_labels_inferred": False, "coaching_correctness_inferred": False}}}
    athletes, sessions = {}, {}
    labels = {}
    for record in records:
        rid = record["record_id"]
        meta = extracted[rid]
        label = record.get("source_movement_id") or record.get("source_movement_name")
        if not label:
            continue
        aid = record.get("athlete_id") or "unknown"
        sid = record.get("capture_session_id") or "unknown"
        cid = f"camera-{rid}"
        stream_id = f"stream-{rid}"
        ex_id = f"capture-{rid}"
        labels[label] = record.get("source_movement_name") or label
        consent = record.get("consent", {})
        athletes[aid] = {"athlete_id": aid, "handedness": record.get("handedness", "unknown"), "context": "unknown",
            "consent": {"purpose": consent.get("purpose", []), "retention_until": consent.get("retention_until") or "unknown",
                "guardian_authorized": None, "source_status": consent.get("status", "unknown")}}
        if sid in sessions and sessions[sid]["athlete_id"] != aid and sid != "unknown":
            raise ValueError(f"Conflicting athlete identities for capture session {sid}")
        sessions.setdefault(sid, {"capture_session_id": sid, "athlete_id": aid if sid != "unknown" else "unknown",
            "location_id": record.get("venue_id") or "unknown", "captured_at": record.get("captured_at") or "unknown", "camera_ids": []})
        sessions[sid]["camera_ids"].append(cid)
        video = meta["video"]
        manifest["cameras"].append({"camera_id": cid, "view": record["view"], "nominal_fps": video.get("fps", 0),
            "resolution": [video["width"], video["height"]]})
        source = record["source"]
        manifest["view_streams"].append({"view_stream_id": stream_id, "capture_session_id": sid, "camera_id": cid,
            "object_uri": source["uri"], "sha256": meta["source_sha256"], "encrypted": bool(source.get("encryption")),
            "duration_ms": meta["duration_ms"], "pose_path": meta["pose_path"], "pose_sha256": meta["pose_sha256"],
            "source_version_id": source.get("version_id"), "source_etag": source.get("etag"),
            "source_capture_id": record.get("capture_id"), "source_record_id": rid, "source": source,
            "source_metadata": record.get("metadata_sources", []), "source_validation": record.get("validation", {}),
            "extraction": meta.get("extraction", {}), "extraction_code_sha256": meta.get("extractor_sha256"),
            "handedness": record.get("handedness", "unknown"), "view": record["view"]})
        manifest["executions"].append({"execution_id": ex_id, "capture_session_id": sid, "athlete_id": aid,
            "movement_id": label, "view_stream_ids": [stream_id], "start_ms": meta["start_ms"], "end_ms": meta["end_ms"],
            "split_group_id": record.get("split_group_id") or "unknown-identity", "source_sha256": meta["source_sha256"], "static": task == "static_pose",
            "annotation_granularity": "capture", "source_movement_name": labels[label]})
        manifest["annotations"].append({"annotation_id": f"source-{rid}", "execution_id": ex_id,
            "annotator_id": "importer:source-capture-catalog", "version": int(record.get("capture_revision") or 1), "created_at": now,
            "origin": "capture_catalog", "review_status": "unreviewed",
            "labels": {"movement_id": label, "static": task == "static_pose", "view": record["view"],
                "handedness": record.get("handedness", "unknown")}, "disagreement": None})
        manifest["pose_model"] = meta["pose_model"]
    manifest["athletes"] = list(athletes.values())
    manifest["capture_sessions"] = list(sessions.values())
    manifest["splits"] = assign_splits(manifest["executions"], seed)
    manifest["class_names"] = labels
    manifest["classes"] = sorted(labels) + ([] if "UNKNOWN" in labels else ["UNKNOWN"])
    manifest["release_blockers"] = list(manifest["splits"]["warnings"])
    if "UNKNOWN" not in labels:
        manifest["release_blockers"].append("No labeled UNKNOWN/other-movement examples: unknown rejection remains unvalidated.")
    if any(a["consent"]["retention_until"] == "unknown" or not a["consent"]["purpose"] for a in athletes.values()):
        manifest["release_blockers"].append("Capture metadata does not establish training-purpose/retention fields; retain for review before model release.")
    return manifest


def initialize_pose_worker(options: dict) -> None:
    # Bound native helper threads inside each spawned process. MediaPipe's own
    # runtime still chooses its internal inference threads.
    for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
        os.environ.setdefault(name, "1")
    pose_model_identity(options["variant"])


def prepare(inventory_path: Path, out_dir: Path, options: dict, seed: int, limit: int | None = None, workers: int = 1) -> dict:
    options = {"orientation_policy": "metadata", **options}
    if options["orientation_policy"] not in {"metadata", "encoded"}:
        raise ValueError("orientation_policy must be metadata or encoded")
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    if inventory.get("kind") != "apexformz.capture_inventory" or inventory.get("source", {}).get("sport") != "squash" or not inventory.get("source", {}).get("prefix", "").startswith("raw/squash/"):
        raise ValueError("Expected a squash DataCapture inventory scoped to raw/squash/")
    from ml.ingestion.capture import squash_capture_key
    out_of_scope = [r for r in inventory["records"] if not squash_capture_key(r.get("source", {}).get("key", ""))
        or r.get("source_movement_id") and not r["source_movement_id"].startswith("squash.")]
    if out_of_scope:
        raise ValueError("Inventory contains records outside squash DataCapture scope")
    if limit is not None and limit < 1:
        raise ValueError("limit must be positive")
    if workers < 1 or workers > 8:
        raise ValueError("workers must be between 1 and 8")
    records = [r for r in inventory["records"] if r.get("local_path") and not r.get("superseded")
        and r.get("validation", {}).get("eligible_media", False)
        and r.get("consent", {}).get("status") not in {"WITHDRAWN", "PENDING"}
        and (r.get("source_movement_id") or r.get("source_movement_name"))]
    if limit is not None:
        records = records[:limit]
    if not records:
        raise ValueError("No eligible downloaded labeled capture media")
    extracted, failures = {}, []
    completed = 0

    def accept(record, result=None, error=None):
        nonlocal completed
        completed += 1
        if error is not None:
            failures.append({"record_id": record["record_id"], "reason": str(error)})
            print(json.dumps({"processed": completed, "total": len(records), "excluded": record["record_id"], "reason": str(error)}), flush=True)
        else:
            extracted[record["record_id"]] = result
            print(json.dumps({"processed": completed, "total": len(records), "record_id": record["record_id"], "frames": result["frames"]}), flush=True)

    if workers == 1:
        for record in records:
            try:
                accept(record, extract_record(record, out_dir, options))
            except (ValueError, OSError) as error:
                accept(record, error=error)
    else:
        # Ensure the checkpoint exists before child processes are started, then
        # resolve/hash it once per child via the cached initializer.
        model = pose_model_identity(options["variant"])
        print(json.dumps({"stage": "pose_extraction", "workers": workers, "total": len(records), "pose_model": model}), flush=True)
        with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"),
                                 initializer=initialize_pose_worker, initargs=(options,)) as executor:
            pending = {executor.submit(extract_record, record, out_dir, options): record for record in records}
            for future in as_completed(pending):
                record = pending[future]
                try:
                    accept(record, future.result())
                except (ValueError, OSError) as error:
                    accept(record, error=error)
    manifests = {}
    for task, kind in (("static_pose", "static"), ("dynamic_movement", "dynamic")):
        selected = [r for r in records if r["record_id"] in extracted and (r.get("movement_type") or ("static" if r["media_kind"] == "image" else "dynamic")) == kind]
        if not selected:
            continue
        manifest = build_manifest(selected, extracted, task, out_dir, seed, digest(inventory_path))
        if options.get("attestations"):
            from tools.athlete_attestations import apply_attestations, load_attestations
            apply_attestations(manifest, load_attestations(Path(options["attestations"])), str(options["attestations"]))
        from jsonschema import Draft202012Validator
        schema = json.loads((ROOT / "ml/datasets/dataset_manifest.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(manifest)
        filename = out_dir / f"dataset_{task}.json"
        write_json(filename, manifest)
        manifests[task] = {"path": str(filename.resolve()), "classes": len(manifest["class_names"]),
            "captures": len(selected), "views": dict(Counter(r["view"] for r in selected)),
            "split": manifest["splits"], "release_blockers": manifest["release_blockers"]}
    report = {"source_inventory_sha256": digest(inventory_path), "requested": len(records), "processed": len(extracted),
        "extraction": options, "workers": workers, "failures": failures, "datasets": manifests,
        "notes": ["Labels identify captures, not annotated movement phases or technique correctness.",
                  "Each static photograph is one observation; frames are never duplicated as synthetic motion."]}
    write_json(out_dir / "preparation_report.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, default=ROOT / "data/squash")
    parser.add_argument("--variant", choices=["lite", "full", "heavy"], default="full")
    parser.add_argument("--sample-hz", type=float, default=30.0)
    parser.add_argument("--max-side", type=int, default=1280)
    parser.add_argument("--orientation-policy", choices=["metadata", "encoded"], default="metadata",
                        help="Honor EXIF/container rotation, or keep encoded pixels for a reviewed capture batch with incorrect rotation tags")
    parser.add_argument("--orientation-overrides", type=Path,
                        help="Visually audited exact record IDs/source hashes; never infer rotations from image aspect ratio")
    parser.add_argument("--seed", type=int, default=20261025)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=4, metavar="1..8")
    parser.add_argument("--attestations", type=Path, default=ROOT / "ml/sports/squash/athlete_attestations.json",
                        help="Owner-confirmed athlete facts (handedness, consent) applied to the manifests; see tools/athlete_attestations.py")
    parser.add_argument("--athlete-identity", type=Path,
                        help="identity_config.json from tools/resolve_athlete_identity.py: use its face/track/clothing-resolved athlete poses")
    args = parser.parse_args()
    if not math.isfinite(args.sample_hz) or args.sample_hz <= 0 or args.max_side <= 0:
        parser.error("sample-hz and max-side must be positive")
    report = prepare(args.inventory, args.out_dir.resolve(), {"variant": args.variant,
        "sample_hz": args.sample_hz, "max_side": args.max_side, "canonical": True, "mirror": False,
        "orientation_policy": args.orientation_policy,
        "orientation_overrides": str(args.orientation_overrides.resolve()) if args.orientation_overrides else None,
        "attestations": str(args.attestations) if args.attestations and args.attestations.exists() else None,
        **({"athlete_identity": json.loads(args.athlete_identity.read_text(encoding="utf-8"))} if args.athlete_identity else {})},
        args.seed, args.limit, args.workers)
    print(json.dumps(report, indent=2))
    return 0 if report["datasets"] else 1


if __name__ == "__main__":
    sys.exit(main())
