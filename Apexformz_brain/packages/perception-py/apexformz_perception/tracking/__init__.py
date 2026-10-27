"""Point/object trackers behind contract-typed interfaces (TrackSet output).

Adapters: Google DeepMind TAPNet (BootsTAPIR offline, causal BootsTAPIR online, TAPNext++ online),
Meta CoTracker3 (non-commercial, gated), Meta SAM 2.1 video object tracking. See registry.py.
"""
from .base import (  # noqa: F401
    FramesLike, ModelUnavailable, ObjectPrompt, ObjectTracker, OnlineTracker, PointTracker, Query, TrackerInfo,
    ensure_checkpoint, iter_frames, make_trackset, model_cache_dir, points_to_track, provenance, trackset_dict,
)
from .fusion import assign_tracks_to_subject, fill_landmark_gaps, seed_queries_from_landmarks, track_displacement_stats, track_to_equipment_observations  # noqa: F401
from . import registry  # noqa: F401
