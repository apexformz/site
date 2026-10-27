import numpy as np

from apexformz_perception.subject.lock_on import body_coverage, select_by_mask


def person(cx, cy, h=0.4):
    xy = np.full((33, 2), [cx, cy], dtype=float)
    for i, (dx, dy) in {0: (0, -0.45), 11: (-0.1, -0.3), 12: (0.1, -0.3), 13: (-0.12, -0.15), 14: (0.12, -0.15), 15: (-0.13, 0),
                         16: (0.13, 0), 23: (-0.07, 0), 24: (0.07, 0), 25: (-0.07, 0.25), 26: (0.07, 0.25), 27: (-0.07, 0.45), 28: (0.07, 0.45)}.items():
        xy[i] = [cx + dx * h, cy + dy * h]
    return xy, np.full(33, 0.9)


def mask_around(cx, cy, half_w=0.08, half_h=0.22, size=(100, 100)):
    m = np.zeros(size, dtype=bool)
    h, w = size
    m[int((cy - half_h) * h):int((cy + half_h) * h), int((cx - half_w) * w):int((cx + half_w) * w)] = True
    return m


def test_keeps_only_the_skeleton_inside_the_locked_mask():
    athlete, other = person(0.3, 0.5), person(0.7, 0.5)
    idx, amb, cov = select_by_mask([other, athlete], mask_around(0.3, 0.5))
    assert idx == 1 and not amb and cov >= 0.9


def test_two_bodies_in_one_mask_are_withheld():
    # two different people partly overlapping inside one (wide) mask: a real crossing
    idx, amb, _ = select_by_mask([person(0.26, 0.5), person(0.34, 0.5)], mask_around(0.3, 0.5, half_w=0.15))
    assert idx is None and amb


def test_empty_mask_means_not_in_view():
    idx, amb, cov = select_by_mask([person(0.3, 0.5)], np.zeros((100, 100), dtype=bool))
    assert idx is None and not amb and cov is None


def test_too_few_visible_points_give_no_coverage():
    xy, sc = person(0.3, 0.5)
    sc[:] = 0.1
    assert body_coverage(xy, sc, mask_around(0.3, 0.5)) is None


def test_tap_selects_the_whole_body_box_of_the_person_under_the_finger():
    from apexformz_perception.subject.lock_on import tapped_person_box
    a, b = person(0.3, 0.5), person(0.7, 0.5)
    box = tapped_person_box([b, a], (0.3, 0.5))
    assert box is not None and box[0] < 0.27 and box[2] > 0.33 and box[1] < 0.33 and box[3] > 0.67
    assert tapped_person_box([b, a], (0.05, 0.05)) is None


def test_duplicate_detections_of_the_locked_person_are_not_a_crossing():
    a = person(0.3, 0.5)
    dup = (a[0] + 0.004, a[1].copy())
    idx, amb, _ = select_by_mask([a, dup], mask_around(0.3, 0.5))
    assert idx in (0, 1) and not amb
