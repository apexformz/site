# Squash Data Capture → Brain

The first sport engine learns static poses and dynamic movements from the original squash Data Capture collection in AWS account `350445709199`, region `ap-southeast-2`.

| Input | Source |
| --- | --- |
| Photos and videos | `s3://apexformz-datacapture-prod-350445709199-ap-southeast-2-media/raw/squash/` |
| Capture labels, catalog, retakes and athlete records | `s3://apexformz-datacapture-prod-350445709199-ap-southeast-2-labels/` |

The pipeline reads S3 and trains locally. It performs no AWS writes and creates no cloud training jobs. It uses only squash Data Capture media. Credentials stay in the AWS profile; they are never sent to the browser or embedded in models.

## Run

Use an authenticated AWS profile, a Python environment with `ml/requirements-training.txt`, and the full MediaPipe pose checkpoint. From the project root in PowerShell:

```powershell
./tools/train-squash.ps1 -Profile apexformz-owner -Workers 4 -Steps 1000 -Device auto
```

The script imports source media, verifies hashes, extracts poses, trains two models, evaluates available athlete holdouts, verifies ONNX equivalence, and installs local browser artifacts. `-PrepareOnly` downloads/prepares data and writes the training plan without training or replacing model files. Repeated runs verify and reuse media and pose caches. Existing AWS sessions can expire; refresh the named profile before rerunning if authentication fails.

The intended collection is landscape. Videos use `-OrientationPolicy encoded` because their container rotation metadata incorrectly turns decoded frames sideways. The full replay audit additionally found 71 front-view still images whose raw pixels themselves were stored sideways (1080 × 1920, EXIF orientation 0). All 71 were visually checked and corrected by explicit source-ID/SHA-bound 90° counterclockwise extraction overrides in `data/squash/orientation_overrides_v1.json`. No aspect-ratio auto-rotation is used. Original media remain untouched; transforms enter extraction provenance and cache identity. Future preparation must retain these overrides; inspect new collections before choosing their orientation policy.

For separate stages and training options, see [the importer](../ml/ingestion/README.md) and [the ML guide](../ml/README.md).

## What is learned

- Static photos train a one-frame posture classifier.
- Dynamic videos train a causal temporal classifier using pose windows.
- Front, back, left and right views retain their source labels and view metadata. Separate views are not assumed to be synchronized.
- Related athletes, sessions, captures and duplicate source media stay in the same partition. No random frame split is used to claim accuracy.
- Source movement IDs and human names remain distinct from reviewed coaching movement IDs.

The movement classifiers do not learn stroke phases, technique correctness, racket or ball tracking from movement-name labels alone. Those require additional supervision and evaluation.

Pose visibility is checked before training. The default run stops if a source label has no usable training observations. `-AllowPartialCoverage` explicitly trains a development model on the supported labels and records the excluded labels and reasons in its coverage report. Excluded labels are never relabeled as `UNKNOWN`.

## Browser behavior

The squash training page loads `/models/squash/index.json`, then verifies each ONNX model's SHA-256 digest. Training and live recognition use the same full MediaPipe checkpoint and the normalization/continuity declared in deployment metadata. The current models use `world_bodyframe_v1` with `tracker_root_v1`, retaining identity warnings and root-jump masking. Static-pose and dynamic-movement observations appear separately from the selected coaching drill.

Models remain provisional until validation supports release. Strict mode withholds provisional recognition. Development mode may show a raw top candidate as an **unvalidated suggestion**, including its model probability. This is not a technique score. Missing models leave the selected drill available with a clear status message.

## Historical first-run evidence and limitations

The first local run completed on 25 October 2026. It imported 642 eligible captures from Data Capture, excluding four superseded source objects. Extraction produced 616 pose captures; 26 photos had no unambiguous visible torso. The later orientation audit corrected 71 of those static streams; the first-run numbers below describe the original snapshot.

| First trained model | Source labels | Modeled labels | Training observations |
| --- | ---: | ---: | ---: |
| Static pose | 68 | 68 | 237 single-photo observations |
| Dynamic movement | 110 | 105 | 429 temporal windows |

Both models completed 1,000 optimization steps on the local RTX 5070 Laptop GPU. Their installed ONNX files passed checksum verification, PyTorch equivalence (maximum absolute logit difference below `0.000006`), and actual browser-runtime WASM inference through the production loader. Full evidence is in `ml/runs/squash/first-capture/training_summary.json` and its per-task run records.

Final verification passed: 87 ML/import/preparation Python tests, 270 TypeScript tests (one skipped), root typechecking, frontend typechecking and the production build. The local browser loaded both models and displayed their provisional status. Live camera-session and independent-athlete validation remain outstanding.

Five dynamic labels had no usable training windows in that first run: `squash.dynamic.0052` (Boast swing), `.0059` (Attacking shot movement), `.0079` (T → right side), `.0086` (Emergency reach), and `.0093` (Drop-shot movement). The later safe run below supersedes this coverage count. Original source names remain preserved in the historical reports.

This collection contains one athlete and no labeled unknown-movement examples. Consequently, neither held-out accuracy nor unknown-rejection performance is established. These installed models remain provisional; development mode exposes suggestions and strict mode withholds acceptance. Movement labels alone do not validate technique scores or stroke phases.

Private media, pose streams and inventories are under the ignored `data/squash/` directory. Each run writes configurations, checkpoint hashes, losses, sample counts, split evidence, available evaluation reports and export checks under `ml/runs/squash/`. Browser deployment metadata and model cards record the release blockers.

If no independent holdout exists, the pipeline reports that explicitly rather than substituting training accuracy. If no labeled unknown/other-movement examples exist, false-acceptance performance is unavailable and strict acceptance thresholds remain disabled. Capture metadata is preserved as collected; missing training-purpose, retention or expert-review fields are not invented.

## Review phases and technique outcomes

The current pack contains 184 movement definitions, 184 phase graphs and 848 provisional criteria. The capture manifests contain movement identity labels, but no reviewed phase boundaries or technique outcomes. Taxonomy/reference generation does not supply those independent labels.

Export review tasks from the existing verified squash manifests:

```powershell
.venv/Scripts/python.exe tools/squash_annotation_review.py export --manifest data/squash/dataset_static_pose.json --manifest data/squash/dataset_dynamic_movement.json --inventory data/squash/capture_inventory_display_v2.json --out data/squash/review-next-version
```

This creates `tasks.template.jsonl`, a `rubric.json` containing the relevant phase and criterion definitions, and a `bundle.json` that links each task to its local landscape media, immutable S3 source version, pose stream, capture boundaries and inherited split. It pins the source manifests and pack hashes. Export refuses to overwrite an existing review folder.

The current export is `review-identity-20261026`, with **625 review tasks** (266 static photos and 359 videos). All media and pose hashes were verified using the tool's `verify` command, without human labels. The earlier `review-landscape-final-20261025`, `review-current-20261025` and `review-20261025` folders preserve historical snapshots and are stale against the current identity-corrected manifests. No task is marked reviewed automatically. The export command above uses a fresh folder because existing review exports are immutable.

Copy the template to a separate file and have the reviewer fill it. Fields requiring independent judgement start empty: annotator identity, annotation version, execution boundaries, phase intervals and every criterion outcome. Handedness is copied from source metadata for confirmation, remaining unknown when no source value exists. For repeated executions in one recording, create a unique execution ID per repetition and retain the original `source_execution_id`. Photos have zero-duration execution boundaries and cannot provide temporal phase labels. UNKNOWN is reserved for a genuinely reviewed unknown movement; it is never inferred from a failed capture.

Validate a completed subset before using it for fitting:

```powershell
.venv/Scripts/python.exe tools/squash_annotation_review.py validate --bundle data/squash/review-identity-20261026/bundle.json --labels data/squash/reviewed.jsonl --out data/squash/reviewed-v1
```

Validation rejects pending reviews, unresolved disagreements, invalid criteria/phase IDs, overlapping execution intervals and source or split drift. Duplicate expert reviews stay in separate files for agreement analysis and adjudication. Validated output includes `labels.jsonl`, inherited `splits.json` and a provenance report; it does not alter the training manifests or approve the rubric.

For phase fitting, extract features using the deployed feature engine for each reviewed stream (`tools/extract_features.ts`, with its exact `--stream`, `--view` and reviewed `--handedness`), then run:

```powershell
.venv/Scripts/python.exe ml/sports/squash/fit_phase_thresholds.py --features data/squash/features.jsonl --labels data/squash/reviewed-v1/labels.jsonl --split data/squash/reviewed-v1/splits.json --out data/squash/reviewed-v1/proposals
```

The fitter uses only explicit training assignments, bounds feature windows by annotated phases, weights executions equally and requires at least three supported annotated executions. It writes proposals with training-fit statistics, never held-out accuracy or coach approval. Current capture-name labels produce zero phase fits. Criterion cutoffs and human-variation tolerances still require reviewed PASS/IMPROVE repetitions and independent evaluation; these tools do not invent those results.

## Development correctness review, 25 October

The follow-up review repaired saved-drill alias resolution, camera pause/resume and stale inference handling, feedback/assessment freshness, and strict-mode taxonomy gates. Reference extraction now filters capture quality; scoring enforces matching reference views, source handedness, angular units and usable evidence coverage. Personal-variation comparisons exclude the current execution, retain measurement floors, and reset when the tracked athlete changes.

The phase-proxy exploration tool (`tools/calibrate_phase_graphs.ts`) now retains original pose-quality and identity flags, uses training assignments only, and emits unreviewed proposals on the source clock. Its completion/reached-phase metrics are training proxies, not phase-boundary accuracy. The independent reviewed-annotation fitter is the path for actual phase-threshold proposals.

Verification after these changes: **334 TypeScript tests passed, one skipped; 43 focused Python annotation/phase tests passed; TypeScript checks, all six pack validations and the frontend production build passed.** Source manifest and pack hashes in `review-current-20261025/bundle.json` matched at verification. The local preview was restarted on port 3002.

Concurrent cross-view experiments are exploratory within one athlete; some recipes change visibility/identity assumptions and supported examples, and taxonomy was built before the holdout. Their results do not establish independent-athlete accuracy or approve confidence gates. Genuine phase labels, criterion outcomes, independent athletes/unknown movements, reviewed cutoffs and fitted variation allowances remain necessary.

## Historical safe-continuity models, 25 October

The earlier static model is recorded in `ml/runs/squash/safe-tracker-root-orientation-v1-4k-rh-20261025/training_summary.json`; its dynamic counterpart is recorded in `ml/runs/squash/safe-tracker-root-4k-rh-20261025/training_summary.json`. Both completed 4,000 local GPU steps using the same identity policy as live recognition. Their coverage was 68 labels / 257 observations and 107 labels / 529 windows. Boast swing, T → right side and Drop-shot movement lacked qualifying windows in that snapshot. These models are preserved in the run/snapshot directories; the later identity run below supersedes them.

| Task | Installed ONNX SHA-256 | Maximum export logit difference |
| --- | --- | ---: |
| Static | `7147d8a034b7cb854ddd5ea18c1157a352c70cf51cac4b9fd019d95e83a7d143` | 0.00000477 |
| Dynamic | `3bd8265d334d21dab814cb5429c863e0d42640cf02397d56546901a42b79c0d8` | 0.0000153 |

Static weights were retrained after correcting 71 front-view image orientations; all 257 static frames are now landscape. The refreshed 66 reference models use 241 captures, with 16 quality exclusions retained. The dynamic dataset/model did not change during this orientation correction. Both deployments explicitly declare `tracker_root_v1` and remain provisional, with no validation/test or UNKNOWN examples. Strict mode continues to withhold recognition.

Display names use the pinned Data Capture catalog by exact movement ID. The derived inventory `data/squash/capture_inventory_display_v2.json` repairs damaged names without altering source media or existing manifest hashes. For the completed local tools, recorded regression and deferred evidence, see [current engineering status](09_SQUASH_REMAINING_WORK.md).

## Current installed identity models, verified 26 October

The static TCN (`tcn-1792952301195117500`) trained for 4,000 steps on 265 windows covering 68 known labels. Its SHA-256 is `dca7452c903630713451239ceb2b6a91d80e5476cfc9215fc498002fbe5c8ed2`. The dynamic ensemble combines the TCN (`tcn-1792951658562396800`, 18,000 steps) and ST-GCN++ (`stgcnpp-1792954148483621100`, 30,000 steps) with equal probability weights. Both used 768 windows covering 109 known labels; the ensemble SHA-256 is `0d7e361ce8e9d901ea92509a78c62f3af3e0515a789a23bb578bcf52e7b1d2c6`. Both deployments also contain an UNKNOWN output with no training examples.

Run evidence lives under `ml/runs/squash/static_identity_20261025/` and `ml/runs/squash/ensemble_identity_20261025/`. Current source manifests contain 266 photos and 359 videos. Drop-shot movement remains excluded for lack of usable windows. All thresholds and release gates stay provisional. The ensemble card now contains verified member lineage, dataset and split hashes.

`npm run test:models` checks pinned installed bytes against deterministic CPU PyTorch outputs and re-ID pixel parity. Offline bundle restoration and the model-free checkout suite are documented in `tests/models/README.md`. Train-only contrastive pretraining and verified encoder initialization are now implemented; their two-step real-data smoke is engineering evidence only and did not change these deployed weights (`ml/training/PRETRAINING.md`).
