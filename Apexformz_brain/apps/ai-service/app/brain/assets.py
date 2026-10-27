"""Private, immutable S3 asset decoding. Never fetch caller-controlled URLs."""
from __future__ import annotations

import hashlib
import json
import math
import os
import pathlib
import re
import tempfile
from functools import lru_cache

import boto3
from botocore.config import Config
from pydantic import BaseModel, Field
from apexformz_contracts import assert_valid
from app.brain.retrospective import AnalysisError

MAX_BYTES = 64 * 1024 * 1024
MODEL_SHA256 = "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1"


class AssetDescriptor(BaseModel):
    bucket: str
    key: str
    version_id: str = Field(min_length=1)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    content_type: str
    byte_size: int = Field(gt=0, le=MAX_BYTES)


@lru_cache(maxsize=1)
def s3_client():
    return boto3.client("s3", region_name=os.environ["AWS_REGION"],
                        config=Config(retries={"total_max_attempts": 3, "mode": "standard"},
                                      connect_timeout=5, read_timeout=60))


def download_asset(asset: AssetDescriptor) -> bytes:
    if asset.bucket != os.environ.get("APEXFORMZ_S3_BUCKET") or not re.fullmatch(r"assets/[0-9a-f-]{36}", asset.key):
        raise AnalysisError("ASSET_FORBIDDEN", "Asset is outside the configured private store")
    params = dict(Bucket=asset.bucket, Key=asset.key, VersionId=asset.version_id)
    if os.environ.get("APEXFORMZ_AWS_ACCOUNT_ID"):
        params["ExpectedBucketOwner"] = os.environ["APEXFORMZ_AWS_ACCOUNT_ID"]
    response = s3_client().get_object(**params)
    with response["Body"] as body:
        if response.get("ContentLength") != asset.byte_size or response.get("ContentType") != asset.content_type:
            raise AnalysisError("ASSET_INTEGRITY", "Asset metadata mismatch")
        data = body.read(MAX_BYTES + 1)
    if len(data) != asset.byte_size or hashlib.sha256(data).hexdigest() != asset.sha256:
        raise AnalysisError("ASSET_INTEGRITY", "Asset checksum/size mismatch")
    return data


def decode_asset(asset: AssetDescriptor, session_id: str) -> list[dict]:
    data = download_asset(asset)
    if asset.content_type == "application/json":
        try:
            frames = json.loads(data)
            if not isinstance(frames, list) or not 1 <= len(frames) <= 5000:
                raise ValueError("Expected 1..5000 PoseFrames")
            for frame in frames:
                assert_valid("poseFrame", frame)
            return frames
        except (ValueError, TypeError, UnicodeError) as e:
            raise AnalysisError("SCHEMA_INVALID", "Invalid PoseFrame bundle") from e
    if asset.content_type not in {"video/mp4", "video/webm", "image/jpeg", "image/png"}:
        raise AnalysisError("ASSET_TYPE", "Unsupported media type")
    # Fixed, hash-verified release model; no runtime download or caller-selected model.
    cache = pathlib.Path(os.environ["APEXFORMZ_MODEL_CACHE"])
    model = cache / "pose_landmarker_full.task"
    if not model.is_file() or hashlib.sha256(model.read_bytes()).hexdigest() != MODEL_SHA256:
        raise AnalysisError("MODEL_UNAVAILABLE", "Pinned pose model missing or corrupt")
    from apexformz_perception.pose import create_backend
    from apexformz_perception.pose.extract import extract_pose_sequence
    import cv2
    import numpy as np

    backend = create_backend("mediapipe", variant="full", num_poses=2, prefer_gpu=False)
    try:
        if asset.content_type.startswith("image/"):
            # Inspect encoded dimensions before allocation (decompression-bomb guard).
            import io
            from PIL import Image
            with Image.open(io.BytesIO(data)) as header:
                if header.width * header.height > 16_000_000:
                    raise AnalysisError("ASSET_LIMIT", "Image exceeds 16 megapixels")
            image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise AnalysisError("ASSET_DECODE", "Image cannot be decoded")
            h, w = image.shape[:2]
            people = backend.detect(image, 0, 0)
            if len(people) != 1:
                raise AnalysisError("SUBJECT_AMBIGUOUS", "Image must contain one identifiable athlete")
            return [backend.to_mediapipe33_pose_frame(people[0], session_id=session_id, frame_id=0, timestamp_ms=0,
                    camera_id="s3", image_size=(w, h), mirror=False, orientation="landscape",
                    tracked_subject_id="subject-1", person_count=1, ambiguous=False, track_changed=False)]
        suffix = ".mp4" if asset.content_type == "video/mp4" else ".webm"
        with tempfile.TemporaryDirectory(prefix="apexformz-asset-") as directory:
            path = pathlib.Path(directory) / ("input" + suffix)
            path.write_bytes(data)
            from apexformz_perception.io.video import probe
            info = probe(str(path))
            if info.width * info.height > 8_500_000 or info.frame_count <= 0 or info.fps <= 0 or info.frame_count / info.fps > 120:
                raise AnalysisError("ASSET_LIMIT", "Video must be at most 120 seconds and 8.5 megapixels")
            result = extract_pose_sequence(str(path), backend, session_id, max_frames=3600,
                                           stride=max(1, math.ceil(info.frame_count / 3600)), max_side=960)
            if not result.frames:
                raise AnalysisError("ASSET_DECODE", "Video contains no decodable frames")
            return result.frames
    finally:
        backend.close()

