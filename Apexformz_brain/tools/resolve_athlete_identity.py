"""
Identity-resolved pose extraction: find *the athlete* in every frame of every capture, then hand the poses to
tools/prepare_capture_dataset.py through its normal pose cache.

The decision method lives in apexformz_perception/subject/identity.py:
- face verification against owner-supplied reference photos;
- the face decision carried along each person's track;
- a per-session clothing model learned only from face-confirmed detections.

Undecidable frames stay ambiguous, as before. Every frame records how its athlete was identified
(quality.identity_method / identity_score).

    python tools/resolve_athlete_identity.py --inventory data/squash/capture_inventory_resolved.json \
        --orientation-policy encoded --orientation-overrides data/squash/orientation_overrides_v1.json
    python tools/prepare_capture_dataset.py ... (same extraction flags) --athlete-identity data/squash/identity/identity_config.json

Reference photos: data/squash/athlete_reference/<ATHLETE_ID>/*.jpg (private, git-ignored). Faces of other people
are compared and then discarded; only the athlete's references are used.
"""
from __future__ import annotations

import argparse
import json
import multiprocessing
import os
import pickle
import sys
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tools"))
for extra in ("packages/perception-py", "packages/contracts/python"):
    sys.path.insert(0, str(ROOT / extra))

import numpy as np  # noqa: E402
import prepare_capture_dataset as prep  # noqa: E402
from apexformz_perception.subject import identity as idn  # noqa: E402

COLLECT_VERSION = 1  # bump when candidate collection itself changes (not the decision logic)
DETECTOR = {"num_poses": 3, "min_detection_confidence": 0.3, "min_presence_confidence": 0.3, "min_tracking_confidence": 0.5}
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")


def references_for(root: Path, athlete_id: str) -> list[Path]:
    d = root / athlete_id
    return sorted(p for p in d.iterdir() if p.suffix.lower() in IMG_EXT) if d.is_dir() else []


def eligible_records(inventory: dict) -> list[dict]:
    return [r for r in inventory["records"] if r.get("local_path") and not r.get("superseded")
            and r.get("validation", {}).get("eligible_media", False)
            and r.get("consent", {}).get("status") not in {"WITHDRAWN", "PENDING"}
            and (r.get("source_movement_id") or r.get("source_movement_name"))]


def collect(record: dict, options: dict, out_dir: str, ref_root: str, model_dir: str) -> dict:
    """Phase A: every person in every frame, with track, face and clothing evidence."""
    import cv2
    from apexformz_perception.pose import create_backend
    from apexformz_perception.subject.bytetrack import ByteTracker
    out = Path(out_dir) / "identity" / "candidates" / f"{record['record_id']}.pkl"
    media = Path(record["local_path"])
    media_hash = prep.digest(media)
    opts = prep.record_extraction_options(record, media_hash, {"orientation_policy": "metadata", **options})
    ident = opts.get("athlete_identity", {})
    collect_key = prep.digest_json({"v": COLLECT_VERSION, "media": media_hash, "detector": DETECTOR, "face_models": ident.get("face_models"),
                                    "references": ident.get("references"), "pose_model": prep.pose_model_identity(opts["variant"]),
                                    "extraction": {k: v for k, v in opts.items() if k != "athlete_identity"}})
    if out.exists():
        cached = pickle.loads(out.read_bytes())
        if cached.get("collect_key") == collect_key:
            return {"record_id": record["record_id"], "path": str(out), "cached": True}
    refs = references_for(Path(ref_root), record.get("athlete_id", ""))
    faces = idn.FaceMatcher(Path(model_dir), refs) if refs else None
    backend = create_backend("mediapipe", variant=opts["variant"], prefer_gpu=False, **DETECTOR)
    provenance = backend.provenance()
    provenance["digest"] = prep.digest(backend.model_path)
    frames, video = [], None

    def candidates(full, pose_img, ts, fid, tracker):
        persons = backend.detect(pose_img, ts, fid)
        dets = [(p.bbox_or_from_keypoints(), p.detection_score if p.detection_score else p.confidence()) for p in persons]
        track_of = {}
        if tracker is not None:
            for t in tracker.update(dets):
                track_of[t.payload_index] = t.track_id
        cands = []
        for i, p in enumerate(persons):
            face, px = faces.match(full, p.xy, p.scores) if faces else (None, 0.0)
            cands.append(idn.Candidate(i, track_of.get(i), np.asarray(dets[i][0], dtype=float), face, px,
                                       idn.clothing_signature(full, p.xy, p.scores), idn.is_frontal(p.xy, p.scores)))
        h, w = pose_img.shape[:2]
        frames.append({"frame_id": fid, "ts": ts, "size": (w, h), "persons": persons, "cands": cands})

    try:
        if record["media_kind"] == "image":
            full = prep.decode_capture_image(media, opts["orientation_policy"], opts.get("orientation_override"))
            if full is None:
                raise ValueError("Image cannot be decoded")
            h, w = full.shape[:2]
            ratio = min(1.0, opts["max_side"] / max(h, w))
            pose_img = cv2.resize(full, (round(w * ratio), round(h * ratio))) if ratio < 1 else full
            candidates(full, pose_img, 0.0, 0, None)
            ph, pw = pose_img.shape[:2]
            video = {"width": pw, "height": ph, "fps": 0, "frame_count": 1}
        else:
            from apexformz_perception.io.video import probe, read_frames
            honor = opts["orientation_policy"] == "metadata"
            info = probe(str(media), honor_orientation=honor)
            stride = max(1, round(info.fps / opts["sample_hz"])) if info.fps else 1
            tracker = ByteTracker()
            for fid, ts, full in read_frames(str(media), stride=stride, max_side=None, honor_orientation=honor):
                h, w = full.shape[:2]
                s = opts["max_side"] / max(h, w)
                pose_img = cv2.resize(full, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA) if s < 1.0 else full
                candidates(full, pose_img, ts, fid, tracker)
            video = {"path": str(media), "width": info.width, "height": info.height, "fps": info.fps,
                     "frame_count": info.frame_count, "stride": stride, "honor_orientation": honor}
    finally:
        backend.close()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pickle.dumps({"collect_key": collect_key, "media_hash": media_hash, "options": opts, "provenance": provenance,
                                  "video": video, "frames": frames, "has_references": bool(refs)}))
    return {"record_id": record["record_id"], "path": str(out), "cached": False}


def write_record(record: dict, data: dict, decisions: list, out_dir: Path, options: dict) -> dict:
    """Phase C: pose frames of the chosen athlete, in the exact cache format of prepare_capture_dataset."""
    from apexformz_contracts import assert_valid
    from apexformz_perception.pose.base import build_pose_frame
    provenance = data["provenance"]
    athlete_tag = f"athlete:{record.get('athlete_id', 'unknown')}"
    opts = prep.record_extraction_options(record, data["media_hash"], {"orientation_policy": "metadata", **options})
    cache_id = prep.pose_cache_id(record, data["media_hash"], opts, prep.pose_model_identity(opts["variant"]))
    frames, prev_id, prev_box = [], None, None
    for fr, dec in zip(data["frames"], decisions):
        person = fr["persons"][dec.det_index] if dec.det_index is not None else None
        if person is None:
            subject = prev_id
        elif dec.method in ("face", "face_track", "clothing"):
            subject = athlete_tag
        else:
            cand = fr["cands"][dec.det_index]
            # size-rule frame that clearly continues the previous athlete box is the same person
            subject = prev_id if prev_id and prev_box is not None and idn._iou(cand.bbox, prev_box) >= 0.3 else                 (f"track-{cand.track}" if cand.track is not None else "track-1")
        changed = person is not None and prev_id is not None and subject != prev_id
        w, h = fr["size"]
        frame = build_pose_frame(person, provenance=provenance, canonical=True, session_id=record["record_id"], frame_id=fr["frame_id"],
                                 timestamp_ms=fr["ts"], camera_id=record.get("view", "unknown"), image_size=[w, h], mirror=False,
                                 orientation="portrait" if h > w else "landscape", tracked_subject_id=subject,
                                 person_count=len(fr["persons"]), ambiguous=dec.ambiguous, track_changed=changed)
        frame["quality"]["identity_method"] = dec.method
        frame["quality"]["identity_score"] = None if dec.score is None else round(float(dec.score), 4)
        frame["provenance"] = provenance
        assert_valid("poseFrame", frame)
        frames.append(frame)
        if person is not None:
            prev_id = subject
            prev_box = fr["cands"][dec.det_index].bbox
    usable = 0
    for frame in frames:
        lm = {p["id"]: p for p in frame["normalized_landmarks"]}
        if all(lm.get(i, {}).get("visibility", 0) >= 0.5 for i in (11, 12, 23, 24)) and not frame["quality"].get("ambiguous_people"):
            usable += 1
    methods = Counter(d.method for d in decisions)
    if not usable:
        return {"record_id": record["record_id"], "excluded": "No unambiguous frame with visible shoulders and hips for normalization", "methods": dict(methods)}
    pose_file = out_dir / "poses" / f"{cache_id}.jsonl"
    pose_file.parent.mkdir(parents=True, exist_ok=True)
    with pose_file.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps({"_header": {"source_sha256": data["media_hash"], "pose_model": provenance, "extraction": opts}}) + "\n")
        for frame in frames:
            fh.write(json.dumps(frame, allow_nan=False) + "\n")
    end_ms = frames[-1]["timestamp_ms"] if frames else 0.0
    meta = {"cache_id": cache_id, "record_id": record["record_id"], "pose_path": pose_file.relative_to(out_dir).as_posix(),
            "pose_sha256": prep.digest(pose_file), "source_sha256": data["media_hash"], "frames": len(frames), "usable_frames": usable,
            "start_ms": frames[0]["timestamp_ms"], "end_ms": end_ms,
            "duration_ms": end_ms + (1000 / opts["sample_hz"] if record["media_kind"] == "video" else 0),
            "video": data["video"], "pose_model": provenance, "extraction": opts, "extractor_sha256": prep.extraction_code_digest(),
            "identity": {"methods": dict(methods), "ambiguous": int(sum(d.ambiguous for d in decisions))}}
    prep.write_json(pose_file.with_suffix(".meta.json"), meta)
    return {"record_id": record["record_id"], "usable": usable, "frames": len(frames), "methods": dict(methods),
            "ambiguous": meta["identity"]["ambiguous"]}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--inventory", type=Path, required=True)
    ap.add_argument("--out-dir", type=Path, default=ROOT / "data/squash")
    ap.add_argument("--references", type=Path, default=ROOT / "data/squash/athlete_reference")
    ap.add_argument("--face-models", type=Path, default=ROOT / "ml/third_party_models/face")
    ap.add_argument("--variant", choices=["lite", "full", "heavy"], default="full")
    ap.add_argument("--sample-hz", type=float, default=30.0)
    ap.add_argument("--max-side", type=int, default=1280)
    ap.add_argument("--orientation-policy", choices=["metadata", "encoded"], default="metadata")
    ap.add_argument("--orientation-overrides", type=Path)
    ap.add_argument("--attestations", type=Path, default=ROOT / "ml/sports/squash/athlete_attestations.json")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--record-ids", nargs="+")
    a = ap.parse_args()
    out_dir = a.out_dir.resolve()
    inventory = json.loads(a.inventory.read_text(encoding="utf-8"))
    records = eligible_records(inventory)
    if a.record_ids:
        records = [r for r in records if r["record_id"] in set(a.record_ids)]
    if a.limit:
        records = records[:a.limit]
    athletes = sorted({r.get("athlete_id", "") for r in records})
    all_refs = [p for ath in athletes for p in references_for(a.references, ath)]
    if not all_refs:
        raise SystemExit("no athlete reference photos found")
    config = {**idn.identity_config(a.face_models, all_refs), "detector": DETECTOR,
              "athletes_with_references": [ath for ath in athletes if references_for(a.references, ath)]}
    (out_dir / "identity").mkdir(parents=True, exist_ok=True)
    prep.write_json(out_dir / "identity" / "identity_config.json", config)
    # identical to the options prepare_capture_dataset.main() passes, plus the identity configuration
    options = {"variant": a.variant, "sample_hz": a.sample_hz, "max_side": a.max_side, "canonical": True, "mirror": False,
               "orientation_policy": a.orientation_policy,
               "orientation_overrides": str(a.orientation_overrides.resolve()) if a.orientation_overrides else None,
               "attestations": str(a.attestations) if a.attestations and a.attestations.exists() else None,
               "athlete_identity": config}
    print(json.dumps({"stage": "collect", "records": len(records), "workers": a.workers}), flush=True)
    try:
        sys.path.insert(0, str(ROOT / "ml"))
        from apexformz_telemetry import Run as _Run
        tel = _Run(kind="preprocessing", project="apexformz-brain", label="athlete identity resolution (face + track + clothing)",
                   total_steps=len(records), meta={"records": len(records)}, sensitive=["meta", "label"])
    except Exception:  # noqa: BLE001
        tel = None
    paths, failures = {}, []
    with ProcessPoolExecutor(max_workers=a.workers, mp_context=multiprocessing.get_context("spawn")) as ex:
        futs = {ex.submit(collect, r, options, str(out_dir), str(a.references), str(a.face_models)): r for r in records}
        for n, fut in enumerate(as_completed(futs), 1):
            r = futs[fut]
            try:
                paths[r["record_id"]] = fut.result()["path"]
            except Exception as e:  # noqa: BLE001
                failures.append({"record_id": r["record_id"], "reason": str(e)})
            if tel:
                tel.step(n, metrics={"failures": len(failures)})
            if n % 25 == 0 or n == len(records):
                print(json.dumps({"collected": n, "total": len(records), "failures": len(failures)}), flush=True)
    # Phase B: per-session clothing model from face-confirmed detections only
    by_session = defaultdict(dict)
    loaded = {}
    for r in records:
        if r["record_id"] in paths:
            loaded[r["record_id"]] = pickle.loads(Path(paths[r["record_id"]]).read_bytes())
            for f in loaded[r["record_id"]]["frames"]:  # front-facing flag from the body landmarks
                for c in f["cands"]:
                    p = f["persons"][c.det_index]
                    c.frontal = idn.is_frontal(p.xy, p.scores)
            by_session[(r.get("athlete_id"), r.get("capture_session_id"))][r["record_id"]] = [f["cands"] for f in loaded[r["record_id"]]["frames"]]
    models = {k: idn.session_clothing_model(v) for k, v in by_session.items()}
    # typical athlete size for single photos: same session and camera position -> similar size
    photo_sizes = defaultdict(list)
    for r in records:
        if r["record_id"] in loaded and r["media_kind"] == "image":
            cands = loaded[r["record_id"]]["frames"][0]["cands"]
            if cands:
                photo_sizes[(r.get("athlete_id"), r.get("capture_session_id"), r.get("view"))].append(max(idn._area(c.bbox) for c in cands))
    photo_typical = {k: float(np.median(v)) for k, v in photo_sizes.items() if len(v) >= 3}
    # Phase C: decide and write
    results = []
    for r in records:
        if r["record_id"] not in loaded:
            continue
        ath_ref, oth_ref = models[(r.get("athlete_id"), r.get("capture_session_id"))]
        data = loaded[r["record_id"]]
        hint = photo_typical.get((r.get("athlete_id"), r.get("capture_session_id"), r.get("view"))) if r["media_kind"] == "image" else None
        decisions = idn.resolve_record([f["cands"] for f in data["frames"]], ath_ref, oth_ref, typical_hint=hint)
        results.append(write_record(r, data, decisions, out_dir, options))
    methods = Counter()
    for res in results:
        methods.update(res.get("methods", {}))
    report = {"records": len(records), "written": sum(1 for x in results if "usable" in x),
              "excluded": [x for x in results if "excluded" in x], "collect_failures": failures,
              "frame_methods": dict(methods), "ambiguous_frames": sum(x.get("ambiguous", 0) for x in results),
              "sessions": {f"{k[0]}|{k[1]}": {"athlete_clothing": v[0] is not None, "other_clothing": v[1] is not None} for k, v in models.items()},
              "config": str(out_dir / "identity" / "identity_config.json")}
    prep.write_json(out_dir / "identity" / "identity_report.json", report)
    if tel:
        tel.end("completed", {"written": report["written"], "excluded": len(report["excluded"]), "ambiguous_frames": report["ambiguous_frames"]})
    print(json.dumps({k: v for k, v in report.items() if k not in ("excluded", "collect_failures")} | {"excluded": len(report["excluded"]), "collect_failures": len(failures)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
