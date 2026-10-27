# Unresolved validation items

Written for: the coach panel, data team and engineering leads deciding what may ship.

Everything below is marked `TODO_REQUIRES_VALIDATION` in the repository. None of it is an approved rule, biomechanical cutoff or performance claim.

## Sport domain data

- Court, range and table geometry values are `null` in every seed pack until the authoritative rule edition is recorded in `provenance.json`. Squash is the exception: its court dimensions and competition rules are transcribed from the WSF Court Specifications (January 2017) and the WSF Singles Rules 2025 V1.2 and are `approved` with those citations; the racket and ball figures remain `provisional` until confirmed on the WSF specification pages.
- Scoring systems and fault definitions are text-only; no numeric game values are stored.
- Movement definitions (squash 184, badminton 9, shooting 5, pickleball 9, table tennis 9, taekwondo 10) carry `review_status: coach_review_required`. Squash includes the Data Capture catalog and two uncaptured serve/return definitions. Aliases marked `proposed` do not resolve.
- Every criterion range or limit is `provisional`. In strict mode the Brain returns UNCERTAIN with reason `RUBRIC_UNVALIDATED` and withholds cues. Development mode evaluates them but labels every output provisional.
- Every feedback cue is `draft`. Strict mode never speaks a draft cue.
- Phase-graph thresholds (for example the lunge knee angles 148/138/125/150 degrees, hold and minimum durations) are engineering seeds to be fitted on annotated recordings.
- Taekwondo legacy angular-velocity triggers have ambiguous units in the original data; they are flagged per movement in `sport-packs/taekwondo/provenance.json`.

## Squash (first training sport)

- The 848 squash criteria and 184 phase graphs remain provisional. Templates provide coaching rules and phase thresholds; static reference vectors come from the captured poses, but their acceptance limits are not calibrated. Capture-level movement labels do not establish phase boundaries or technique correctness. Fit phases on independently reviewed annotations with `ml/sports/squash/fit_phase_thresholds.py`; criterion separation and human-variation fitting still need coach-labelled repetitions.
- Ball contact is never observed from body pose. The equipment runtime/adapters now accept explicitly observed contact bound to the matching camera, subject and frame; real measurement accuracy and numerical coaching comparisons still need validation.
- Foot-in-box at the serve has an adapter for explicit image-to-court correspondences and supplied ground-contact observations. Real court calibration accuracy remains unvalidated. The Brain never calls faults.
- Shoulder-turn features use model depth and are depth-ambiguous without a side view; treat them as low-confidence until validated.
- Squash recognition and phase accuracy are not independently established. Historical cross-view experiments used one athlete and some different identity assumptions; phase reports used unreviewed activation proxies. Neither validates the current installed models (`docs/09_SQUASH_REMAINING_WORK.md`).
- The squash family -> group taxonomy, its family names and the 66 reference models come from one athlete. Prepared manifests include owner-attested handedness/consent metadata while preserving unknown original values. After correcting 71 sideways stills, reference quality checks retain 241 static captures. Group/family recognition gates (0.6, margin 0.1) remain provisional; within-athlete exploratory results do not establish independent-athlete performance. Historical taxonomy cohesion statistics used the earlier pose snapshot. See `docs/08_SQUASH_TAXONOMY.md` section 5.
- The squash human variance profile (5 percent baseline, 10 to 20 percent for racket-arm, derivative and timing families, novice x1.5, advanced x0.8, measurement floors 5 deg / 80 ms / 0.03 torso units) is seeded from the variability literature in `docs/07_HUMAN_VARIANCE.md`, not measured on squash players; fit it per criterion on repeated executions in the coach recordings before approval.
- The suite includes synthetic geometry and actual recorded replay using 625 identity-corrected pose streams (from 642 eligible captures). Current models cover 68 static and 109 dynamic labels. Replay checks software invariants, not end-to-end coaching accuracy; see `data/audit/squash-recorded-replay-identity-20261026.json`. The refreshed `data/squash/review-identity-20261026/` bundle has 625 pending tasks and verified media/pose hashes.

## Signal and perception parameters

- One-Euro parameters (`min_cutoff 1.7`, `beta 0.6`, `d_cutoff 1.0` in torso-length units), outlier speed limit (30 torso lengths/s), landmark visibility threshold (0.5), time-gap threshold (400 ms), subject-tracker ratios and the degraded/revalidation timings are candidates pending tuning on held-out recordings and reference devices.
- Pose model: MediaPipe Pose Landmarker is the baseline; RTMPose or other challengers have not been benchmarked on hard sport clips.

## Learned components

- Squash has a static TCN and a dynamic TCN/ST-GCN++ ensemble with matched training/live continuity. Both remain provisional: one athlete, no independent validation/test partition and no UNKNOWN examples. Drop-shot movement is the one captured dynamic label without usable windows. The heuristic `PhaseSegmenter` remains the phase baseline; no learned phase model has been fitted. Real-data contrastive pretraining and encoder warm-start now run on train-only captures, but their local smoke does not establish an accuracy gain. See `docs/07_SQUASH_TRAINING.md` and `ml/training/PRETRAINING.md`.
- Open-set thresholds per movement require a reliability study before a learned recognizer may be used.
- The legacy ST-GCN weights were trained on a small internal set and are not part of the Brain's live path.

## Performance

- Benchmarks in `tests/performance/results` come from a synthetic athlete on a development machine (see the JSON for the machine fields). They characterize the Brain's own per-frame cost, not pose inference, rendering or device thermals. The TRD P95 targets (100 ms overlay, 250 ms simple feedback) remain unmeasured on reference hardware.
- Recorded-video browser checks include a 120-second 1280x720 run through actual MediaPipe, ONNX models and the frontend, plus actual athlete-pin gestures and lifecycle/failure paths. Image queue depth, pose age and main-page heap growth are recorded in `data/audit/browser-squash/technical-completion-20261026.json` (13 cases, 282 checks passed). These local observations do not establish target-device latency, worker/GPU memory behaviour over long sessions or thermal endurance.

## Security and operations

- Packs are signed with a development HMAC key committed in `packages/sport-runtime/src/dev_keys.ts`. Production needs an ed25519 key registry and signing in CI.
- The initial Prisma migration (`0001_brain_init`) is generated and reviewed but has not been executed against a live PostgreSQL (none in the build environment); the existing-database delta path is documented in `apps/backend/prisma/migrations/README.md`.
- The analysis job queue is PostgreSQL-backed (durable, idempotent, bounded retries, terminal FAILED); Redis is provisioned in the compose file but the Redis-native queue adapter is not written. TRD 13 names a Redis-backed queue; the DB-backed dispatcher meets the retry/dead-letter behaviour and shares a host as TRD 13 permits initially.
- CI runs `npm audit` as advisory (non-blocking); making it blocking needs an allowlist review of the legacy frontend dependencies.
- Actual browser IndexedDB persistence and event chronology are exercised by the recorded-video browser suite. Reload recovery respects the host's offline predicate. End-to-end cloud synchronization and deployment still need the previously deferred service validation.
- The adaptive capture scheduler has synthetic unit tests and recorded-video browser coverage, including native camera resolution and main-thread fallback. Its level thresholds remain candidates until profiled on reference devices.
- The production camera-to-results flow is exercised in Chrome using existing landscape Data Capture videos as fake camera input, with a separate Edge rendering check. Physical camera, reference-device and audible-output validation remain outstanding. See `docs/09_SQUASH_REMAINING_WORK.md` for the exact coverage and explicit fault cases.

## Third-party model licensing (phase 2)

- CoTracker3 (CC-BY-NC), VideoPose3D (CC-BY-NC) and GVHMR (non-commercial) are integrated as research adapters only; `commercial_ok=false` and jobs must opt in with `allow_noncommercial`. Legal review is required before any commercial exposure.
- SAM 3 and Sapiens carry custom Meta licenses and are not integrated.
- SMPL-based world-grounded methods (4D-Humans, WHAM) need a separate SMPL license; not integrated.
- Ultralytics YOLO (AGPL-3.0) is deliberately excluded from the browser bundle.
- MediaPipe, TAPNet, SAM 2.1, RTMPose/rtmlib, MotionBERT, ByteTrack, mmaction2/pyskl and onnxruntime are permissive (Apache-2.0 or MIT); checkpoint provenance (URL, digest) is recorded by each adapter.

## Model performance claims (phase 2)

- Throughput numbers in `packages/perception-py/README.md` are from one development GPU on short clips; they are not device benchmarks.
- The deployed static TCN and dynamic TCN/ST-GCN++ ensemble have actual training and PyTorch/ONNX parity evidence, but no independent-athlete recognition accuracy or unknown-rejection evidence. Exploratory camera-view holdouts use the same athlete and do not establish deployment accuracy.
- The RepNet-style repetition detector is validated on synthetic signals; its thresholds (energy, periodicity) are provisional.
