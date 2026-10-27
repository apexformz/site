import math
import os
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
SERVICE = HERE.parent
REPO = SERVICE.parent.parent
sys.path.insert(0, str(SERVICE))
sys.path.insert(0, str(REPO / "packages" / "contracts" / "python"))
sys.path.insert(0, str(HERE))
os.environ.setdefault("SPORT_PACKS_DIR", str(REPO / "sport-packs"))

from _synthetic import synthetic_frame  # noqa: E402


@pytest.fixture
def lunge_bundle():
    frames = []
    i = 0
    t = 0.0
    for knee, n in ((0, 15), (50, 6), (70, 10), (0, 12)):
        for _ in range(n):
            frames.append(synthetic_frame(i, t, right_knee_flexion=knee, right_arm_raise=40, right_elbow_flexion=20))
            i += 1
            t += 40.0
    return frames


@pytest.fixture
def repo():
    return REPO
