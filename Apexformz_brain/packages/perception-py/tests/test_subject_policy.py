import numpy as np
import pytest
from apexformz_perception.subject.bytetrack import SubjectSelector


def person(cx):
    return (np.array([cx - .1, .2, cx + .1, .8]), .95)


def test_initial_competing_people_require_explicit_selection():
    selector = SubjectSelector()
    result = selector.select([person(.3), person(.7)])
    assert result.ambiguous and result.index is None and result.person_count == 2
    assert selector.subject_track_id is None


def test_explicit_region_excludes_reflection_without_reindexing_the_source():
    selector = SubjectSelector(subject_roi=(.05, .05, .5, .95))
    result = selector.select([person(.7), person(.3)])
    assert result.index == 1 and not result.ambiguous and result.person_count == 2
    # Target left the selected region; do not switch to a reflection/outside bystander.
    absent = selector.select([person(.7)])
    assert absent.index is None and absent.track_id == result.track_id


def test_two_competing_people_inside_region_still_abstain():
    selector = SubjectSelector(subject_roi=(.05, .05, .5, .95))
    selector.select([person(.3)])
    result = selector.select([person(.3), person(.36)])
    assert result.index is None and result.ambiguous and result.person_count == 2


def test_temporary_subject_loss_does_not_adopt_another_person():
    selector = SubjectSelector()
    first = selector.select([person(.3)])
    absent = selector.select([person(.85)])
    assert absent.index is None and absent.track_id == first.track_id


@pytest.mark.parametrize('roi', [(0, 0, 2, 1), (.5, 0, .2, 1), (0, 0, float('nan'), 1)])
def test_region_validation(roi):
    with pytest.raises(ValueError, match='subject_roi'):
        SubjectSelector(subject_roi=roi)
