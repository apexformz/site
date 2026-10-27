"""Prepare checksum-pinned local Y4M fake-camera fixtures from existing squash captures.

No source media is modified, uploaded, or served. These resolution variants test
the browser pipeline; repeated playback is not new motion or accuracy evidence.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SELECTION = {
    "front": ("0a4ac2dd4a11b69148181ada206142b0672ff89c5faf5b19d3ab51c2e66b9f8b", "squash.dynamic.0014"),
    "back": ("0fc33091c5b5017d2b9007814aa0fab9524965deba225911f3644674de812d14", "squash.dynamic.0068"),
    "left": ("c5deae5237c852c4e21fd6df64a34922f49f7e294fbab3c38cdcf8738edf9434", "squash.dynamic.0043"),
    "right": ("8d0f37a77869c0fa056230ac8d7136c245cffacdec911a06f47d5dab3fe6d45d", "squash.dynamic.0031"),
}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def inspect_y4m(path: Path, width: int, height: int) -> dict:
    """Validate every raw frame boundary and fixed I420 payload, not just its extension."""
    frames = 0
    with path.open("rb") as handle:
        header = handle.readline().decode("ascii").strip()
        tokens = header.split()
        if (tokens[0] != "YUV4MPEG2" or f"W{width}" not in tokens or f"H{height}" not in tokens
                or "F15:1" not in tokens or not any(t.startswith("C420") for t in tokens)):
            raise ValueError("unexpected Y4M dimensions/frame rate/pixel format")
        while marker := handle.readline():
            if marker.strip() != b"FRAME":
                raise ValueError("unexpected Y4M frame marker")
            if len(handle.read(width * height * 3 // 2)) != width * height * 3 // 2:
                raise ValueError("truncated Y4M frame")
            frames += 1
    if frames < 1:
        raise ValueError("empty Y4M fixture")
    return {"header": header, "frames": frames, "duration_s": frames / 15, "bytes": path.stat().st_size}


def prepare(manifest_path: Path, inventory_path: Path, out: Path, max_seconds: float = 10):
    import imageio_ffmpeg
    if not 1 <= max_seconds <= 12:
        raise ValueError("max_seconds must be in 1..12; clips are never extended or looped during preparation")
    manifest_path, inventory_path, out = manifest_path.resolve(), inventory_path.resolve(), out.resolve()
    manifest_hash, inventory_hash = digest(manifest_path), digest(inventory_path)
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    if data.get("sport_pack_id") != "squash" or data.get("model_task") != "dynamic_movement":
        raise ValueError("only prepared squash dynamic Data Capture inputs are allowed")
    records = {r["record_id"]: r for r in inventory["records"]}
    streams = {s["source_record_id"]: s for s in data["view_streams"]}
    executions = {sid: e for e in data["executions"] for sid in e["view_stream_ids"]}
    cameras = {c["camera_id"]: c for c in data["cameras"]}
    ffmpeg = Path(imageio_ffmpeg.get_ffmpeg_exe())
    ffmpeg_hash = digest(ffmpeg)
    version = subprocess.run([str(ffmpeg), "-version"], check=True, capture_output=True, text=True).stdout.splitlines()[0]
    out.mkdir(parents=True, exist_ok=True)
    existing_path = out / "manifest.json"
    existing = json.loads(existing_path.read_text(encoding="utf-8")) if existing_path.exists() else {}
    prior = {row["id"]: row for row in existing.get("fixtures", [])}
    fixtures = []
    for fixture_id in (*SELECTION, "front_native"):
        view = "front" if fixture_id == "front_native" else fixture_id
        rid, movement = SELECTION[view]
        record, stream = records[rid], streams[rid]
        execution = executions[stream["view_stream_id"]]
        camera = cameras[stream["camera_id"]]
        raw, pose = Path(record["local_path"]), manifest_path.parent / stream["pose_path"]
        if (record.get("media_kind") != "video" or camera["view"] != view or execution["movement_id"] != movement
                or stream.get("extraction", {}).get("orientation_policy") != "encoded"
                or not stream["object_uri"].startswith("s3://apexformz-datacapture-") or "/raw/squash/" not in stream["object_uri"]):
            raise ValueError("selected fixture identity/view/source/orientation changed")
        if digest(raw) != stream["sha256"] or digest(pose) != stream["pose_sha256"]:
            raise ValueError("source media/pose checksum mismatch")
        frames = [json.loads(line) for line in pose.read_text(encoding="utf-8").splitlines() if line.strip()]
        frames = [frame for frame in frames if "_header" not in frame]
        if not frames or any(f["image_size"][0] <= f["image_size"][1] for f in frames):
            raise ValueError("selected fixture must have landscape encoded poses")
        quality = {"cached_pose_frames": len(frames), "strict_quality_frames": sum(
            bool(f["quality"]["framing_ok"]) and not f["quality"].get("ambiguous_people")
            and not f["quality"].get("track_changed") and not f["quality"]["missing_joints"] for f in frames),
            "ambiguous_frames": sum(bool(f["quality"].get("ambiguous_people")) for f in frames),
            "track_changed_frames": sum(bool(f["quality"].get("track_changed")) for f in frames)}
        width, height = (1280, 720) if fixture_id == "front_native" else (640, 360)
        transform = {"autorotate": False, "rotation_applied_degrees": 0, "width": width, "height": height, "fps": 15,
                     "pixel_format": "yuv420p", "sample_aspect_ratio": "1:1", "max_duration_s": max_seconds,
                     "looped_or_padded": False, "purpose": "derived resolution variant for fake-camera integration testing"}
        target = out / f"{fixture_id}.y4m"
        cached = prior.get(fixture_id)
        if target.exists():
            if (not cached or cached.get("source_sha256") != stream["sha256"] or cached.get("transform") != transform
                    or cached.get("ffmpeg_sha256") != ffmpeg_hash or cached.get("y4m_sha256") != digest(target)):
                raise ValueError(f"existing fixture differs; use a new output directory: {target}")
        else:
            staged = out / f"{fixture_id}.partial.y4m"
            args = [str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y", "-noautorotate", "-i", str(raw),
                    "-map", "0:v:0", "-an", "-sn", "-dn", "-t", str(max_seconds),
                    "-vf", f"scale={width}:{height},fps=15,setsar=1", "-pix_fmt", "yuv420p", "-f", "yuv4mpegpipe", str(staged)]
            subprocess.run(args, check=True, capture_output=True, text=True)
            inspect_y4m(staged, width, height)
            staged.replace(target)
        inspected = inspect_y4m(target, width, height)
        if digest(raw) != stream["sha256"]:
            raise ValueError("raw source changed while converting")
        fixture = {"id": fixture_id, "view": view, "movement_id": movement, "movement_name": data["class_names"][movement],
                   "y4m_path": str(target), "y4m_sha256": digest(target), **inspected,
                   "source_record_id": rid, "source_execution_id": execution["execution_id"], "source_stream_id": stream["view_stream_id"],
                   "source_sha256": stream["sha256"], "source_uri": stream["object_uri"], "source_mp4_path": str(raw.resolve()),
                   "source_pose_sha256": stream["pose_sha256"], "source_bounds_ms": [execution["start_ms"], execution["end_ms"]],
                   "athlete_id": execution["athlete_id"], "capture_session_id": execution["capture_session_id"],
                   "split": data["splits"]["assignments"][execution["execution_id"]], "source_quality": quality,
                   "transform": transform, "ffmpeg_sha256": ffmpeg_hash}
        fixtures.append(fixture)
        print(json.dumps({"fixture": fixture_id, "frames": inspected["frames"], "bytes": inspected["bytes"], "y4m_path": str(target)}), flush=True)
    if digest(manifest_path) != manifest_hash or digest(inventory_path) != inventory_hash:
        raise ValueError("input manifest/inventory changed during conversion")
    result = {"schema_version": "1.0.0", "kind": "apexformz.browser_squash_fixtures", "created_at": datetime.now(timezone.utc).isoformat(),
              "purpose": "browser_integration_regression_only", "production_eligible": False,
              "manifest_path": str(manifest_path), "manifest_sha256": manifest_hash, "dataset_version": data["dataset_version"],
              "inventory_path": str(inventory_path), "inventory_sha256": inventory_hash,
              "preparer_sha256": digest(Path(__file__)), "ffmpeg_path": str(ffmpeg), "ffmpeg_version": version, "ffmpeg_sha256": ffmpeg_hash,
              "source_files_modified": False, "fixtures": fixtures,
              "limitations": ["Existing single-athlete training captures, not independent accuracy evidence.",
                              "front_native is a1280x720 derived variant of the same front source; it is not a fifth independent recording.",
                              "Cached pose quality guided selection; browser pose inference must be measured independently.",
                              "Fake-camera playback is not physical-camera/device validation; playback loops must not count as independent executions."]}
    staged = out / "manifest.partial.json"
    staged.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    staged.replace(existing_path)
    print(json.dumps({"manifest": str(existing_path), "fixtures": len(fixtures)}), flush=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "data/squash/dataset_dynamic_movement.json")
    parser.add_argument("--inventory", type=Path, default=ROOT / "data/squash/capture_inventory_display_v2.json")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "data/audit/browser-squash/fixtures")
    parser.add_argument("--max-seconds", type=float, default=10)
    args = parser.parse_args()
    prepare(args.manifest, args.inventory, args.out_dir, args.max_seconds)
