import json
import pathlib
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parent
PKG_ROOT = HERE.parent
REPO = PKG_ROOT.parent.parent.parent
sys.path.insert(0, str(PKG_ROOT))

FIXTURES = REPO / "packages" / "contracts" / "fixtures"
SCHEMAS = REPO / "packages" / "contracts" / "schemas"
SPORT_PACKS = REPO / "sport-packs"


@pytest.fixture(scope="session")
def fixture_index():
    return json.loads((FIXTURES / "index.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def repo():
    return REPO


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))
