# Contrastive pretraining on local pose captures

`pretrain_contrastive.py` uses the same `TrainConfig` JSON and `PoseJsonlDataset`
normalisation, masking, continuity and observation gates as supervised training.
Labels are ignored. An explicit train/val/test assignment is mandatory, either
inside the dataset manifest or in `split_manifest`. Only training windows are
loaded; athlete/session/stream leakage and pose files shared across partitions
are rejected, including when `allow_development_split` is set in the config.

Run from the repository root with the Python environment used for training:

```powershell
$env:APEXFORMZ_DEVICE = 'cpu'
python ml/training/pretrain_contrastive.py --config path/to/train_config.json --steps 2 --batch-size 4 --out-dir ml/runs/pretrain-smoke
```

Remove the small `--steps` override for a deliberate full experiment. The command
uses real manifest data unless `--dry-run` is explicitly supplied. Dry runs use
two synthetic steps, mark the record `synthetic_smoke`, and save no checkpoint.
Real runs need at least two usable training windows. Each batch samples distinct
windows, with a size capped at the dataset length. Seeded CPU runs are covered by
a regression test that compares every saved encoder tensor and loss.

The JSON record includes the exact input/architecture contract, dataset and split
hashes, training pose hashes, source-code hashes, seed, hardware, loss history,
and encoder checkpoint checksum. The saved encoder excludes the movement head
and the projection head. It cannot be deployed as a classifier.

For fine-tuning, add the following field to the same supervised training config:

```json
{"pretrained_encoder_record": "ml/runs/pretrain-smoke/pretrain-tcn-<run-id>.json"}
```

Then run `python ml/training/train.py --config path/to/train_config.json`.
The loader verifies hashes, input contract and encoder shape before copying
weights; it keeps the movement classification head freshly initialized and writes
the pretraining lineage into the supervised run record. The architecture and
input preprocessing must match, but the movement classes may differ. Currently
the dataset and split manifests must match exactly: a broader unlabeled corpus
requires a separate overlap audit before that restriction can be widened.

The existing Squash capture set has a single athlete in its training partition.
A successful local pretraining smoke run demonstrates the data and warm-start
path. It does not establish accuracy improvement, independent generalisation,
calibration, or coach approval. Existing deployed weights are unchanged.
