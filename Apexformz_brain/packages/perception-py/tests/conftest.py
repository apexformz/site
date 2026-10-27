import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
PKG = HERE.parent
REPO = PKG.parent.parent
sys.path.insert(0, str(PKG))
sys.path.insert(0, str(REPO / "packages" / "contracts" / "python"))

VIDEO = REPO.parent / "Apexformz" / "taekwando_training_videos" / "Ap_chagi_front_kick" / "front.mp4"


@pytest.fixture(scope="session")
def sample_video() -> pathlib.Path:
    if not VIDEO.exists():
        pytest.skip(f"sample video not found: {VIDEO}")
    return VIDEO
