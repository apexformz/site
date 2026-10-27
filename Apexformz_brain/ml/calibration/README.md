# Reviewed criterion and human-variance calibration

`tools/fit_criterion_thresholds.py` creates **unapproved proposals**, with fixed validation/test evaluations when matching reviewed evidence exists. It never changes a sport pack, approves a coach label, trains recognition, or fits phase boundaries. Phase fitting remains in `ml/sports/squash/fit_phase_thresholds.py`.

The current squash captures contain movement identity labels from one athlete. Those labels do not establish PASS/IMPROVE technique outcomes or repeatability floors. A readiness report is useful before those additional annotations exist:

```powershell
.\.venv\Scripts\python.exe tools/fit_criterion_thresholds.py `
  --manifest data/squash/dataset_static_pose.json `
  --manifest data/squash/dataset_dynamic_movement.json `
  --readiness --out data/squash/criterion-readiness-new.json
```

Choose a new output path for every run. Existing reports are never overwritten. Readiness validates the available source lineage and reports missing inputs; it never selects proposals. It returns exit code 0 even when evidence is missing. A fitting run with no supported proposal returns 2 after writing its report.

## Required evidence

1. **Immutable squash Data Capture manifests**, with explicit source execution splits and encoded landscape pose extraction. Known athletes, capture sessions, source hashes and split groups cannot cross train/validation/test. Unknown identity stays unknown. Do not randomly split recordings from the same athlete to create held-out results.
2. **Independent reviewed labels**, produced by `tools/squash_annotation_review.py validate`: `execution_id`, `source_execution_id`, `stream_id`, `movement_id`, `start_ms`, `end_ms`, `view`, `handedness`, `athlete_id`, `capture_session_id`, `source_sha256`, `review_status: "reviewed"`, real `annotator_id`, positive `annotation_version`, `disagreement: null`, and `criteria: {criterion_id: "PASS" | "IMPROVE" | "UNCERTAIN" | "NOT_ASSESSABLE"}`. Only PASS/IMPROVE are fit targets. The explicit `--split` assignments must include every reviewed execution and inherit its capture split.
3. **Final aggregate runtime measurements**, from the recorded Brain replay. Each JSONL row supplies the source execution and stream, `criterion_id`, `timestamp_ms`, `measurement: {value, unit, feature_id, reason}`, `evidence.view`, athlete/session/handedness/context, source SHA256 and `pipeline_provenance`. The provenance pins are `sport_pack_sha256`, `rubric_sha256`, `runtime_sha256`, `pose_pipeline_sha256`, `reference_models_sha256`. All rows must use the same pins; CLI checks the pack, rubric and reference models against the current files. Runtime/pose hashes bind the export rather than asserting that its pipeline was validated.
4. **Independent repeatability evidence**, described below. Measurement floors are never estimated from coach mistakes, the current rubric's errors, or variation between an athlete's different executions.
5. **An explicit search configuration**, including candidate grids and the relative costs of false corrections, false acceptances and abstentions. These are experiment settings, not normative coaching cutoffs.

Reviewed subdivisions join on source execution + stream + measurement interval. Export `measurement_start_ms`/`measurement_end_ms` for the full aggregate support. A crossing aggregate is excluded. Without that span, only a source-wide review can be joined. Multiple runtime aggregates assigned to one reviewed repetition are an error: review the separate repetitions instead of counting frames as repetitions. Quality abstentions are excluded, except numeric `RUBRIC_UNVALIDATED` and `WITHIN_NORMAL_VARIANCE` measurements, which can be measured safely without being approved outcomes.

To search longitudinal consistency, rows also need `runtime_execution_id`, `repetition_baseline_id`, `repetition_history_complete: true` and integer `sequence_index`. The baseline ID must follow actual runtime variance resets (session start or tracked-subject changes), not temporal `continuity_id`: the runtime retains the same athlete's variance history across a time gap. Sequences must be chronological, unique and complete, with consecutive indices starting at zero for that baseline; the exporter must attest that the latest judged measurement of every repetition is retained, including values followed by later quality abstentions. Every retained repetition also needs a reviewed PASS/IMPROVE outcome in the same scope. Missing histories, skipped reviews, or ordinary replay exports without this completeness evidence disable consistency candidates. Threshold/band fitting remains available. There must be enough prior repetitions for at least two training athletes. Camera/recording/subject/split boundaries never pool history. Held-out sequences begin with empty history; no training baseline is reused.

## Repeatability evidence contract

The `--measurement-floors` JSON contains:

| Field | Meaning |
| --- | --- |
| `method` | Exactly `paired_absolute_difference_quantile` |
| `quantile` | Explicit value strictly between 0 and 1 chosen in the repeatability protocol |
| `protocol_id` | Identifier of the actual measurement repeatability protocol |
| `review_status`, `reviewer_id` | `reviewed` and the actual reviewer; this does not approve a sport rubric |
| `pipeline_provenance` | The same five SHA256 pins as the runtime measurement export |
| `pairs` | Actual paired measurements of the **same reference observation**, not two athlete repetitions |

Each pair has unique `pair_id`, `source_execution_id`, the original `source_sha256`, `unit`, `measurement_a`, and `measurement_b`. Every source must be in train. At least three pairs from three independent source executions are required per unit. The floor proposal is the linearly interpolated declared quantile of absolute paired differences. The report records its sample count and method; small samples do not establish a validated device precision estimate. The fitter cannot verify that a human performed the protocol, so retain its original records and review them before applying a proposal.

## Search and run

An example **experiment grid** (choose and record the costs for your review protocol):

```json
{
  "relative_candidates": [0, 0.025, 0.05, 0.1],
  "context_scale_candidates": [0.8, 1, 1.2],
  "consistency_candidates": [
    {"enabled": false},
    {"enabled": true, "window": 8, "min_reps": 3, "k_sd": 2, "fail_fraction": 0.5}
  ],
  "costs": {"false_acceptance": 2, "false_correction": 1, "abstention": 0.25},
  "min_train_per_outcome": 3,
  "min_train_athletes": 2,
  "min_coverage": 0.6,
  "max_threshold_candidates": 33
}
```

```powershell
.\.venv\Scripts\python.exe tools/fit_criterion_thresholds.py `
  --manifest path/to/pinned-static-manifest.json `
  --manifest path/to/pinned-dynamic-manifest.json `
  --pack sport-packs/squash `
  --labels path/to/validated/labels.jsonl `
  --split path/to/validated/splits.json `
  --measurements path/to/replay/measurements.jsonl `
  --measurement-floors path/to/reviewed-repeatability.json `
  --search path/to/experiment-search.json `
  --out path/to/new-proposals.json
```

Selection uses **train only**. Each scope is one criterion, measurement unit, camera view, athlete context, handedness and selected feature. It needs at least three independent reviewed repetitions of each outcome and at least two known training athletes represented in each outcome. Known and unknown contexts are separate. Candidate thresholds use training values and interval quartiles, downsampled to the declared bound; the existing threshold is also considered. Ranges search pairs of these points. This is a bounded grid, not a claim of a global continuous optimum.

Loss gives PASS/IMPROVE equal weight, then athletes equal weight within each outcome. The explicit abstention cost and minimum coverage prevent an all-UNCERTAIN solution. Ties prefer greater coverage and simpler variance settings. Validation and test values/labels never choose thresholds, bands, search ranges, measurement floors, or repetition parameters. Repeatedly using their results to alter the experiment would consume that holdout; reserve a new independent final evaluation.

## Runtime semantics and interpretation

The Python numerical layer mirrors `packages/scoring/src/rules.ts` and `variance.ts`; a test executes those TypeScript functions and checks parity. Crisp rule equality, range span, absolute limits, score decay, context scaling, the unscaled measurement floor, and the tolerance lower bound are retained. Without a declared relative allowance or floor, the band is inert. The current repetition is recorded and the window trimmed before its own value is excluded from the prior mean/SD; an outlier cannot inflate its own baseline.

Supported scalar comparators are range, max_abs, min_value, max_value, ordering, stability and phase_duration. A phase-duration proposal changes only its technique limit, not phase segmentation. A pinned `reference_nearest` model is evaluated as the runtime's max-value distance comparator; its proposal says to update that model's threshold rather than replace the criterion kind. `equipment_dependent` is supported only when its explicit `params.comparison_kind` supplies a scalar comparator and the replay supplies real measurements in the declared unit. Missing adapters are reported as blocked scopes, with no invented contact/equipment data.

Outputs contain scoped evaluator/variance proposals, measured-floor evidence, input SHA256 pins, train support/loss/coverage, and fixed held-out confusion matrices, false-correction/false-acceptance rates and strata. Relative allowance and context scale can be non-identifiable from the same effective band; proposals are scoped, not pooled global profiles. Every proposal remains `production_eligible: false`. Applying it still needs coach/measurement review and adequate independent validation. The tool neither changes approval fields nor publishes a pack.

Run the focused tests with:

```powershell
.\.venv\Scripts\python.exe -m pytest ml/tests/test_criterion_fit.py -q
```
