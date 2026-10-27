"""The exploratory taxonomy must not learn similarity from identity failures or missing joints."""
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'sports/squash'))
import pose_similarity as ps
from build_taxonomy import semantic_family


def frame(t=0, track='athlete', x=0.0, **quality):
    points = [{'id': i, 'x': 0.45 + (i % 2) * 0.1 + x, 'y': 0.2 + (i // 2) * 0.03, 'visibility': 1.0} for i in range(33)]
    return {'timestamp_ms': t, 'camera_id': 'front', 'tracked_subject_id': track, 'image_size': [100, 100],
            'normalized_landmarks': points, 'quality': quality}


def test_unsafe_identity_never_enters_a_descriptor_segment():
    items = [frame(0), frame(33, ambiguous_people=True), frame(66), frame(99, track_changed=True), frame(132)]
    segments = ps.usable_segments(items)
    assert [[f['timestamp_ms'] for f in part] for part in segments] == [[0], [66], [132]]


def test_track_time_and_root_discontinuities_split_or_reject():
    assert [len(s) for s in ps.usable_segments([frame(0), frame(33), frame(66, track='other')])] == [2, 1]
    assert [len(s) for s in ps.usable_segments([frame(0), frame(800)])] == [1, 1]
    assert [f['timestamp_ms'] for s in ps.usable_segments([frame(0), frame(33, x=10.0), frame(66)]) for f in s] == [0, 66]


def test_disjoint_visible_channels_do_not_become_similar_by_mean_imputation():
    caps = [
        {'movement_id': 'a', 'view': 'front', 'descriptor': np.array([0., 1., 2., np.nan, np.nan])},
        {'movement_id': 'a', 'view': 'front', 'descriptor': np.array([0.1, 1.1, 2.1, np.nan, np.nan])},
        {'movement_id': 'b', 'view': 'front', 'descriptor': np.array([np.nan, np.nan, 2., 1., 0.])},
        {'movement_id': 'b', 'view': 'front', 'descriptor': np.array([np.nan, np.nan, 2.1, 1.1, 0.1])},
    ]
    labels, distances, _ = ps.class_distances(caps)
    assert labels == ['a', 'b']
    assert np.isnan(distances[0, 1])


def test_invalid_image_dimensions_and_missing_torso_are_rejected():
    assert ps.frame_channels(frame()['normalized_landmarks'], (100, 0)) is None
    missing = [p for p in frame()['normalized_landmarks'] if p['id'] != 23]
    assert ps.frame_channels(missing, (100, 100)) is None


def test_semantic_families_do_not_invent_side_or_tactical_intent():
    def classify(name, kind='dynamic'):
        return semantic_family({'name': name, 'movement_type': kind})
    assert classify('Drive swing') == 'dynamic.unspecified_strokes'
    assert classify('Forehand drive') == 'dynamic.forehand_strokes'
    assert classify('Backhand drive') == 'dynamic.backhand_strokes'
    assert classify('Forward attacking movement') == 'dynamic.forward_travel'
    assert classify('Defensive lateral movement') == 'dynamic.lateral_travel'
    assert classify('Forehand swing + recovery') == 'dynamic.stroke_recovery'
    assert classify('Front corner → T') == 'dynamic.recovery'
    assert classify('T \u2192 front corner') == 'dynamic.forward_travel'
    assert classify('T \u2192 back corner') == 'dynamic.backward_travel'
    assert classify('Left court \u2192 right court') == 'dynamic.lateral_travel'
    assert classify('Forward \u2192 backward') == 'dynamic.direction_changes'
    assert classify('Attacking shot pose', 'static') == 'static.hitting_positions'
