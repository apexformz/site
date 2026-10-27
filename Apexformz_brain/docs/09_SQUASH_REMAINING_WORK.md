# Squash: current engineering status

Current snapshot: **26 October 2026**. The local technical work uses the existing identity-corrected Data Capture collection. New collection and coach validation remain deferred. Earlier 25 October reports are historical snapshots; they do not describe the currently installed ensemble.

## Production infrastructure follow-up

The next local engineering pass adds actual Ed25519 release signing, real PostgreSQL integration and enforced release checks. The local private key is protected by NTFS permissions; the public registry independently authenticates six separately signed pack copies. Tests cover tampering, unknown/revoked/test keys and TypeScript/Python signing parity. Original development packs and trained model bytes are preserved.

Three real database migrations now support atomic event/derived-row ingestion, session completion and rewards, expiring worker leases, persisted retry scheduling and durable analysis output. The test suite restarts the Python service, resumes saved requests, boots the bundled backend and checks PostgreSQL backup/restore equality. No existing user database was migrated.

The release tools bind source, complete build output, tests, signed packs and the ten locked model files into an immutable local candidate inventory. Production trust is embedded in the frontend build. The CI workflows enforce dependency audits and use a real PostgreSQL service. Node and Python service dependencies have been remediated; the Python service has a universal hash lock and a fresh Python 3.12 validation environment. Deployment files now build from the monorepo root, install the local contracts/perception packages, run without root privileges and wait for migrations/database readiness.

See `docs/PRODUCTION_PACK_SIGNING.md`, `docs/RELEASE_CANDIDATES.md` and `infrastructure/deployment/README.md`. The final verification and remaining machine/external blockers are indexed in `data/audit/production-technical-completion-20261026.json`. A local candidate is not approval to release the current provisional models or coaching criteria.

## Installed models and data

| Task | Installed model | Known labels | Training observations |
|---|---|---:|---:|
| Static pose | TCN, 4,000 steps | 68 + UNKNOWN output | 265 single-photo windows |
| Dynamic movement | Equal-weight TCN / ST-GCN++ ensemble, 18,000 / 30,000 steps | 109 + UNKNOWN output | 768 temporal windows |

The prepared collection contains **625 captures: 266 photos and 359 videos**. One photo does not produce a usable training window. Drop-shot movement (`squash.dynamic.0093`) remains the one captured dynamic label without usable windows. Other catalog entries without captures remain explicit coverage gaps.

Models retain `world_bodyframe_v1`, `tracker_root_v1`, the identity-only frame gate and the full MediaPipe checkpoint. The dynamic version is `ensemble-tcn-1792951658562396800-stgcnpp-1792954148483621100`; the static version is `tcn-1792952301195117500`. Model weights were not changed during this technical completion. The ensemble model card now records the actual dataset and split hashes and both member run/checkpoint identities.

These are provisional models from one athlete, with no independent validation/test partition or UNKNOWN examples. Movement thresholds remain disabled for validated acceptance. The 184 movement definitions, 184 phase graphs and 848 criteria still require review.

## Completed technical changes

- **Re-ID race fixed.** Appearance requests carry a subject identity, lifecycle generation and unique request identity. Re-pinning, unpinning and resets invalidate in-flight work. Results are consumed once; expired and older resolution results are rejected. Empty, non-finite and dimension-mismatched vectors cannot poison the gallery.
- **Worker and detector boundaries enforced.** Delayed appearance callbacks cannot cross pin changes, pause/resume, session completion, disposal or camera/session/mirror/orientation changes. The async RTMO backend also checks generation before mutating the tracker. Late initialization releases resources after disposal. Reset clears unresolved image taps while preserving an established pin.
- **Event chronology fixed.** Frame-driven degraded/revalidated transitions use the capture clock, preserving the timestamps of measurements. Frames older than a processed frame or lifecycle boundary are discarded, including a queued frame overtaken by a camera-loss heartbeat.
- **Reproducible model tests.** Ordinary tests run small checked-in, input-dependent ONNX graphs through real ORT without ignored model binaries. A separate strict installed-model suite verifies SHA-256 pins, static/dynamic PyTorch reference outputs, remote inference equality and re-ID pixel-to-embedding parity. Missing or changed artifacts fail explicitly.
- **Model installation reproducible locally.** A checked-in lock and offline verify/export/restore commands bind ten model/config/card files. Restore checks the whole bundle before writing. CI has a separate explicitly supplied artifact path for installed-model tests.
- **Real-data contrastive pretraining completed.** Non-dry runs now use explicitly assigned training captures with the shared masks, normalization and continuity gates. Split leakage is rejected. Encoder warm-start verifies data, input contract, architecture and checkpoint hashes and initializes a fresh classifier head.

The pretraining smoke used 768 real training windows from 359 pose files, ran two contrastive steps and two supervised warm-start steps, and restored 28 encoder tensors. Evidence: `ml/runs/squash/pretrain_completed_20261026/smoke_summary.json`. This confirms the training path; it does not claim an accuracy gain or replace the deployed models. See `ml/training/PRETRAINING.md`.

## Refreshed replay and annotation artifacts

The recorded replay runs the actual BrainRuntime, browser ONNX loader and frontend admission logic in strict and development modes. It preserves source identity, quality, timing, view and handedness. Static photos remain single instants. Duplicate-frame, identity-change, camera-gap and ended-session probes stay outside measurement/fitting exports.

| Evidence | Current path |
|---|---|
| Recorded replay | `data/audit/squash-recorded-replay-identity-20261026.json` |
| Unreviewed runtime aggregates | `data/audit/squash-runtime-measurements-identity-20261026.jsonl` |
| Annotation bundle | `data/squash/review-identity-20261026/` |
| Verified annotation sources | `data/squash/review-identity-20261026/source-verification.json` |
| Criterion/variance readiness | `data/squash/criterion-calibration-identity-final-20261026.json` |
| Offline model bundle | `data/audit/model-bundle-identity-20261026/` |

The final replay passed after the chronology fix: **625 sources and 58,692 frames per mode**, 662 assessment sets per mode and 744 aggregate measurement rows. Development mode exercised 11,584 inference results; strict mode admitted zero provisional recognition results. Counts are regression observations, not independent recognition, phase or coaching accuracy. Only `status: passed` confirms a completed report.

The annotation bundle contains **625 pending tasks**. All 625 media files and 625 pose files passed hash verification against the current manifests. Source hashes, orientation overrides, split assignments and pack snapshots are retained. No annotator, phase interval or technique verdict was invented. Previous review folders remain untouched.

Readiness checks use the current runtime measurements and the explicit provisional search grid. They emit zero fitted proposals because independently reviewed PASS/IMPROVE labels, train-only repeatability floors, independent athletes and held-out partitions are absent.

## Previous core verification before the production infrastructure follow-up

- TypeScript: **472 passed, one pre-existing skipped test**, across 49 files, also reproduced in an isolated source copy with no installed model binaries.
- Python core/perception/ML/ingestion: **319 passed**.
- AI service: **23 passed**. Its local TestClient needed execution outside the sandbox because Windows loopback socket-pair creation was blocked inside it.
- Root typechecking, backend build and all six sealed sport-pack validations passed.
- Installed-model suite: **3 passed**; no missing-model skips.
- Production frontend build and final Chrome audit passed: **13 cases / 282 checks**, with all 295 source/build/runtime/model/fixture pins unchanged. Evidence: `data/audit/browser-squash/technical-completion-20261026.json`.

The final 120-second native-resolution soak produced 1,661 ticks and 1,140 movement detections, with at most one outstanding image and zero unexpected worker errors. These are local regression observations, not target-device or independent accuracy measurements. All reports and final source checks are indexed in `data/audit/technical-completion-20261026.json`.

The browser runner now exercises actual pointer taps, re-pinning, gallery collection through real re-ID inference, camera pause/resume, unpinning and a new pin. Existing recorded camera clips provide one athlete. Actual two-person crossings, same-kit identity discrimination and physical-camera performance remain unverified by this browser fixture.

Python warnings include unavailable optional SAM2 compiled mask post-processing and existing ONNX-export deprecations. The tested tracking and export paths passed; the optional SAM2 post-processing extension remains unavailable on this installation.

## Reproduce

```powershell
npm test
npm run models:verify
npm run test:models
npm run models:export -- --out data/audit/model-bundle-next
# In a matching source checkout:
npm run models:restore -- --from <bundle-directory>
npm run replay:squash -- --out data/audit/replay-next.json --measurements data/audit/measurements-next.jsonl
.venv/Scripts/python.exe tools/squash_annotation_review.py verify --bundle data/squash/review-identity-20261026/bundle.json --out data/audit/review-verification-next.json
```

Model lock, bundle, parity generation and CI instructions are in `tests/models/README.md`. Artifact export and annotation verification use new output paths to preserve earlier evidence. Browser reproduction instructions remain in `docs/12_ATHLETE_PINNING_AND_LOCK_ON.md` and the validator CLI.

## Work deliberately left for later

- New athletes, repeat executions, UNKNOWN/similar motions and usable missing-label captures; then independent generalization and open-set calibration.
- Coach review of movement identity, phases, technique outcomes, thresholds, variance tolerances and feedback.
- Actual racket/ball/contact observations and court correspondences. The runtime adapters already validate session/camera/subject/time scope; the frontend still advertises body pose only because no validated live equipment source is supplied.
- Physical two-person/same-kit camera checks, target-device latency, long-session thermal/memory and audible-feedback validation.
- External deployment, protected CI runner/secret provisioning, live monitoring, operational privacy review and commercial model-rights clearance. Local signing, isolated database integration and release workflow implementation are now completed as described above. Docker image execution still needs a functioning engine; the installed Windows engine fails on an inaccessible stale inference socket.

The local software work does not establish production readiness or coaching accuracy. New collection, coach review and physical-device evidence remain deliberately pending. Production promotion rejects missing evidence and does not infer it from engineering tests or valid signatures.
