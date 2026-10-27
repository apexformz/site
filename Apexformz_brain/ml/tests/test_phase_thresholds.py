"""Phase proposals need real temporal annotations, split lineage and execution support."""
import copy
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest

spec = importlib.util.spec_from_file_location("squash_phase_fit", Path(__file__).resolve().parents[1] / "sports/squash/fit_phase_thresholds.py")
phase_fit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phase_fit)


def examples(count=3):
    # A branch means the preceding annotated phase differs from graph list order.
    graph = {"id": "pg", "movement_id": "squash.dynamic.test",
             "phases": [{"id": "ready", "enter": []}, {"id": "alternative", "enter": []},
                        {"id": "contact", "enter": [{"feature": "speed", "op": "gt", "value": 1}]},
                        {"id": "recovery", "enter": []}],
             "edges": [{"from": "ready", "to": "contact"}, {"from": "contact", "to": "recovery"}]}
    labels, features, assignments = [], [], {}
    for i in range(count):
        eid = f"e{i}"
        labels.append({"execution_id": eid, "source_execution_id": f"source{i}", "stream_id": eid,
                       "movement_id": "squash.dynamic.test", "start_ms": 0, "end_ms": 900, "review_status": "reviewed",
                       "phases": [{"phase_id": "ready", "start_ms": 0, "end_ms": 500},
                                  {"phase_id": "contact", "start_ms": 500, "end_ms": 540},
                                  {"phase_id": "recovery", "start_ms": 540, "end_ms": 900}]})
        assignments[eid] = "train"
        for ts in [0, 100, 200, 300, 500, 510, 520, 530, 540, 550]:
            features.append({"stream_id": eid, "timestamp_ms": ts,
                             "features": {"speed": 0 if ts < 500 else 2 if ts < 540 else -100}})
    return [graph], labels, features, assignments


@pytest.mark.parametrize("op,expected", [("lt", [False, False]), ("lte", [True, False]),
                                         ("gt", [False, True]), ("gte", [True, True]),
                                         ("abs_lte", [True, False]), ("abs_gt", [False, True])])
def test_threshold_comparison_matches_runtime_equality(op, expected):
    assert phase_fit.compare(np.array([2., 3.]), 2., op).tolist() == expected


def test_explicit_splits_required_and_unknown_assignments_rejected():
    with pytest.raises(ValueError, match="explicit train"):
        phase_fit.resolve_assignments(None, None, [])
    with pytest.raises(ValueError, match="must be train"):
        phase_fit.resolve_assignments({"assignments": {"e": "random"}}, None, [])
    graphs, labels, features, assignments = examples()
    del assignments["e0"]
    with pytest.raises(ValueError, match="no split assignment"):
        phase_fit.fit_proposals(graphs, features, labels, assignments)


def test_positive_window_is_clipped_and_actual_annotated_predecessor_used():
    graphs, labels, features, assignments = examples(4)
    assignments["e3"] = "test"
    report = phase_fit.fit_proposals(graphs, features, labels, assignments)
    proposal = report["proposals"][0]
    assert proposal["n_executions"] == proposal["n_source_executions"] == 3
    assert proposal["n_positive"] == proposal["n_negative"] == 12
    assert proposal["balanced_accuracy"] == 1
    assert proposal["status"] == "proposal_requires_coach_review"
    assert report["skipped_annotations"] == {"non_train_execution": 1}
    assert proposal["score_split"] == "train" and not report["production_eligible"]


def test_many_frames_from_one_execution_cannot_produce_fit_and_json_has_no_nan():
    graphs, labels, features, assignments = examples(1)
    report = phase_fit.fit_proposals(graphs, features, labels, assignments, min_samples=1)
    assert report["proposals"][0]["proposed_value"] is None
    assert report["proposals"][0]["balanced_accuracy"] is None
    json.dumps(report, allow_nan=False)
    assert phase_fit.best_threshold(np.array([]), np.array([]), "lt") == (None, None)


def test_execution_weighting_does_not_let_long_clip_dominate():
    pos = np.array([2.] * 100 + [0., 0.])
    groups = ["long"] * 100 + ["short1", "short2"]
    neg = np.ones(3)
    threshold, score = phase_fit.best_threshold(pos, neg, "gt", positive_groups=groups,
                                               negative_groups=["long", "short1", "short2"], min_samples=1)
    # 100 identical positive frames still contribute only one of three execution votes.
    assert score == pytest.approx(2 / 3)
    assert threshold >= 1


@pytest.mark.parametrize("change", ["overlap", "outside", "nonfinite", "phase", "transition"])
def test_invalid_phase_boundaries_and_graph_references_fail(change):
    graphs, labels, features, assignments = examples()
    phase = labels[0]["phases"][1]
    if change == "overlap": phase["start_ms"] = 499
    if change == "outside": phase["end_ms"] = 1000
    if change == "nonfinite": phase["start_ms"] = float("nan")
    if change == "phase": phase["phase_id"] = "invented"
    if change == "transition": labels[0]["phases"][0]["phase_id"] = "alternative"
    with pytest.raises(ValueError):
        phase_fit.fit_proposals(graphs, features, labels, assignments)


def test_nested_manifest_annotations_and_source_subexecution_bounds():
    graphs, labels, features, assignments = examples()
    manifest = {"executions": [{"execution_id": row["source_execution_id"], "movement_id": row["movement_id"],
                               "view_stream_ids": [row["stream_id"]], "start_ms": 0, "end_ms": 1000} for row in labels],
                "splits": {"assignments": {row["source_execution_id"]: "train" for row in labels}}}
    nested = [{"execution_id": row["execution_id"], "source_execution_id": row["source_execution_id"],
               "review_status": "reviewed", "labels": {k: v for k, v in row.items() if k in {"movement_id", "phases", "start_ms", "end_ms"}}}
              for row in labels]
    report = phase_fit.fit_proposals(graphs, features, nested, assignments, manifest=manifest)
    assert report["proposals"][0]["balanced_accuracy"] == 1
    # Capture labels lacking temporal annotations never become inferred phases.
    manifest["annotations"] = copy.deepcopy(nested)
    # Nested manifest annotations in this fixture refer to reviewed subexecutions.
    manifest["splits"]["assignments"].update(assignments)
    for row in manifest["annotations"]:
        del row["labels"]["phases"]
    report = phase_fit.fit_proposals(graphs, [], manifest, assignments)
    assert report["skipped_annotations"] == {"no_phase_annotations": 3}
    assert report["proposals"][0]["proposed_value"] is None
    assert len(report["review_needs"]) == 3


def test_bad_quality_and_nonfinite_feature_samples_do_not_count():
    graphs, labels, features, assignments = examples()
    for row in features:
        if row["timestamp_ms"] == 500: row["quality_ok"] = False
        if row["timestamp_ms"] == 510: row["features"]["speed"] = float("nan")
    report = phase_fit.fit_proposals(graphs, features, labels, assignments)
    assert report["proposals"][0]["n_positive"] == 6
    assert report["proposals"][0]["status"] == "insufficient_data"


@pytest.mark.parametrize("status", ["pending", "unreviewed", None])
def test_unreviewed_phase_annotations_cannot_fit(status):
    graphs, labels, features, assignments = examples()
    labels[0]["review_status"] = status
    with pytest.raises(ValueError, match="require review_status reviewed"):
        phase_fit.fit_proposals(graphs, features, labels, assignments)


def test_disputed_phase_annotations_cannot_fit():
    graphs, labels, features, assignments = examples()
    labels[0]["disagreement"] = {"phase": "contact"}
    with pytest.raises(ValueError, match="unresolved annotation disagreement"):
        phase_fit.fit_proposals(graphs, features, labels, assignments)


def test_source_manifest_split_cannot_be_overridden_and_reviewed_identity_can_be_corrected():
    graphs, labels, features, assignments = examples()
    manifest = {"executions": [{"execution_id": row["source_execution_id"], "movement_id": "squash.original-label",
                               "view_stream_ids": [row["stream_id"]], "start_ms": 0, "end_ms": 1000} for row in labels],
                "splits": {"assignments": {row["source_execution_id"]: "train" for row in labels}}}
    report = phase_fit.fit_proposals(graphs, features, labels, assignments, manifest=manifest)
    assert report["source_identity_corrections"] == 3 and report["fitted_conditions"] == 1
    manifest["splits"]["assignments"]["source0"] = "test"
    with pytest.raises(ValueError, match="split differs from source manifest"):
        phase_fit.fit_proposals(graphs, features, labels, assignments, manifest=manifest)
    manifest["executions"].pop(0)
    with pytest.raises(ValueError, match="source execution not found"):
        phase_fit.fit_proposals(graphs, features, labels, assignments, manifest=manifest)


def test_review_bundle_flat_output_interoperates_and_inherits_holdout():
    review_spec = importlib.util.spec_from_file_location("phase_review_interop", Path(__file__).resolve().parents[2] / "tools/squash_annotation_review.py")
    review = importlib.util.module_from_spec(review_spec)
    review_spec.loader.exec_module(review)
    graphs, labels, features, _ = examples(4)
    rubric = {"movements": [{"id": "squash.dynamic.test", "type": "dynamic", "criteria": []}], "graphs": graphs}
    bundle = {"sources": {}}
    for i, row in enumerate(labels):
        row.update(static=False, annotator_id="coach-fixture", annotation_version=1, disagreement=None,
                   view="back", handedness="unknown", criteria={})
        bundle["sources"][row["source_execution_id"]] = {
            "static": False, "start_ms": 0, "end_ms": 900, "split": "test" if i == 3 else "train",
            "athlete_id": f"athlete-{i}", "capture_session_id": f"session-{i}",
            "streams": {row["stream_id"]: {"view": "back", "source_sha256": f"source-hash-{i}"}}}
    reviewed, splits = review.validate_reviews(bundle, rubric, labels)
    report = phase_fit.fit_proposals(graphs, features, reviewed, splits["assignments"])
    assert splits["assignments"]["e3"] == "test"
    assert report["skipped_annotations"] == {"non_train_execution": 1}
    assert report["fitted_conditions"] == 1 and report["proposals"][0]["n_executions"] == 3


def test_single_photo_review_needs_do_not_request_invented_phase_timing():
    graph = {"id": "static", "movement_id": "squash.static.test", "edges": [],
             "phases": [{"id": "hold", "enter": [{"feature": "speed", "op": "lt", "value": .01}]}]}
    doc = {"executions": [{"execution_id": "photo", "movement_id": "squash.static.test", "static": True,
                           "start_ms": 0, "end_ms": 0, "view_stream_ids": ["front"]}],
           "annotations": [{"execution_id": "photo", "labels": {"movement_id": "squash.static.test"}}],
           "splits": {"assignments": {"photo": "train"}}}
    report = phase_fit.fit_proposals([graph], [], doc, {"photo": "train"})
    assert report["skipped_annotations"] == {"single_frame_no_temporal_support": 1}
    assert "single photograph cannot" in report["review_needs"][0]["reason"]
    assert report["proposals"][0]["status"] == "no_incoming_transition_requires_background_negatives"
