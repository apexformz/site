# Squash training-readiness kit

Written for: the data team receiving the coaches' static and dynamic squash recordings.

This folder holds everything sport-specific the ML pipeline needs for squash. The pipeline itself (`ml/datasets`, `ml/training`, `ml/evaluation`, `ml/export`) stays sport-agnostic; only files here name squash.

| File | Purpose |
|---|---|
| `label_schema.json` | All 184 movement ids with their family and group, phase ids and criterion ids, copied from the sealed pack so annotators and the trainer use identical names. Regenerate with `python ml/sports/squash/sync_from_pack.py`. |
| `dataset_manifest.template.json` | A filled-in example of `ml/datasets/dataset_manifest.schema.json` for a squash capture (pseudonymous athletes, back + side cameras, executions grouped by view). |
| `capture_checklist.md` | On-court checklist for the capture team (court, cameras, drills, consent). |
| `train_config.tcn.json`, `train_config.stgcnpp.json` | Example configs for future execution-labelled datasets; their paths are placeholders, and augmentation settings need task-specific review. For current Data Capture training use `tools/train_squash_models.py`, which derives supported classes from verified capture labels and disables mirroring. |
| `build_taxonomy.py`, `pose_similarity.py`, `taxonomy_names.json` | Measure movement similarity on the recordings and build the family -> group -> movement hierarchy (`docs/08_SQUASH_TAXONOMY.md`). Outputs `taxonomy.json` and `similarity_report.json`. |
| `source_catalog.json` | The labeled squash movement catalog copied from the Data Capture labels bucket, with its checksum. |
| `reference_feature_specs.json`, `reference_vectors.json` | Feature specs and expert reference joint angles for the static positions (derived angles only; no media). |
| `fit_phase_thresholds.py` | Fits the provisional phase-graph thresholds from labelled executions and writes a proposal next to the pack for coach review. |
| `sync_from_pack.py` | Regenerates `label_schema.json` and the class lists in the train configs from `sport-packs/squash`. |

## Workflow

The existing Data Capture dataset already has trained static and dynamic models. Use the documented commands and evidence in `docs/07_SQUASH_TRAINING.md` for that pipeline. The workflow below is for future coach-reviewed execution annotations; the template paths are not the current installed training run.

```
coach recordings (mp4) + annotation sheets
  -> python tools/extract_real_sequences.py ...                   PoseFrame JSONL per view stream
  -> fill dataset_manifest.json (template here) + labels.jsonl   (annotation_handbook.md)
  -> python -m ml.datasets.split --manifest ... --out splits.json   athlete-disjoint, execution-grouped
  -> python ml/training/train.py --config ml/sports/squash/train_config.tcn.json
  -> python ml/training/train.py --config ml/sports/squash/train_config.stgcnpp.json
  -> python -m ml.evaluation.evaluate ...                        macro-F1, unknown FA, boundary MAE, per view
  -> python ml/sports/squash/fit_phase_thresholds.py --features ... --labels ... --split ... --out proposals/
  -> coach panel review -> edit sport-packs/squash/*.json -> npm run seal:packs -> npm run validate:packs
```

## Labels file format

One JSON object per line, one line per labelled execution (see `ml/datasets/jsonl_dataset.py::load_labels`):

```json
{"stream_id": "cap-0001/back", "execution_id": "ex-0001", "movement_id": "squash.lunge", "start_ms": 1200, "end_ms": 3100,
 "phases": [{"phase_id": "ready", "start_ms": 1200, "end_ms": 1700}, {"phase_id": "drive", "start_ms": 1700, "end_ms": 2000},
            {"phase_id": "bottom", "start_ms": 2000, "end_ms": 2400}, {"phase_id": "recovery", "start_ms": 2400, "end_ms": 3100}],
 "static": false, "view": "back", "handedness": "right",
 "criteria": {"squash.lunge.lead_knee_depth": "PASS", "squash.lunge.knee_foot_alignment": "NOT_ASSESSABLE"},
 "visibility": "full", "capture_quality": "good", "corner": "front_left", "annotator_id": "ann-02", "disagreement": null}
```

Executions that match no catalog movement are labelled `"movement_id": "UNKNOWN"` and kept as hard negatives.

## What is not here yet

- Real Data Capture recordings and two trained provisional squash models exist. Independent-athlete validation, reviewed phase boundaries, technique-error labels and calibrated coaching thresholds remain outstanding.
- `tools/squash_annotation_review.py` exports capture-linked review tasks and validates completed annotations before producing phase-fitting labels and inherited splits; see `docs/07_SQUASH_TRAINING.md`.
- Racket tracking still needs both labelled observations and an integrated measurement pathway before equipment-dependent criteria can be assessed.
