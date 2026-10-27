# ApexFormz ML (TRD 10, 12; WP09)

```
INGEST -> VALIDATE -> LABEL REVIEW -> SPLIT -> EXTRACT POSE
-> FEATURES -> (SELF-SUPERVISED PRETRAIN) -> BASELINE TRAIN -> HYPERPARAM SEARCH
-> CALIBRATE (temperature + open-set thresholds) -> EVALUATE -> EDGE BENCHMARK -> EXPORT
-> SIGN + STAGE -> CANARY -> RELEASE / ROLLBACK
```

| Stage | Where |
|---|---|
| Dataset manifest (entities, consent, immutable URIs + sha256) | `datasets/dataset_manifest.schema.json` |
| Annotation rubric and adjudication | `datasets/annotation_handbook.md` |
| Athlete-disjoint, execution-grouped splits | `datasets/split.py` |
| PoseFrame JSONL dataset (contract-validated, edge-identical normalisation and resampling, windows, UNKNOWN labels) | `datasets/jsonl_dataset.py` |
| Skeleton graphs (MediaPipe 33, COCO 17; 3-subset partition) | `training/graph.py` |
| Recognizer models (see table) | `training/tcn.py`, `training/stgcn.py`, `training/agcn.py` |
| Training skeleton (`--model tcn|stgcnpp`) + experiment record | `training/train.py` |
| Self-supervised pretraining (SimCLR / NT-Xent on augmented views) | `training/pretrain_contrastive.py` |
| Constrained augmentation (shared by all models) | `training/augment.py` |
| Metrics (macro-F1, confusion, unknown FA, boundary MAE, ECE, per-view) | `evaluation/metrics.py`, `evaluation/evaluate.py` |
| Temperature scaling + per-movement open-set thresholds | `evaluation/open_set.py` |
| ONNX export (dynamic T), float/int8 equivalence, model card | `export/export_onnx.py`, `export/model_card_template.md` |

## Model family

| Model | File | Role | Causal | Params (3 classes, 33 landmarks) | Origin |
|---|---|---|---|---|---|
| Causal TCN | `training/tcn.py` | baseline, cheapest online recognizer | always | ~0.17M (64,64,128) | ApexFormz |
| ST-GCN++ | `training/stgcn.py` | challenger: spatial graph conv (adaptive 3-subset adjacency) + multi-scale temporal conv, 10 blocks 64x4/128x3/256x3, stride 2 at blocks 5 and 8 | `causal=True` (default): all temporal ops left-padded; `causal=False` for offline | ~1.4M | re-implemented after PYSKL (Apache-2.0), no mmcv |
| Adaptive GCN block | `training/agcn.py` | 2s-AGCN-style data-dependent adjacency for offline analysis | no | — | after Shi et al. 2019 / PYSKL AAGCN |
| Contrastive pretraining | `training/pretrain_contrastive.py` | sport-agnostic representation learning from unlabelled captures before any sport labels exist | n/a | encoder = TCN or ST-GCN++ | SimCLR objective |

Both recognizers consume the same tensor contract and produce the same output layout, so the edge runtime can swap them without code changes.

## Tensor contract

Shared with the edge runtime (`packages/analysis/src/recognizer.ts::seriesToTensor`):

```
input : [B, T, V*3]   body-relative x,y,z per landmark, zeros where masked
mask  : [B, T, V]     1 observed, 0 padded/dropped/invalid
logits: [B, T, C]     per-frame logits; class C-1 is the explicit UNKNOWN class
```

V = 33 (`mediapipe_pose_33`) or 17 (`coco_17`); the mask is appended as a 4th input channel inside the models. Causal models decide on the last frame; non-causal models average over time. ST-GCN++ runs at a temporal stride of 4 internally and upsamples by repetition, so output frame t depends only on frames ≤ t in causal mode (asserted by `tests/test_stgcn.py`). Train and deploy share the same causal sampling; `datasets/jsonl_dataset.py` reproduces the runtime's mirror canonicalisation, hip-root/torso-scale normalisation and hold-last-sample resampling with masks.

## Open-set thresholds and the sport pack

1. Train (`train.py`) on the athlete-disjoint `train` split; evaluate logits on `val`.
2. `evaluation/open_set.py` fits a temperature and chooses one threshold per movement at a target unknown false-acceptance rate; it reports ECE before/after and the known-rejection rate. There is no universal cutoff (TRD 10).
3. The thresholds JSON `{movement_id: threshold}` ships inside the sport pack next to the exported ONNX model as a `models[]` entry with `role: movement_classifier`; the edge `decideOpenSet` applies them with an ambiguity margin. Thresholds are only valid for the exact model version they were fitted on.
4. Export (`export/export_onnx.py --model stgcnpp`) writes the float ONNX, an int8 variant (release-eligible only after device gates) and `*.model_card.json` with dataset hash, metrics and licence placeholders marked `TODO_REQUIRES_VALIDATION`.

A learned recognizer never bypasses the user's explicit sport selection: it only ranks movements within the pinned sport pack and may answer UNKNOWN (TRD 05).

## Commands

```bash
python ml/datasets/split.py dataset_manifest.json split.json --seed 20261025 --holdout-location gym_b
python ml/training/train.py --dry-run --model tcn      --out-dir ml/runs
python ml/training/train.py --dry-run --model stgcnpp  --out-dir ml/runs
python ml/training/pretrain_contrastive.py --dry-run --model stgcnpp --out-dir ml/runs
python ml/evaluation/open_set.py val_logits.npz --classes a b UNKNOWN --target-far 0.05 --out ml/runs/open_set_thresholds.json
python ml/evaluation/evaluate.py --synthetic --out ml/runs/eval.json
python ml/export/export_onnx.py --model stgcnpp --out ml/runs/stgcnpp.onnx
python -m pytest ml/tests -q
```

The legacy `apps/ai-service/app/services/aqa/st_gcn.py` is not trained on the Brain tensor contract and is not a release candidate. All numeric gates in the model card are `TODO_REQUIRES_VALIDATION` until set by the evaluation protocol with expert agreement data.

## Real capture training and evaluation

The capture manifest is the source of truth. Keep its original `movement_id` labels;
do not silently map capture names onto sport-pack movements. Each `view_streams[]`
entry adds `pose_path` (relative to the manifest) and optional `pose_sha256` for its
extracted PoseFrame JSONL. `_header` metadata lines are supported. Execution
`start_ms`/`end_ms` bounds are applied before windowing, and all views retain the
execution's split. The loader accepts embedded `splits.assignments` or a separate
split manifest, rejects known athlete/session/stream leakage, and records unknown
athlete identity as unverified. `allow_development_split=true` is an explicit
experimental override, never evidence of athlete-disjoint performance.

Explicit label files accept `stream_id`, `view_stream_id` or legacy `sequence_id`,
with `execution_id`, `movement_id`, `start_ms` and `end_ms`. Without a labels file,
execution labels supply movement supervision. Unsupported labels fail instead of
being relabelled UNKNOWN. Legacy `sequences[]` manifests are still supported.

Train separate configurations for photographs (`model_task: static_pose`,
`window_frames: 1`) and video (`model_task: dynamic_movement`, for example 45
frames). Photographs stay single observations. Short video windows are left
padded with zero masks; observations are never repeated to simulate motion.
Set `augment_cfg.mirror: false` unless a reviewer has confirmed that reflection
preserves every class (`mirror_label_invariant: true`). No static classes are
excluded because a seed sport pack happens to omit them.

```bash
python ml/training/train.py --config data/squash/static.train.json
python ml/evaluation/evaluate.py --run-record ml/runs/run.json --split val --out ml/runs/val.json --logits-out ml/runs/val.npz
python ml/evaluation/open_set.py ml/runs/val.npz --out ml/runs/calibration.json
python ml/evaluation/evaluate.py --run-record ml/runs/run.json --split test --calibration ml/runs/calibration.json --out ml/runs/test.json
python ml/export/export_onnx.py --run-record ml/runs/run.json --calibration ml/runs/calibration.json --evaluation ml/runs/test.json --out ml/runs/squash.onnx
```

Use the actual run-record filename emitted by training. Evaluation restores the
exact architecture/checkpoint, reports class support and per-view results, and
writes `null` for unknown false acceptance when there are no true UNKNOWN
examples. Phase boundary accuracy is not measured by a movement classifier.
Calibration CLI rejects test-split logits. With no UNKNOWN validation examples,
thresholds default to 1, preserving abstention until suitable negatives exist.

Export writes float ONNX, an equivalence report, model card and
`*.deployment.json` with exact classes, checkpoint lineage, model digest, input
window/normalization and temperature/threshold settings. Raw body-relative
coordinates use `smoothing: none`, matching the learned browser recognizer.
`--movement-ids` accepts an explicit reviewed mapping; none is inferred.
These are provisional development artifacts until expert, held-out athlete,
unknown-class and reference-device release gates are approved. ONNX export does
not promote them to production.

## Train and install both squash models

After capture preparation creates `data/squash/dataset_static_pose.json` and
`data/squash/dataset_dynamic_movement.json`, inspect the full training plan:

```bash
python tools/train_squash_models.py --plan-only --runs-dir ml/runs/squash/first-capture
```

This checks pose files, source checksums, frame quality, original label coverage,
and actual train/validation/test splits. It writes the two configurations and
`training_plan.json`. It does not train or install model assets.

Run the prepared plan locally when the dataset is ready:

```bash
python tools/train_squash_models.py --runs-dir ml/runs/squash/first-capture --device auto --steps 1000
```

The default uses the local GPU when PyTorch CUDA is available, otherwise CPU.
`--device cpu` forces CPU; `--epochs 30` replaces the fixed step budget with
30 passes over each task's available windows. `--tasks static_pose` or
`--tasks dynamic_movement` limits the run. Dependencies are listed in
`ml/requirements-training.txt`; the script performs no installation or AWS jobs.

The orchestrator preserves original class IDs and display names, records missing
holdouts, never substitutes training accuracy for test accuracy, and refuses
held-out metrics if the split checker detects leakage. It writes every run's
losses, split/class support, validation/test reports, calibration and release
blockers under the run directory. Without UNKNOWN validation examples, strict
acceptance remains disabled; the development interface can show the raw top
candidate explicitly as an unvalidated suggestion.

Training windows require `min_observed_fraction: 0.6` by default, matching the
browser visibility gate. The fraction counts visible landmarks over the entire
window, including zero padding. Train/evaluation/preflight reports record empty
and low-visibility rejections; class support counts include only retained
windows. The threshold is exported in the input contract, and labels with zero
usable training windows stop preflight instead of receiving invented support.
For a first development subset, `--allow-partial-coverage` explicitly permits
training only supported labels. Complete source catalogs, names, capture/window
counts and exclusion reasons remain in the plan, summary, deployment and model
card. Excluded captures are filtered explicitly; they are never relabeled UNKNOWN.
The prepared manifests and source captures remain unchanged.

After all requested models pass float ONNX equivalence, it installs:

```text
apps/frontend/public/models/squash/
  static_pose.onnx
  static_pose.deployment.json
  static_pose.model_card.json
  dynamic_movement.onnx
  dynamic_movement.deployment.json
  dynamic_movement.model_card.json
  index.json
```

The prepared manifests must identify MediaPipe `full/float16/1` and the exact
pose checkpoint SHA-256. The orchestrator resolves that checkpoint through the
same cache helper used by preparation, verifies its digest before training and
again before installation, and installs it as
`apps/frontend/public/models/pose_landmarker_full.task`. Other variants and
mismatched checkpoints fail explicitly. Model deployment metadata/cards retain
this pose provenance. `--plan-only` checks the manifest metadata without loading
a detector or downloading weights.

The index is an array of `{deployment_url, model_url}` entries resolved relative
to `/models/squash/index.json`. Partial task runs preserve the other existing
index entries. Original labels and readable `class_names` are separate from
reviewed coaching movement IDs; no coaching mapping is inferred. Model artifacts
remain provisional, with their blockers recorded even after installation.
