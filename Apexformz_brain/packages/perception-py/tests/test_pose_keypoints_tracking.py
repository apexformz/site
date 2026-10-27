import numpy as np
import pytest

from apexformz_perception.pose import COCO17_TO_MP33, COCO_17, COCO_WHOLEBODY_133, HALPE_26, MEDIAPIPE_POSE_33, PersonPose, build_pose_frame
from apexformz_perception.pose.keypoint_sets import CORE_BODY_MP_IDS, mapping_to_mediapipe33, unsupported_mediapipe_ids
from apexformz_perception.subject import ByteTracker, SubjectSelector, iou_matrix
from apexformz_perception.smoothing import butterworth_zero_phase, savitzky_golay, smooth_pose_frames

try:
    from apexformz_contracts import validate
except ImportError:  # pragma: no cover
    validate = None


def test_keypoint_sets_shapes_and_mapping():
    assert len(MEDIAPIPE_POSE_33) == 33 and len(COCO_17) == 17 and len(HALPE_26) == 26 and len(COCO_WHOLEBODY_133) == 133
    assert len(COCO17_TO_MP33) == 17
    # every COCO joint lands on the same-named MediaPipe landmark
    for ci, mi in COCO17_TO_MP33.items():
        assert COCO_17[ci] == MEDIAPIPE_POSE_33[mi]
    assert set(CORE_BODY_MP_IDS) <= set(COCO17_TO_MP33.values())
    m133 = mapping_to_mediapipe33("coco_wholebody_133")
    assert MEDIAPIPE_POSE_33[m133[17]] == "left_foot_index"  # left_big_toe alias
    assert len(set(m133.values())) == len(m133)  # injective
    assert 1 in unsupported_mediapipe_ids("coco_17")  # left_eye_inner never provided by COCO


def _person(set_name: str, n: int, vis: float = 0.9) -> PersonPose:
    xy = np.stack([np.linspace(0.3, 0.7, n), np.linspace(0.2, 0.9, n)], axis=1)
    return PersonPose(landmark_set=set_name, xy=xy, scores=np.full(n, vis))


def test_build_pose_frame_canonical_and_native_are_contract_valid():
    kw = dict(session_id="s", frame_id=3, timestamp_ms=100.0, camera_id="c", image_size=(1280, 720), mirror=False, orientation="landscape",
              provenance={"model_id": "m", "version": "1"}, tracked_subject_id="track-1", person_count=1)
    canon = build_pose_frame(_person("coco_17", 17), canonical=True, **kw)
    assert canon["landmark_set"] == "mediapipe_pose_33" and len(canon["normalized_landmarks"]) == 33
    provided = {l["id"] for l in canon["normalized_landmarks"] if l["visibility"] > 0}
    assert provided == set(COCO17_TO_MP33.values())
    assert canon["quality"]["missing_joints"] == []  # all core joints provided
    native = build_pose_frame(_person("coco_17", 17), canonical=False, **kw)
    assert native["landmark_set"] == "coco_17" and len(native["normalized_landmarks"]) == 17
    rich = build_pose_frame(_person("coco_wholebody_133", 133), canonical=False, **kw)
    assert rich["landmark_set"] == "custom"
    empty = build_pose_frame(None, canonical=True, **dict(kw, person_count=0, tracked_subject_id=None))
    assert empty["quality"]["framing_ok"] is False and len(empty["quality"]["missing_joints"]) == 33
    if validate:
        for fr in (canon, native, rich, empty):
            assert validate("poseFrame", fr) == []


def test_missing_core_joint_is_reported():
    p = _person("coco_17", 17)
    p.scores[15] = 0.1  # left_ankle hidden
    fr = build_pose_frame(p, canonical=True, session_id="s", frame_id=0, timestamp_ms=0, camera_id="c", image_size=(640, 480), mirror=False,
                          orientation="landscape", provenance={"model_id": "m", "version": "1"}, tracked_subject_id=None, person_count=1)
    assert MEDIAPIPE_POSE_33.index("left_ankle") in fr["quality"]["missing_joints"]
    assert fr["quality"]["framing_ok"] is False


def _box(cx, cy, w=0.2, h=0.5):
    return np.array([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2])


def test_iou_matrix():
    m = iou_matrix(np.array([_box(0.5, 0.5)]), np.array([_box(0.5, 0.5), _box(0.9, 0.9)]))
    assert m.shape == (1, 2) and abs(m[0, 0] - 1.0) < 1e-9 and m[0, 1] == 0


def test_bytetrack_keeps_identity_and_reacquires_after_loss():
    tr = ByteTracker(track_buffer=10)
    ids = set()
    for t in range(30):
        tracks = tr.update([(_box(0.3 + 0.005 * t, 0.5), 0.9)])
        assert len(tracks) == 1
        ids.add(tracks[0].track_id)
    assert ids == {1}
    for _ in range(5):  # occlusion: no detections
        tr.update([])
    tracks = tr.update([(_box(0.3 + 0.005 * 35, 0.5), 0.9)])
    assert len(tracks) == 1 and tracks[0].track_id == 1  # recovered within the buffer
    for _ in range(20):
        tr.update([])
    tracks = tr.update([(_box(0.9, 0.5), 0.9)])
    assert tracks and tracks[0].track_id != 1  # lost beyond the buffer => new identity


def test_bytetrack_two_people_and_low_score_recovery():
    tr = ByteTracker()
    for t in range(10):
        tracks = tr.update([(_box(0.3, 0.5), 0.9), (_box(0.7, 0.5), 0.9)])
    assert sorted(t.track_id for t in tracks) == [1, 2]
    # person 2 gets a low-score detection: stage-2 association keeps it alive
    tracks = tr.update([(_box(0.3, 0.5), 0.9), (_box(0.7, 0.5), 0.3)])
    assert sorted(t.track_id for t in tracks) == [1, 2]
    # a pure background low-score blob never creates a track
    tracks = tr.update([(_box(0.3, 0.5), 0.9), (_box(0.7, 0.5), 0.9), (_box(0.1, 0.1, 0.05, 0.05), 0.2)])
    assert len(tracks) == 2


def test_subject_selector_flags_ambiguity_and_track_change():
    sel = SubjectSelector()
    for _ in range(5):
        s = sel.select([(_box(0.5, 0.5), 0.9)])
    assert s.track_id == "track-1" and not s.ambiguous and not s.track_changed
    s = sel.select([(_box(0.5, 0.5), 0.9), (_box(0.62, 0.5), 0.9)])  # similar-size person next to the athlete
    assert s.ambiguous is True and s.track_id == "track-1"
    s = sel.select([(_box(0.5, 0.5), 0.9), (_box(0.95, 0.9, 0.05, 0.1), 0.9)])  # small distant bystander
    assert s.ambiguous is False
    for _ in range(40):
        sel.select([])
    s = sel.select([(_box(0.2, 0.5), 0.9)])
    assert s.track_changed is True and s.track_id != "track-1"  # bystanders consumed ids 2-3


def test_smoothers_fill_gaps_and_flag_retrospective():
    t = np.arange(120)
    x = np.stack([np.sin(t / 10), np.cos(t / 10)], axis=1)
    noisy = x + np.random.default_rng(0).normal(0, 0.05, x.shape)
    mask = np.ones(120, dtype=bool)
    mask[50:55] = False
    sg = savitzky_golay(noisy, mask)
    bw = butterworth_zero_phase(noisy, fs=30.0, mask=mask, cutoff_hz=3.0)
    for r in (sg, bw):
        assert r.retrospective is True and r.values.shape == x.shape
        assert np.abs(r.values - x).mean() < np.abs(noisy - x).mean()


def test_smooth_pose_frames_preserves_contract():
    frames = []
    for i in range(40):
        p = _person("coco_17", 17)
        p.xy = p.xy + np.random.default_rng(i).normal(0, 0.01, p.xy.shape)
        frames.append(build_pose_frame(p, canonical=True, session_id="s", frame_id=i, timestamp_ms=i * 33.3, camera_id="c", image_size=(640, 480),
                                       mirror=False, orientation="landscape", provenance={"model_id": "m", "version": "1"}, tracked_subject_id="t", person_count=1))
    out = smooth_pose_frames(frames, method="butterworth", cutoff_hz=4.0)
    assert out["retrospective"] is True and len(out["frames"]) == 40
    if validate:
        assert validate("poseFrame", out["frames"][5]) == []
