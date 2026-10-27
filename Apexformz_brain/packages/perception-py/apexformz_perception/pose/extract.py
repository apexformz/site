"""Video -> contract PoseFrame sequence: backend detection + ByteTrack subject selection + validation."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..io.video import probe, read_frames
from ..subject.bytetrack import SubjectSelector
from .base import PersonPose, PoseBackend

log = logging.getLogger("apexformz.perception.extract")


@dataclass
class ExtractionResult:
    frames: List[Dict[str, Any]]
    provenance: Dict[str, Any]
    video: Dict[str, Any]
    stats: Dict[str, Any] = field(default_factory=dict)


def _validate(frame: Dict[str, Any]) -> None:
    try:
        from apexformz_contracts import validate  # type: ignore
    except ImportError:  # pragma: no cover
        return
    errors = validate("poseFrame", frame)
    if errors:
        raise ValueError(f"PoseFrame failed contract validation: {errors[:3]}")


def extract_pose_sequence(video_path: str, backend: PoseBackend, session_id: str, camera_id: str = "video",
                          max_frames: Optional[int] = None, stride: int = 1, mirror: bool = False, orientation: str = "landscape",
                          canonical: bool = True, max_side: Optional[int] = None, validate_frames: bool = True,
                          selector: Optional[SubjectSelector] = None, honor_orientation: bool = True) -> ExtractionResult:
    """Run a pose backend over a video and return validated PoseFrames (one per processed frame).

    The chosen athlete comes from ByteTrack subject selection; frames with no person
    yield an empty-landmark frame (framing_ok False) so temporal gaps stay explicit.
    """
    info = probe(video_path, honor_orientation=honor_orientation)
    selector = selector or SubjectSelector()
    frames: List[Dict[str, Any]] = []
    n_persons_total = 0
    framing_ok = 0
    ambiguous = 0
    t0 = time.perf_counter()
    for frame_id, ts, img in read_frames(video_path, max_frames=max_frames, stride=stride, max_side=max_side, honor_orientation=honor_orientation):
        h, w = img.shape[:2]
        persons: List[PersonPose] = backend.detect(img, ts, frame_id)
        n_persons_total += len(persons)
        dets = [(p.bbox_or_from_keypoints(), p.detection_score if p.detection_score else p.confidence()) for p in persons]
        sel = selector.select(dets)
        person = persons[sel.index] if sel.index is not None and sel.index < len(persons) else None
        kwargs = dict(session_id=session_id, frame_id=frame_id, timestamp_ms=ts, camera_id=camera_id, image_size=(w, h), mirror=mirror,
                      orientation=orientation, tracked_subject_id=sel.track_id, person_count=sel.person_count, ambiguous=sel.ambiguous,
                      track_changed=sel.track_changed)
        frame = backend.to_mediapipe33_pose_frame(person, **kwargs) if canonical else backend.to_pose_frame(person, **kwargs)
        if validate_frames:
            _validate(frame)
        if frame["quality"]["framing_ok"]:
            framing_ok += 1
        if sel.ambiguous:
            ambiguous += 1
        frames.append(frame)
    dt = time.perf_counter() - t0
    stats = {"frames": len(frames), "framing_ok_ratio": framing_ok / len(frames) if frames else 0.0, "ambiguous_frames": ambiguous,
             "mean_persons": n_persons_total / len(frames) if frames else 0.0, "seconds": dt, "fps": len(frames) / dt if dt > 0 else None}
    log.info("extracted %d frames from %s with %s (%.1f fps)", len(frames), video_path, backend.name, stats["fps"] or 0)
    return ExtractionResult(frames=frames, provenance=backend.provenance(), video={"path": video_path, "width": info.width, "height": info.height,
                            "fps": info.fps, "frame_count": info.frame_count, "stride": stride,
                            "honor_orientation": honor_orientation}, stats=stats)
