import json
from pathlib import Path

import numpy as np

from apexformz_perception.subject import body_signature as bs

FIXTURE = Path(__file__).resolve().parents[2] / "perception" / "src" / "__fixtures__" / "body_signature.json"


def test_matches_shared_fixture_with_typescript():
    fx = json.loads(FIXTURE.read_text(encoding="utf-8"))
    sigs = []
    for case in fx["cases"]:
        world = np.array([[p["x"], p["y"], p["z"]] for p in case["world"]])
        sig = bs.signature(world, np.array(case["visibility"]))
        want = np.array([np.nan if v is None else v for v in case["signature"]])
        assert np.allclose(sig, want, equal_nan=True, atol=1e-6)
        sigs.append(sig)
    for a, row in enumerate(fx["distances"]):
        for b, want in enumerate(row):
            got = bs.distance(sigs[a], sigs[b])
            assert (got is None and want is None) or abs(got - want) < 1e-6


def test_hidden_torso_gives_no_signature_and_running_median_is_robust():
    world = np.zeros((33, 3)); vis = np.zeros(33)
    assert bs.signature(world, vis) is None
    run = bs.RunningSignature()
    for v in [1.0] * 9 + [9.0]:  # one outlier
        run.add(np.full(6, v))
    assert run.ready and np.allclose(run.value(), 1.0)  # 10 samples: ready; the median ignores the outlier
