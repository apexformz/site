"""Calibration uses reviewed repetitions, train-only evidence, and runtime semantics."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import pytest

from ml.calibration import criterion_fit as fit

ROOT = Path(__file__).resolve().parents[2]
PINS = {key: hashlib.sha256(key.encode()).hexdigest() for key in fit.PIN_KEYS}


def fixture():
    executions, streams, labels, measurements, assignments, pairs = [], [], [], [], {}, []
    for split in ("train", "val", "test"):
        for i, (value, outcome) in enumerate([(1, "PASS"), (2, "PASS"), (3, "PASS"), (7, "IMPROVE"), (8, "IMPROVE"), (9, "IMPROVE")]):
            eid, sid = f"{split}-{i}", f"{split}-stream-{i}"
            athlete = f"{split}-athlete-{i % 2}"
            checksum = hashlib.sha256(eid.encode()).hexdigest()
            executions.append({"execution_id": eid, "movement_id": "squash.test", "athlete_id": athlete,
                               "capture_session_id": f"{split}-session-{i % 2}", "view_stream_ids": [sid], "start_ms": 0, "end_ms": 1000})
            streams.append({"view_stream_id": sid, "view": "front", "sha256": checksum,
                            "object_uri": f"s3://apexformz-datacapture-test/raw/squash/{eid}.mp4",
                            "extraction": {"orientation_policy": "encoded"}})
            assignments[eid] = split
            labels.append({"execution_id": eid, "source_execution_id": eid, "stream_id": sid, "movement_id": "squash.test",
                           "athlete_id": athlete, "capture_session_id": f"{split}-session-{i % 2}", "source_sha256": checksum,
                           "view": "front", "handedness": "right", "review_status": "reviewed", "annotator_id": "coach-A",
                           "annotation_version": 1, "disagreement": None, "start_ms": 0, "end_ms": 1000, "criteria": {"c": outcome}})
            measurements.append({"execution_id": eid, "source_execution_id": eid, "stream_id": sid, "criterion_id": "c",
                                 "athlete_id": athlete, "capture_session_id": f"{split}-session-{i % 2}", "source_sha256": checksum,
                                 "timestamp_ms": 900, "measurement_start_ms": 0, "measurement_end_ms": 900,
                                 "athlete_context": "advanced", "handedness": "right", "evidence": {"view": "front"},
                                 "measurement": {"value": value, "unit": "deg", "feature_id": "angle", "reason": None},
                                 "pipeline_provenance": copy.deepcopy(PINS)})
            if split == "train":
                pairs.append({"pair_id": eid, "source_execution_id": eid, "source_sha256": checksum,
                              "unit": "deg", "measurement_a": 5, "measurement_b": 5.1})
    manifest = {"sport_pack_id": "squash", "view_streams": streams, "executions": executions, "splits": {"assignments": assignments}}
    return {"manifests": [manifest], "rubric": {"criteria": [{"criterion_id": "c", "movement_id": "squash.test",
                                                           "evaluator": {"kind": "max_value", "limit": 99, "tolerance": 0}}]},
            "labels": labels, "assignments": assignments, "measurements": measurements, "expected_pins": PINS,
            "floor_evidence": {"method": "paired_absolute_difference_quantile", "quantile": .95, "protocol_id": "repeatability-v1",
                               "review_status": "reviewed", "reviewer_id": "measurement-reviewer", "pipeline_provenance": PINS, "pairs": pairs},
            "search": {"relative_candidates": [0, .05], "context_scale_candidates": [1], "consistency_candidates": [{"enabled": False}],
                       "costs": {"false_acceptance": 2, "false_correction": 1, "abstention": .25}}}


def test_recovers_separating_threshold_and_reports_fixed_heldout():
    report = fit.run_fit(**fixture())
    proposal, = report["proposals"]
    assert 3 <= proposal["proposed_evaluator"]["limit"] < 7
    assert proposal["train"]["weighted_loss"] == 0
    assert proposal["heldout"]["test"]["accuracy_when_decided"] == 1
    assert proposal["heldout"]["val"]["executions"] == 6
    assert not report["production_eligible"] and not proposal["production_eligible"]
    assert proposal["selection_split"] == "train"
    json.dumps(report, allow_nan=False)


def test_fits_range_bounds_from_train_only():
    data = fixture()
    data["rubric"]["criteria"][0]["evaluator"] = {"kind": "range", "range": [99, 100], "tolerance": 0}
    proposal, = fit.run_fit(**data)["proposals"]
    lo, hi = proposal["proposed_evaluator"]["range"]
    assert lo <= 1 <= 3 <= hi < 7
    assert proposal["train"]["weighted_loss"] == 0


def test_heldout_values_and_outcomes_do_not_select_parameters():
    original = fixture()
    first = fit.run_fit(**original)["proposals"][0]
    changed = copy.deepcopy(original)
    for row in changed["measurements"]:
        if row["execution_id"].startswith(("val-", "test-")):
            row["measurement"]["value"] += 10000
    for row in changed["labels"]:
        if row["execution_id"].startswith(("val-", "test-")):
            row["criteria"]["c"] = "IMPROVE" if row["criteria"]["c"] == "PASS" else "PASS"
    second = fit.run_fit(**changed)["proposals"][0]
    assert first["proposed_evaluator"] == second["proposed_evaluator"]
    assert first["human_variance"] == second["human_variance"]
    assert first["train"] == second["train"]
    assert first["heldout"] != second["heldout"]


def test_train_search_can_prefer_uncertainty_band_over_wrong_corrections():
    data = fixture()
    data["search"]["relative_candidates"] = [0, .5]
    for row, value in zip(data["measurements"][:6], [1, 2, 6, 5, 9, 10]):
        row["measurement"]["value"] = value
    proposal, = fit.run_fit(**data)["proposals"]
    assert proposal["human_variance"]["relative"] == .5
    assert proposal["train"]["confusion"]["PASS"]["IMPROVE"] == 0
    assert proposal["train"]["coverage"] >= .6
    assert proposal["train"]["confusion"]["PASS"]["UNCERTAIN"] > 0


@pytest.mark.parametrize("field", ["athlete_id", "capture_session_id"])
def test_known_identity_cannot_leak_between_splits(field):
    data = fixture()
    data["manifests"][0]["executions"][6][field] = data["manifests"][0]["executions"][0][field]
    with pytest.raises(ValueError, match="split leakage"):
        fit.run_fit(**data)


def test_same_media_bytes_cannot_leak_via_different_ids():
    data = fixture()
    data["manifests"][0]["view_streams"][6]["sha256"] = data["manifests"][0]["view_streams"][0]["sha256"]
    with pytest.raises(ValueError, match="split leakage"):
        fit.run_fit(**data)


@pytest.mark.parametrize("mutation,match", [
    (lambda d: d["labels"][0].update(review_status="pending"), "independent reviewed"),
    (lambda d: d["labels"][0].update(annotator_id="importer:expert"), "independent reviewed"),
    (lambda d: d["labels"][0].update(disagreement="unresolved"), "independent reviewed"),
    (lambda d: d["labels"][0].update(source_sha256="0" * 64), "source hash/view"),
    (lambda d: d["assignments"].update({"train-0": "test"}), "split leakage|review split"),
    (lambda d: d["measurements"][0]["pipeline_provenance"].update(runtime_sha256="0" * 64), "pipeline provenance"),
    (lambda d: d["measurements"][0].update(handedness="left"), "handedness mismatch"),
])
def test_invalid_evidence_rejected(mutation, match):
    data = fixture()
    mutation(data)
    with pytest.raises(ValueError, match=match):
        fit.run_fit(**data)


def test_uncertain_labels_and_quality_abstentions_never_become_training_targets():
    data = fixture()
    data["labels"][0]["criteria"]["c"] = "UNCERTAIN"
    data["measurements"][1]["measurement"]["reason"] = "LOW_CONFIDENCE"
    report = fit.run_fit(**data)
    assert not report["proposals"]
    assert report["measurement_exclusions"] == {"review_abstention": 1, "measurement_quality_or_unavailable": 1}
    assert "insufficient_reviewed_train_outcomes" in report["blocked_scopes"][0]["reasons"]


def test_duplicate_live_frames_cannot_manufacture_repetitions():
    data = fixture()
    data["measurements"].append(copy.deepcopy(data["measurements"][0]))
    with pytest.raises(ValueError, match="multiple runtime aggregates"):
        fit.run_fit(**data)


def test_cross_boundary_aggregation_is_not_assigned_to_reviewed_subrep():
    data = fixture()
    data["labels"][0]["start_ms"] = 500
    report = fit.run_fit(**data)
    assert report["measurement_exclusions"] == {"no_unique_reviewed_aggregate_interval": 1}
    data["measurements"][0]["measurement_start_ms"] = 500
    assert fit.run_fit(**data)["joined_measurements"] == 18
    data["measurements"][0].pop("measurement_start_ms")
    data["measurements"][0].pop("measurement_end_ms")
    assert fit.run_fit(**data)["joined_measurements"] == 17


def test_repeatability_floor_is_from_paired_measurements_not_label_noise():
    data = fixture()
    report = fit.run_fit(**data)
    assert report["measurement_floors"]["units"]["deg"]["floor"] == pytest.approx(.1)
    data["floor_evidence"]["pairs"][0]["source_execution_id"] = "test-0"
    with pytest.raises(ValueError, match="held-out repeatability"):
        fit.run_fit(**data)


def test_extra_replay_configuration_pins_cannot_be_mixed():
    data = fixture()
    data["measurements"][0]["pipeline_provenance"]["config_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="pipeline provenance"):
        fit.run_fit(**data)


def test_measurement_unit_must_match_pinned_feature():
    data = fixture()
    data["rubric"]["features"] = [{"id": "angle", "kind": "angle_at", "params": {}, "unit": "rad"}]
    with pytest.raises(ValueError, match="unit differs"):
        fit.run_fit(**data)


def test_readiness_validates_derived_units_even_without_reviewed_labels():
    data = fixture()
    data["rubric"]["features"] = [{"id": "base", "kind": "angle_at", "params": {}},
                                 {"id": "angle", "kind": "angular_velocity", "params": {"of": "base"}}]
    data.update(labels=[], assignments={})
    with pytest.raises(ValueError, match="unit differs"):
        fit.run_fit(**data, readiness=True)
    for row in data["measurements"]:
        row["measurement"]["unit"] = "deg_per_s"
    assert fit.run_fit(**data, readiness=True)["reviewed_executions"] == 0


def test_unit_dependency_validation_preserved_even_with_explicit_unit():
    with pytest.raises(ValueError, match="unknown feature dependency"):
        fit.resolve_feature_units([{"id": "a", "kind": "window_mean", "unit": "deg", "params": {"of": "missing"}}])
    with pytest.raises(ValueError, match="dependency cycle"):
        fit.resolve_feature_units([{"id": "a", "kind": "window_mean", "unit": "deg", "params": {"of": "b"}},
                                   {"id": "b", "kind": "window_mean", "params": {"of": "a"}}])


@pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "node_modules/tsx").exists(), reason="Feature parity requires local node/tsx")
def test_real_squash_optional_feature_units_match_typescript_engine():
    rubric = json.loads((ROOT / "sport-packs/squash/technique_criteria.json").read_text(encoding="utf-8"))
    assert any("unit" not in feature for feature in rubric["features"])
    script = "import fs from 'node:fs'; import {FeatureEngine} from './packages/features/src/engine.ts';"
    script += "const f=JSON.parse(fs.readFileSync('sport-packs/squash/technique_criteria.json','utf8')).features; const engine=new FeatureEngine(f);"
    script += "console.log(JSON.stringify(Object.fromEntries(f.map(s=>[s.id,engine.unitOf(s.id)]))));"
    process = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
    expected = json.loads(process.stdout)
    assert fit.resolve_feature_units(rubric["features"]) == expected
    assert expected["lead_knee_velocity"] == "deg_per_s"
    assert expected["dominant_wrist_jerk"] == "normalized_per_s3"
    assert expected["body_travel"] == "normalized"


def test_missing_floor_or_single_athlete_blocks_proposal_not_just_disclaimer():
    data = fixture()
    data["floor_evidence"] = None
    report = fit.run_fit(**data)
    assert not report["proposals"] and "missing_independent_measurement_floor" in report["blocked_scopes"][0]["reasons"]
    data = fixture()
    for source in data["manifests"][0]["executions"]:
        if source["execution_id"].startswith("train-"):
            source["athlete_id"] = "only-athlete"
    for row in data["labels"] + data["measurements"]:
        if row["execution_id"].startswith("train-"):
            row["athlete_id"] = "only-athlete"
    report = fit.run_fit(**data)
    assert not report["proposals"]
    assert "insufficient_known_independent_train_athletes" in report["blocked_scopes"][0]["reasons"]


def test_contexts_and_views_are_not_pooled_to_fake_support():
    data = fixture()
    data["measurements"][0]["athlete_context"] = "unknown"
    report = fit.run_fit(**data)
    assert not report["proposals"]
    assert {scope["scope"]["athlete_context"] for scope in report["blocked_scopes"]} == {"unknown", "advanced"}


def test_readiness_never_infers_technique_labels_from_capture_identity():
    data = fixture()
    data.update(labels=[], assignments={}, measurements=[], expected_pins=None, floor_evidence=None, search=None)
    report = fit.run_fit(**data, readiness=True)
    assert report["source_executions"] == 18 and report["reviewed_executions"] == 0
    assert not report["proposals"] and not report["coach_approval_inferred"]
    assert "missing_independently_reviewed_PASS_IMPROVE_annotations" in report["blockers"]


def test_floor_and_tolerance_survive_context_scaling_and_default_is_inert():
    evaluator = {"kind": "max_value", "limit": 10, "tolerance": 2}
    assert fit.variance_band(evaluator, "deg", "advanced", {}) == 0
    profile = {"relative": .1, "measurement_floor": {"deg": 5}, "context_scale": {"advanced": .1}}
    assert fit.variance_band(evaluator, "deg", "advanced", profile) == 5


def test_current_outlier_does_not_inflate_own_baseline():
    rows = [{"split": "train", "athlete_id": "a", "capture_session_id": "s", "stream_id": "v", "continuity_id": "epoch1",
             "repetition_baseline_id": "subject1", "repetition_history_complete": True,
             "sequence_index": i, "runtime_execution_id": str(i), "timestamp_ms": i * 1000,
             "value": value, "unit": "deg", "athlete_context": "advanced"} for i, value in enumerate([1, 2, 3, 20])]
    profile = {"consistency": {"enabled": True, "window": 8, "min_reps": 3, "k_sd": 2, "fail_fraction": .5}}
    assert fit.predict(rows, {"kind": "max_value", "limit": 3}, profile) == ["PASS", "PASS", "PASS", "IMPROVE"]
    rows[-1]["value"] = 4
    assert fit.predict(rows, {"kind": "max_value", "limit": 3}, profile)[-1] == "UNCERTAIN"
    rows[-1]["continuity_id"] = "new-epoch"
    # Runtime keeps the athlete variance baseline across temporal gaps.
    assert fit.predict(rows, {"kind": "max_value", "limit": 3}, profile)[-1] == "UNCERTAIN"
    rows[-1]["repetition_baseline_id"] = "new-subject"
    rows[-1]["sequence_index"] = 0
    # No four-repetition group remains; fitting consistency is unsupported.
    assert not fit.continuity_supported(rows, profile["consistency"])
    assert fit.predict(rows, {"kind": "max_value", "limit": 3}, profile)[-1] == "IMPROVE"


def test_incomplete_prior_history_cannot_fit_or_evaluate_consistency():
    rows = [{"athlete_id": "a", "capture_session_id": "s", "stream_id": "v", "repetition_baseline_id": "b",
             "runtime_execution_id": str(i), "sequence_index": i, "repetition_history_complete": True,
             "timestamp_ms": i * 100, "value": 1, "unit": "deg", "athlete_context": "advanced"} for i in [0, 2, 3, 4]]
    config = {"enabled": True, "window": 8, "min_reps": 3, "k_sd": 2, "fail_fraction": .5}
    assert not fit.continuity_supported(rows, config)
    with pytest.raises(ValueError, match="ordered repetitions"):
        fit.predict(rows, {"kind": "max_value", "limit": 3}, {"consistency": config})


def test_reference_adapter_preserves_model_semantics_and_pins(tmp_path):
    pack = tmp_path / "pack"
    directory = pack / "models/reference"
    directory.mkdir(parents=True)
    model = directory / "reference.json"
    model.write_text(json.dumps({"threshold": 10, "tolerance": 3, "unit": "deg"}), encoding="utf-8")
    rubric = {"criteria": [{"criterion_id": "c", "evaluator": {"kind": "reference_nearest", "model_reference": "models/reference/reference.json"}}]}
    adapter = fit.load_effective_evaluators(pack, rubric)["c"]
    assert adapter["evaluator"]["kind"] == "max_value" and adapter["evaluator"]["limit"] == 10
    assert adapter["model_sha256"] == fit.digest(model)
    before = fit.reference_digest(pack)
    model.write_text(json.dumps({"threshold": 11, "tolerance": 3, "unit": "deg"}), encoding="utf-8")
    assert fit.reference_digest(pack) != before
    rubric["criteria"][0]["evaluator"]["model_reference"] = "../../outside.json"
    with pytest.raises(ValueError, match="pinned pack"):
        fit.load_effective_evaluators(pack, rubric)


def test_equipment_requires_explicit_comparator_and_unit(tmp_path):
    rubric = {"criteria": [{"criterion_id": "c", "evaluator": {"kind": "equipment_dependent", "limit": 5,
                                                                 "params": {"measurement_unit": "deg"}}}]}
    assert not fit.load_effective_evaluators(tmp_path, rubric)
    rubric["criteria"][0]["evaluator"]["params"]["comparison_kind"] = "max_value"
    assert fit.load_effective_evaluators(tmp_path, rubric)["c"]["unit"] == "deg"


def test_cli_readiness_writes_new_report_and_keeps_existing_file(tmp_path):
    from tools.fit_criterion_thresholds import main
    data = fixture()
    pack = tmp_path / "pack"
    pack.mkdir()
    (pack / "technique_criteria.json").write_text(json.dumps(data["rubric"]), encoding="utf-8")
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps(data["manifests"][0]), encoding="utf-8")
    output = tmp_path / "readiness.json"
    argv = ["--manifest", str(manifest), "--pack", str(pack), "--readiness", "--out", str(output)]
    assert main(argv) == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["input_files"][0]["sha256"] == fit.digest(manifest)
    assert report["reviewed_executions"] == 0 and report["proposals"] == []
    before = output.read_bytes()
    with pytest.raises(SystemExit):
        main(argv)
    assert output.read_bytes() == before


@pytest.mark.skipif(shutil.which("node") is None or not (ROOT / "node_modules/tsx").exists(), reason="TypeScript parity requires local node/tsx")
def test_numeric_port_matches_actual_typescript_runtime():
    cases = [("max_value", -2), ("max_value", 10), ("max_value", 12), ("min_value", 9),
             ("max_abs", -12), ("ordering", .5), ("range", 1), ("range", 3), ("stability", 12), ("phase_duration", 12)]
    data = [{"ev": {"kind": kind, "range": [2, 8], "limit": 10 if kind != "ordering" else 1, "tolerance": 2}, "value": value} for kind, value in cases]
    profile = {"relative": .05, "measurement_floor": {"deg": 5}, "context_scale": {"advanced": .8}}
    script = "import {scoreAgainst} from './packages/scoring/src/rules.ts'; import {varianceBand} from './packages/scoring/src/variance.ts';"
    script += "const data=" + json.dumps(data) + "; const profile=" + json.dumps(profile) + ";"
    script += "console.log(JSON.stringify(data.map(r=>({score:scoreAgainst(r.ev,r.value), band:varianceBand(r.ev,'deg','advanced',profile).band}))));"
    process = subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
    runtime = json.loads(process.stdout)
    for row, expected in zip(data, runtime):
        assert fit.score_against(row["ev"], row["value"]) == pytest.approx(expected["score"])
        assert fit.variance_band(row["ev"], "deg", "advanced", profile) == pytest.approx(expected["band"])
