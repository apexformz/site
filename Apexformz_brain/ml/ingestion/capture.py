"""Inventory and cache existing squash DataCapture S3 objects without remote writes.

This is a source inventory, not a declaration of label quality or training consent.
All source labels are retained literally. No camera views are assumed synchronized.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v", ".avi"}
VIEWS = {"front", "back", "left", "right"}
SHA256 = re.compile(r"^[a-fA-F0-9]{64}$")
CAPTURE_NAME = re.compile(
    r"^(?P<sport>[a-z0-9-]+)_(?P<movement_type>static|dynamic)_"
    r"(?P<level>beginner|intermediate|expert)_(?P<name>[a-z0-9-]+)_"
    r"(?P<view>front|back|left|right)_(?P<athlete>ATH_\d{4,})\.(?:jpg|mp4)$",
    re.IGNORECASE,
)


def _hash(value: bytes | str) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else str(value) if value is not None else None


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".partial")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def object_source(bucket: str, key: str, head: dict) -> dict:
    metadata = head.get("Metadata", {})
    digest = metadata.get("sha256")
    version = _text(head.get("VersionId"))
    return {
        "bucket": bucket, "key": key, "uri": f"s3://{bucket}/{key}",
        "version_id": None if version == "null" else version, "etag": head.get("ETag"),
        "size": int(head.get("ContentLength", head.get("Size", 0))),
        "last_modified": _iso(head.get("LastModified")),
        "sha256": digest.lower() if isinstance(digest, str) and SHA256.fullmatch(digest) else None,
        "sha256_source": "s3_metadata" if isinstance(digest, str) and SHA256.fullmatch(digest) else None,
        "encryption": head.get("ServerSideEncryption"),
    }


def read_json_object(client: Any, bucket: str, key: str, max_bytes: int = 8 * 1024 * 1024) -> dict:
    """Return a small metadata document plus the immutable object provenance."""
    response = client.get_object(Bucket=bucket, Key=key)
    body = response["Body"]
    try:
        if response.get("ContentLength", 0) > max_bytes:
            raise ValueError(f"Metadata document exceeds {max_bytes} bytes: {key}")
        raw = body.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raise ValueError(f"Metadata document exceeds {max_bytes} bytes: {key}")
    finally:
        body.close()
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError(f"Expected a JSON object in metadata: {key}")
    source = object_source(bucket, key, response)
    source.update(sha256=_hash(raw), sha256_source="downloaded_bytes")
    return {"payload": payload, "source": source}


def list_objects(client: Any, bucket: str, prefix: str):
    """List only the explicit prefix, using the SDK paginator."""
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        yield from page.get("Contents", [])


def squash_capture_key(key: str) -> bool:
    parts = key.split("/")
    return len(parts) == 6 and parts[:2] == ["raw", "squash"] and parts[3] in VIEWS and not any(p in {"", ".", ".."} or "\\" in p for p in parts)


def squash_documents(documents: list[dict]) -> list[dict]:
    """Retain squash catalog/capture evidence and only its referenced athletes."""
    scoped, athletes = [], set()
    for document in documents:
        payload = document["payload"]
        data = payload.get("data", payload)
        kind = payload.get("kind")
        if not isinstance(data, dict):
            continue
        movement_id = data.get("movement_id", "")
        is_squash = data.get("sport_id") == "squash" or str(movement_id).startswith("squash.")
        if is_squash and (kind in {"CAPTURE", "MOVEMENT"} or payload.get("schema") == "apexformz.datacapture.capture.v1"):
            scoped.append(document)
            if data.get("athlete_id"):
                athletes.add(data["athlete_id"])
        elif isinstance(payload.get("movements"), list):
            movements = [m for m in payload["movements"] if isinstance(m, dict) and (m.get("sport_id") == "squash" or str(m.get("movement_id", "")).startswith("squash."))]
            if movements:
                scoped.append({**document, "payload": {**payload, "movements": movements}})
    for document in documents:
        payload = document["payload"]
        data = payload.get("data", {})
        if payload.get("kind") == "ATHLETE" and isinstance(data, dict) and data.get("athlete_id") in athletes:
            scoped.append(document)
    return scoped


def load_documents(client: Any, bucket: str, prefixes: list[str], *, workers: int = 4) -> list[dict]:
    documents = []
    seen = set()
    for prefix in prefixes:
        for item in list_objects(client, bucket, prefix):
            key = item["Key"]
            if key in seen or not key.endswith(".json"):
                continue
            seen.add(key)
            documents.append(key)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        loaded = list(executor.map(lambda key: read_json_object(client, bucket, key), documents))
    return squash_documents(loaded)


def _document_indexes(documents: list[dict]) -> tuple[dict, dict, dict]:
    captures, athletes, movements = {}, {}, {}
    versions: dict[tuple[str, str], tuple] = {}
    for document in documents:
        payload = document["payload"]
        source = document["source"]
        if payload.get("schema") == "apexformz.datacapture.archive.v1":
            kind = payload.get("kind")
            data = payload.get("data", {})
            rank = (1, int(payload.get("revision", 0)))
        elif payload.get("schema") == "apexformz.datacapture.capture.v1":
            kind, data, rank = "CAPTURE", payload, (0, int(payload.get("revision", 0)))
        else:
            kind, data, rank = None, payload, (0, 0)
        if not isinstance(data, dict):
            continue
        if kind in {"CAPTURE", "ATHLETE", "MOVEMENT"}:
            identity_field = {"CAPTURE": "capture_id", "ATHLETE": "athlete_id", "MOVEMENT": "movement_id"}[kind]
            identity = _text(data.get(identity_field))
            if identity and rank >= versions.get((kind, identity), (-1, -1)):
                target = {"CAPTURE": captures, "ATHLETE": athletes, "MOVEMENT": movements}[kind]
                target[identity] = {"data": data, "source": source}
                versions[kind, identity] = rank
        for movement in payload.get("movements", []):
            if isinstance(movement, dict) and _text(movement.get("movement_id")):
                movements.setdefault(movement["movement_id"], {"data": movement, "source": source})
    return captures, athletes, movements


def normalize_record(bucket: str, key: str, head: dict, indexes: tuple[dict, dict, dict], sport: str = "squash") -> dict:
    if sport != "squash" or not squash_capture_key(key):
        raise ValueError("Only squash DataCapture media keys are supported")
    captures, athletes, movements = indexes
    metadata = {k.lower().replace("-", "_"): v for k, v in head.get("Metadata", {}).items()}
    source = object_source(bucket, key, head)
    parts = key.split("/")
    suffix = Path(parts[-1]).suffix.lower()
    media_kind = "image" if suffix in IMAGE_SUFFIXES else "video"
    filename = CAPTURE_NAME.fullmatch(parts[-1])
    name_fields = filename.groupdict() if filename else {}
    raw_path = len(parts) == 6 and parts[0] == "raw" and parts[1] == sport and parts[3] in VIEWS
    capture_id = _text(metadata.get("capture_id")) or (parts[4] if raw_path else None)
    capture_doc = captures.get(capture_id, {})
    cap = capture_doc.get("data", {})
    sources = [capture_doc["source"]] if capture_doc else []
    warnings, blockers = [], []
    if metadata.get("capture_id") and metadata["capture_id"] != parts[4]:
        blockers.append("conflicting_capture_id")
    if head.get("_latest_version_id"):
        source["latest_version_id"] = head["_latest_version_id"]
        warnings.append("using_verified_capture_version_instead_of_latest")

    def identity(field: str, fallback: Any = None) -> str | None:
        values = [_text(cap.get(field)), _text(metadata.get(field)), _text(fallback)]
        present = [value for value in values if value]
        if len(set(present)) > 1:
            blockers.append(f"conflicting_{field}")
        return present[0] if present else None

    session_id = identity("session_id", parts[2] if raw_path else None)
    athlete_id = identity("athlete_id", name_fields.get("athlete"))
    movement_id = identity("movement_id")
    movement_doc = movements.get(movement_id, {})
    if movement_doc:
        sources.append(movement_doc["source"])
    movement_data = movement_doc.get("data", {})
    movement_name = _text(cap.get("source_display_name")) or _text(movement_data.get("name"))
    if not movement_name and name_fields.get("name"):
        movement_name = name_fields["name"]  # original filename slug, not a guessed canonical name
    mode = str(cap.get("movement_type") or movement_data.get("movement_type") or name_fields.get("movement_type") or "").lower()
    if mode not in {"static", "dynamic"}:
        mode = None
    direction = identity("direction", name_fields.get("view") or parts[3])
    # Direction has case-insensitive semantics in the capture schema.
    blockers = [b for b in blockers if b != "conflicting_direction"]
    direction_values = [str(v).lower() for v in (cap.get("direction"), metadata.get("direction"), name_fields.get("view"), parts[3]) if v]
    if len(set(direction_values)) > 1:
        blockers.append("conflicting_direction")
    view = direction.lower() if direction and direction.lower() in VIEWS else "unknown"
    if cap.get("s3_key") and cap["s3_key"] != key:
        blockers.append("capture_key_mismatch")
    expected_version = cap.get("s3_version_id")
    if expected_version == "null":
        expected_version = None
    if expected_version and source["version_id"] != expected_version:
        blockers.append("source_version_mismatch")
    verified_digest = cap.get("verified_sha256") or cap.get("sha256")
    if verified_digest and SHA256.fullmatch(str(verified_digest)):
        if source["sha256"] and source["sha256"] != verified_digest.lower():
            blockers.append("source_sha256_mismatch")
        source.update(sha256=verified_digest.lower(), sha256_source="capture_manifest")
    if cap.get("bytes") is not None and int(cap["bytes"]) != source["size"]:
        blockers.append("source_size_mismatch")
    superseded = bool(cap.get("superseded", False))
    if superseded:
        blockers.append("superseded_capture")
    if cap and cap.get("upload_state") != "UPLOADED":
        blockers.append("capture_not_verified_uploaded")
    if not cap:
        warnings.append("capture_acceptance_not_verified")
    if not source["version_id"] or source["version_id"] == "null":
        warnings.append("source_not_version_pinned")
    if not athlete_id:
        warnings.append("athlete_identity_unknown")
    if not session_id:
        warnings.append("capture_session_unknown")
    if not movement_id:
        warnings.append("movement_label_missing")
    if view == "unknown":
        warnings.append("camera_view_unknown")
    athlete_doc = athletes.get(athlete_id, {})
    if athlete_doc:
        sources.append(athlete_doc["source"])
    athlete = athlete_doc.get("data", {})
    consent_status = athlete.get("consent_status", "unknown")
    consent = {"status": consent_status, "purpose": [], "retention_until": None}
    # GRANTED in DataCapture covers capture; no training purpose/retention is invented.
    if consent_status == "WITHDRAWN":
        blockers.append("consent_withdrawn")
    elif consent_status == "PENDING":
        blockers.append("capture_consent_pending")
    elif consent_status == "unknown":
        warnings.append("current_capture_consent_unknown")
    warnings.append("training_purpose_and_retention_not_recorded")
    if source["size"] <= 0:
        blockers.append("empty_media")
    group = f"capture-session:{session_id}/movement:{movement_id}" if session_id and movement_id else "unknown-identity"
    return {
        "record_id": _hash(f"{bucket}\n{key}\n{source['version_id'] or source['etag']}"),
        "source": source, "local_path": None, "local_sha256": None, "media_kind": media_kind,
        "capture_id": capture_id, "capture_session_id": session_id, "athlete_id": athlete_id,
        "source_movement_id": movement_id, "source_movement_name": movement_name,
        "movement_type": mode, "level": str(cap.get("level") or name_fields.get("level") or "").lower() or None,
        "view": view, "handedness": "unknown", "split_group_id": group,
        "synchronization": "not_established", "superseded": superseded, "consent": consent,
        "captured_at": cap.get("captured_at"), "width": cap.get("width"), "height": cap.get("height"),
        "duration_ms": cap.get("duration_ms"), "capture_revision": cap.get("revision"),
        "catalog_revision": cap.get("catalog_revision") or metadata.get("catalog_revision"),
        "metadata_sources": sources,
        "validation": {"eligible_media": not blockers, "blockers": sorted(set(blockers)), "warnings": sorted(set(warnings))},
    }


def summarize(records: list[dict]) -> dict:
    return {
        "records": len(records), "eligible_media": sum(r["validation"]["eligible_media"] for r in records),
        "downloaded": sum(bool(r["local_path"]) for r in records),
        "known_athletes": len({r["athlete_id"] for r in records if r["athlete_id"]}),
        "unknown_athlete_records": sum(r["athlete_id"] is None for r in records),
        "by_media_kind": dict(Counter(r["media_kind"] for r in records)),
        "by_view": dict(Counter(r["view"] for r in records)),
        "by_movement": dict(Counter(r["source_movement_id"] or "unknown" for r in records)),
        "blockers": dict(Counter(b for r in records for b in r["validation"]["blockers"])),
        "warnings": dict(Counter(w for r in records for w in r["validation"]["warnings"])),
        "production_ready": False,
        "release_blockers": ["training_purpose_and_retention_require_explicit_evidence", "expert_label_validation_not_established", "held_out_athlete_evaluation_not_performed"],
    }


def download_record(client: Any, record: dict, cache_dir: Path) -> Path:
    """Content-addressed safe cache; pin S3 version or conditional ETag; hash bytes."""
    if not record["validation"]["eligible_media"]:
        raise ValueError(f"Capture is blocked: {record['record_id']}")
    source = record["source"]
    root = cache_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    suffix = Path(source["key"]).suffix.lower()
    if suffix not in IMAGE_SUFFIXES | VIDEO_SUFFIXES:
        raise ValueError("Unsupported media extension")
    identity = _hash(f"{source['bucket']}\n{source['key']}\n{source.get('version_id') or source.get('etag')}")
    target = (root / identity[:2] / (identity + suffix)).resolve()
    if root not in target.parents:
        raise ValueError("Cache path escapes the requested directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    receipt_path = target.with_suffix(target.suffix + ".source.json")
    if target.is_file() and receipt_path.is_file():
        try:
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError):
            receipt = {}  # An interrupted or damaged receipt must not authorize cache reuse.
        digest = file_sha256(target)
        cached_source = receipt.get("source", {})
        same_source = all(cached_source.get(k) == source.get(k) for k in ("bucket", "key", "version_id", "etag", "size"))
        if same_source and receipt.get("sha256") == digest and target.stat().st_size == source["size"] and (not source.get("sha256") or source["sha256"] == digest):
            record.update(local_path=str(target), local_sha256=digest)
            return target
    temp = target.with_suffix(target.suffix + ".partial")
    try:
        if source.get("version_id") and source["version_id"] != "null":
            client.download_file(source["bucket"], source["key"], str(temp), ExtraArgs={"VersionId": source["version_id"]})
        else:
            if not source.get("etag"):
                raise ValueError("Unversioned download requires an ETag for a conditional read")
            # download_file does not expose IfMatch. Conditional streaming prevents a HEAD/GET race.
            response = client.get_object(Bucket=source["bucket"], Key=source["key"], IfMatch=source["etag"])
            body = response["Body"]
            try:
                with temp.open("wb") as output:
                    for chunk in iter(lambda: body.read(1024 * 1024), b""):
                        output.write(chunk)
                        if output.tell() > source["size"]:
                            raise ValueError("Downloaded object exceeds inventoried size")
            finally:
                body.close()
        digest = file_sha256(temp)
        if temp.stat().st_size != source["size"]:
            raise ValueError("Downloaded object size differs from inventory")
        if source.get("sha256") and digest != source["sha256"]:
            raise ValueError("Downloaded object SHA-256 differs from source metadata")
        temp.replace(target)
        _atomic_json(receipt_path, {"source": source, "sha256": digest, "bytes": target.stat().st_size})
        record.update(local_path=str(target), local_sha256=digest)
        return target
    finally:
        if temp.exists():
            temp.unlink()


def capture_head(client: Any, bucket: str, key: str, indexes: tuple[dict, dict, dict]) -> dict:
    """Read the exact object version accepted by Data Capture when one is recorded.

    A later overwrite must not silently replace the bytes reviewed by the capture
    manifest. All identity/hash/size checks still apply to the pinned HEAD below.
    """
    if not squash_capture_key(key):
        raise ValueError("Only squash DataCapture media keys are supported")
    head = client.head_object(Bucket=bucket, Key=key)
    capture = indexes[0].get(key.split("/")[4], {}).get("data", {})
    expected = capture.get("s3_version_id")
    if (expected and expected != "null" and expected != head.get("VersionId")
            and capture.get("s3_key", key) == key and capture.get("upload_state") == "UPLOADED"
            and not capture.get("superseded")):
        from botocore.exceptions import ClientError
        try:
            pinned = client.head_object(Bucket=bucket, Key=key, VersionId=expected)
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in {"404", "NoSuchVersion", "NotFound"}:
                raise
            # Preserve the version-mismatch blocker rather than accepting latest.
            return head
        pinned["_latest_version_id"] = head.get("VersionId")
        return pinned
    return head


def inventory(client: Any, bucket: str, prefix: str, *, sport: str = "squash", documents: list[dict] | None = None,
              cache_dir: Path | None = None, max_objects: int | None = None, workers: int = 4) -> dict:
    if sport != "squash" or not prefix.startswith("raw/squash/"):
        raise ValueError("This importer is scoped to squash DataCapture: use --sport squash and --prefix raw/squash/")
    if workers < 1 or workers > 16:
        raise ValueError("workers must be between 1 and 16")
    indexes = _document_indexes(squash_documents(documents or []))
    keys = []
    eligible_suffixes = IMAGE_SUFFIXES | VIDEO_SUFFIXES
    for item in list_objects(client, bucket, prefix):
        key = item["Key"]
        if not squash_capture_key(key) or Path(key).suffix.lower() not in eligible_suffixes:
            continue
        if max_objects is not None and len(keys) >= max_objects:
            break
        keys.append(key)

    def process(key):
        head = capture_head(client, bucket, key, indexes)
        record = normalize_record(bucket, key, head, indexes, sport)
        movement_id = record.get("source_movement_id")
        if movement_id and not movement_id.startswith("squash."):
            record["validation"]["eligible_media"] = False
            record["validation"]["blockers"].append("movement_outside_squash_scope")
        if cache_dir is not None and record["validation"]["eligible_media"]:
            download_record(client, record, cache_dir)
        return record

    with ThreadPoolExecutor(max_workers=workers) as executor:
        records = list(executor.map(process, keys))
    return {
        "schema_version": "1.0.0", "kind": "apexformz.capture_inventory",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source": {"bucket": bucket, "prefix": prefix, "sport": sport},
        "records": records, "summary": summarize(records),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", required=True, help="Squash DataCapture prefix: raw/squash/ or a child prefix")
    parser.add_argument("--sport", choices=["squash"], default="squash")
    parser.add_argument("--manifest-bucket")
    parser.add_argument("--manifest-prefix", action="append", default=[], help="Repeat for DataCapture archives/catalog")
    parser.add_argument("--profile")
    parser.add_argument("--region")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--cache-dir", type=Path, help="Download eligible media into this safe local cache; omit for metadata only")
    parser.add_argument("--max-objects", type=int)
    parser.add_argument("--workers", type=int, choices=range(1, 17), default=4, metavar="1..16")
    args = parser.parse_args()
    if not args.prefix or args.prefix.startswith("/") or args.max_objects is not None and args.max_objects < 1:
        parser.error("A nonempty relative prefix and positive max-objects are required")
    try:
        import boto3
        from botocore.config import Config
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError:
        print("Install boto3 (or boto3[crt] for aws login credentials) to read S3.", file=sys.stderr)
        return 2
    try:
        session = boto3.Session(profile_name=args.profile, region_name=args.region)
        client = session.client("s3", config=Config(retries={"mode": "standard", "total_max_attempts": 4}, connect_timeout=10, read_timeout=60, max_pool_connections=max(10, args.workers * 4)))
        prefixes = args.manifest_prefix or ["manifests/", "catalog/"]
        documents = load_documents(client, args.manifest_bucket, prefixes, workers=args.workers) if args.manifest_bucket else []
        result = inventory(client, args.bucket, args.prefix, sport=args.sport, documents=documents, cache_dir=args.cache_dir, max_objects=args.max_objects, workers=args.workers)
        result["source"].update(manifest_bucket=args.manifest_bucket, manifest_prefix=prefixes if args.manifest_bucket else [])
        result["source"]["max_objects"] = args.max_objects
        _atomic_json(args.out, result)
        print(json.dumps({"inventory": str(args.out.resolve()), **result["summary"]}))
        return 0
    except (BotoCoreError, ClientError, ValueError, OSError) as exc:
        print(f"Import failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
