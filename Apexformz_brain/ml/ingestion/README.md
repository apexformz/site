# Capture collection importer

`python -m ml.ingestion.capture` inventories existing **squash DataCapture** S3 media. It uses **only List, Head and Get** operations. Supplying `--cache-dir` downloads source objects into a local cache; it never changes a source bucket, label, or capture. The CLI accepts only `--sport squash` (the default) and a `raw/squash/` prefix or child prefix. DataSorter and other sport imports are rejected.

Install `boto3` in the Python environment (`boto3[crt]` when using AWS CLI login credentials). Authentication comes from the standard AWS credential chain or `--profile`; no credentials belong in this repository. Both `--profile` and `--region` are supported.

For the existing DataCapture deployment:

```powershell
python -m ml.ingestion.capture --profile apexformz-owner --region ap-southeast-2 --bucket apexformz-datacapture-prod-350445709199-ap-southeast-2-media --prefix raw/squash/ --manifest-bucket apexformz-datacapture-prod-350445709199-ap-southeast-2-labels --out data/squash/capture_inventory.json
```

Add `--cache-dir data/squash/media` to download eligible records. `--max-objects 5` limits an initial inspection; this limit is recorded in the inventory. All paginated source objects are inspected when the limit is absent. `--workers 4` is the default bounded concurrency for metadata, HEAD requests and media caching; 1–16 is supported. Prefer a directory excluded from version control for inventories and athlete media.

Metadata catalog documents may contain multiple sports. Only squash movements/captures and their referenced athlete records are retained for this import. A source object with a movement ID outside squash is blocked.

The importer recognizes the actual sibling application formats:

- DataCapture media key: `raw/{sport}/{session}/{direction}/{capture}/{original-filename}`. Filename labels include mode, level, pose slug, direction and athlete code. S3 metadata contains capture/session/athlete/movement IDs, direction, catalog revision and SHA-256.
- Verified capture manifest: `apexformz.datacapture.capture.v1`, under `manifests/{session}/{capture}.json`.
- Archived records: `apexformz.datacapture.archive.v1`, with `kind`, `revision`, `data`. When CAPTURE or ATHLETE archives are present, their latest revisions take precedence over old verified manifests, including retakes and withdrawn consent. The inspected deployment currently archives SESSION, FROZEN, AUDIT, MOVEMENT and SPORT only; its S3 labels therefore do not establish current athlete consent. Catalog MOVEMENT records enrich original display names.

Output is `apexformz.capture_inventory` version `1.0.0`, specified in `capture_inventory.schema.json`. Each record includes:

- `source`: S3 URI, bucket, key, version, ETag, size, last-modified time, SHA-256 when recorded, and encryption indication.
- When the verified capture manifest pins an older S3 object version, the importer retrieves that exact accepted version and still verifies its identity, size and hash. It records the latest version separately; an unverified overwrite cannot silently replace the labeled bytes. A missing accepted version remains blocked.
- `local_path` and `local_sha256`: populated only after verified download. Paths use a digest of source identity and a genuine media extension, so object keys cannot escape the cache. Cached files are rehashed before reuse. Versioned objects use pinned `VersionId`; unversioned reads require an ETag condition.
- Original capture, session, athlete and movement IDs; movement name, static/dynamic mode, level, view, capture dimensions and duration where known. Missing identity stays `null`; unknown handedness stays `unknown`.
- `split_group_id`: source session plus movement when known; otherwise one shared `unknown-identity` group. This is a conservative leakage-prevention group, **not** evidence that separate cameras observed the same synchronized execution. `synchronization` remains `not_established`.
- `metadata_sources`: versioned metadata object provenance. `validation` distinguishes media blockers (withdrawal, superseded capture, mismatched identity/version/hash/size) from missing-evidence warnings.

DataCapture's `GRANTED` consent does not encode a training purpose or retention date. This importer preserves that fact; it does not manufacture purpose, retention, expert judgments, phase boundaries, canonical coaching mappings, or evaluation athletes. `eligible_media` means the available source metadata has no detected media blocker, not that a record is cleared for training or release. The summary always reports production readiness as false until the downstream labeling, authorization and held-out evaluation work is complete.

The downstream preparation step consumes `records[].local_path`, creates pose streams, and writes the full `ml/datasets/dataset_manifest.schema.json` dataset manifest. It must preserve source provenance and supply any additional training authorization and label mappings explicitly. Static photos can support posture recognition; they do not provide measured temporal phase boundaries.

Prepare media with `python tools/prepare_capture_dataset.py --inventory data/squash/capture_inventory.json --out-dir data/squash --workers 4`. The bounded worker count is 1–8. `--orientation-policy metadata` is the default: it honors EXIF and video-container rotation. Use `--orientation-policy encoded` only for a reviewed batch whose stored pixels are correct and rotation tags are wrong. The inspected squash batch was confirmed as landscape; this batch requires `encoded`. This option disables metadata rotation before decoding both images and videos. It never infers a rotation from an athlete's posture.

Pose caches include source SHA-256 and record identity, view, the actual MediaPipe checkpoint hash and runtime version, decoding policy, extraction options, dependency versions and extraction code hashes. A changed policy or model creates a separate cache. Still images and video use the same dominant-athlete selection and competing-person ambiguity checks. Split construction keeps shared athlete identities, capture sessions, capture groups, streams and duplicate source bytes together. A single recorded athlete consequently yields training-only data, with no invented validation or test results.

After preparation, run `python tools/capture_preparation_coverage.py --inventory data/squash/capture_inventory.json --out-dir data/squash` with the same inventory. This verifies its hash against the preparation output and attaches `source_label_catalog` to both manifests and the report. Each exact source label retains its name, eligible source count, prepared count and exclusion-reason counts, including labels whose captures all failed preparation. Training-window visibility checks may reduce support further and must report that separately.

Run focused offline tests:

```powershell
python -m pytest ml/ingestion/test_capture.py -q
```
