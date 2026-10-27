import numpy as np

from apexformz_perception.subject import identity as idn
from apexformz_perception.subject.identity import Candidate, resolve_record


def cand(i, box, face=None, px=0.0, cloth=None, frontal=False, track=None):
    return Candidate(i, track, np.array(box, dtype=float), face, px, cloth, frontal)


ATH = [0.40, 0.30, 0.50, 0.80]
OTHER = [0.70, 0.30, 0.80, 0.80]


def test_face_anchor_is_carried_through_frames_without_a_face():
    frames = [[cand(0, ATH, face=0.7, px=60, frontal=True), cand(1, OTHER)]]
    for k in range(1, 5):  # athlete turns away: no face, moves slightly
        frames.append([cand(0, OTHER), cand(1, [0.40 + 0.01 * k, 0.30, 0.50 + 0.01 * k, 0.80])])
    out = resolve_record(frames, None, None)
    assert [d.det_index for d in out] == [0, 1, 1, 1, 1]
    assert out[0].method == "face" and all(d.method == "face_track" for d in out[1:]) and not any(d.ambiguous for d in out)


def test_small_faces_never_reject_but_large_ones_do():
    small = resolve_record([[cand(0, ATH, face=0.05, px=25, frontal=True)]], None, None)
    assert small[0].det_index == 0  # tiny face: unreliable, falls back instead of rejecting the athlete
    large = resolve_record([[cand(0, ATH, face=0.05, px=80, frontal=True)]], None, None)
    assert large[0].det_index is None and not large[0].ambiguous  # clearly someone else: athlete not in view


def test_back_of_head_face_detections_are_ignored():
    out = resolve_record([[cand(0, ATH, face=0.0, px=80, frontal=False)]], None, None)
    assert out[0].det_index == 0  # not front-facing, so the low score is not evidence


def test_duplicate_and_fragment_detections_do_not_create_ambiguity():
    frames = [[cand(0, ATH), cand(1, [0.401, 0.30, 0.501, 0.80]), cand(2, [0.42, 0.35, 0.48, 0.55])]]
    out = resolve_record(frames, None, None)
    assert out[0].det_index in (0, 1) and not out[0].ambiguous


def test_comparable_unknown_people_close_together_stay_ambiguous():
    frames = [[cand(0, ATH), cand(1, [0.52, 0.30, 0.62, 0.80])]]
    out = resolve_record(frames, None, None)
    assert out[0].det_index is None and out[0].ambiguous


def test_size_fallback_rejects_body_fragments():
    frames = [[cand(0, ATH, face=0.7, px=60, frontal=True)], [cand(0, [0.44, 0.40, 0.47, 0.50])]]  # tiny box, no link
    out = resolve_record(frames, None, None)
    assert out[1].det_index is None


def test_frontal_requires_front_view_eye_order():
    xy = np.zeros((33, 2)); scores = np.ones(33)
    xy[11, 0], xy[12, 0] = 0.6, 0.4          # shoulders
    xy[2, 0], xy[5, 0] = 0.53, 0.47          # person's left eye on the image right: facing camera
    assert idn.is_frontal(xy, scores)
    xy[2, 0], xy[5, 0] = 0.47, 0.53          # reversed: back of head
    assert not idn.is_frontal(xy, scores)


def test_session_clothing_model_uses_only_reliable_faces():
    region_a, region_b = np.r_[np.full(12, 1 / 12), np.zeros(12)], np.r_[np.zeros(12), np.full(12, 1 / 12)]
    red, white = np.r_[region_a, region_a], np.r_[region_b, region_b]  # torso and legs both differ
    frames = {"r": [[cand(0, ATH, face=0.7, px=60, frontal=True, cloth=red)],
                    [cand(0, ATH, face=0.1, px=25, frontal=True, cloth=red)]]}  # small face: not an "other" sample
    ath, oth = idn.session_clothing_model(frames)
    assert ath is not None and oth is None
    assert idn.clothing_distance(red, red) < 1e-6 and idn.clothing_distance(red, white) > 0.5
