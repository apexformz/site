from copy import deepcopy
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from model_provenance import ensemble_lineage


def members():
    return [{"run_id": name, "dry_run": False, "dataset_manifest_sha256": "a" * 64,
             "split_manifest_sha256": None, "checkpoint_sha256": digest * 64,
             "dataset": {"split_evidence": {"athlete_disjoint": None, "partitions": ["train"]}}}
            for name, digest in [("tcn", "b"), ("stgcn", "c")]]


def test_embedded_development_split_does_not_become_a_validated_holdout():
    result = ensemble_lineage(members())
    assert result["dataset_hash"] == "a" * 64
    assert result["split_manifest_hash"] is None
    assert result["athlete_disjoint"] is None
    assert result["split_evidence"]["partitions"] == ["train"]
    assert len(result["member_training_records"]) == 2


@pytest.mark.parametrize("field,value", [("dataset_manifest_sha256", "d" * 64), ("split_manifest_sha256", "e" * 64), ("dry_run", True)])
def test_incompatible_or_synthetic_lineage_is_rejected(field, value):
    records = deepcopy(members())
    records[1][field] = value
    with pytest.raises(ValueError):
        ensemble_lineage(records)
