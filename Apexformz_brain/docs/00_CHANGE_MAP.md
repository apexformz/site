# ApexFormz Brain — Change Map and Migration Plan

Written for: engineers joining the Brain build who know the original ApexFormz (SmartCoach) repo.

TRD 15 asks the implementing agent to inventory the existing architecture first, then produce an impact map and a migration plan before writing code. This document is that output.

## 1. Inventory of the original repository (`C:\Users\ASUS\Desktop\IITK Composit\Apexformz`)

| Area | What exists | Reused in the Brain repo as |
|---|---|---|
| `apps/frontend` (Next.js 14, Tailwind, Framer Motion) | Landing, auth, dashboard, `/train/[sport]` camera page with MediaPipe Holistic in the main thread, Socket.IO frame relay, results, profile, circles, gamification UI | Copied to `apps/frontend` and extended. Legacy sports keep the old flow; Brain sports get an on-device worker flow. `PoseSkeleton`, `ActionableFeedback`, `TrainingStats`, auth and API helpers are reused through the legacy adapter. |
| `apps/backend` (Express, Prisma, Socket.IO) | JWT auth, sessions, XP/streaks/achievements, circles, leaderboard, WebSocket relay to the Python AI service | Copied to `apps/backend`; relay kept for legacy sports; new `/api/v1` TRD 13 routes and Prisma tables added. |
| `apps/ai-service` (FastAPI) | Static angle-blueprint analyzer, dynamic engine (phase FSM, One-Euro filter, kinetic chain, DTW, FrameMatcher, ST-GCN) | Copied to `apps/ai-service` for legacy sports; new `/v1/analysis/jobs` retrospective analyzer uses the shared contracts. One-Euro filter, phase FSM semantics (trigger hold, minimum gap, lookahead), tracking-confidence gating, issue persistence and score smoothing were ported into the TypeScript Brain. |
| `packages/types` | Shared legacy TypeScript types | `packages/legacy-types` (same package name `@smartcoach/types`) so copied code compiles unchanged; adds `BRAIN_SPORTS`/`isBrainSport`. |
| `apps/ai-service/app/data/reference_movements.json`, `taekwondo_reference_frames.json` | Hand-authored phase blueprints and expert joint-angle frames from three camera views | Migrated into `sport-packs/taekwondo` (status `legacy_migrated`, all provisional) by `tools/migrate_taekwondo_pack.py`; expert frames become `reference_set` models for the `reference_nearest` evaluator. |
| `pose_landmarker.task` (28 MB) | MediaPipe Pose Landmarker model | Referenced by the frontend worker (`public/models/`), not committed. |
| Hand-authored angle cutoffs for cricket, tennis, yoga, running, boxing, football | `reference_poses.json` blueprints | Not migrated. They are exactly the "fabricated normative cutoffs" the TRD forbids in the shared core; they remain on the legacy Python path until sport packs with provenance exist. |

Worker entrypoints, MediaPipe versions and build scripts found: Holistic `0.5.1675471629` via CDN on the main thread (no worker); Python `mediapipe 0.10.35` for offline extraction; Docker Compose for three services plus Postgres; Prisma 5 with `db push`.

## 2. Impact map: what the TRD changes

| TRD rule | Original behaviour | Brain behaviour |
|---|---|---|
| ADR-001 no network on the real-time path | Every frame went browser → Socket.IO → Express → HTTP → FastAPI → back | Pose detection and the whole data plane run in a browser Web Worker; the cloud receives an event outbox asynchronously |
| ADR-002 isolated sport packages | Sport knowledge inside Python code and JSON blueprints shared by all sports | Eight declarative files per pack, signed and hashed, loaded by a registry; the core never names a sport (enforced by a test) |
| ADR-003 criterion evidence with abstention | A 0–100 score always produced, even with missing joints | Five criterion states; null measurements carry typed reasons; coverage-gated score that is `null` when evidence is insufficient |
| ADR-004 immutable versioned models/rules | Blueprints edited in place | Pack versions are immutable, pinned per session, rollback to known-good |
| ADR-005 causal online, retrospective offline | Live pipeline used 15-frame rolling Butterworth (near-zero-phase) | Live path is strictly causal; zero-phase filtering only in the Python retrospective analyzer and marked `retrospective: true` |
| No fabricated thresholds | Blueprint angles asserted as truth | Every numeric cutoff is `provisional` with a `TODO_REQUIRES_VALIDATION` note; strict mode abstains on provisional rubrics |

## 3. Migration plan

1. **Contracts first (done).** JSON Schema is the source of truth; TypeScript and Pydantic mirror it and share fixtures.
2. **Edge Brain (done).** `packages/*` implement WP02–WP07 with golden fixtures G01–G10.
3. **Sport packs (done, seed quality).** Badminton and shooting carry the first vertical slice; pickleball and table tennis are ontology seeds; taekwondo is a legacy migration. Coach-panel approval is the gate before any criterion becomes `approved`.
4. **Apps (done, copied and extended).** Frontend routes Brain sports to the worker; backend adds `/api/v1`; ai-service adds retrospective jobs. Legacy flows are untouched so existing users lose nothing.
5. **Cut-over per sport.** A legacy sport moves to the Brain only when a pack with provenance exists. Taekwondo is the first candidate: the pack exists, the legacy path stays the default until a coach panel reviews it.
6. **Cloud hardening (WP08/WP10).** Run Prisma migrations, enable the job dispatcher, add the ed25519 key registry, wire canary metrics from `TelemetrySample`.
7. **Data and training (WP09).** Capture athlete-disjoint datasets, train the TCN challenger, calibrate per-movement open-set thresholds, and only then let a learned recognizer replace the heuristic segmenter.

## 4. Phase 2 (perception and tracking, sport-agnostic)

Requested after the first delivery: "complete everything else" with industry-level open-source models while the sport-specific brains wait for coach review. Added without touching any sport pack content:

| Addition | Repos reused | Notes |
|---|---|---|
| `packages/perception`: ByteTrack subject tracker, keypoint-set adapters (COCO-17, Halpe-26, WholeBody-133) | ifzhang/ByteTrack (algorithm) | Any COCO-style backend can feed the 33-slot contract; missing landmarks stay missing |
| `packages/brain-client`: ONNX pose backend (RTMO, SimCC) with WebGPU/WASM | onnxruntime-web, OpenMMLab RTMPose/RTMO exports | Decoders unit-tested in Node |
| `packages/analysis`: RepNet-style repetition detector | google-research/repnet (method) | Class-agnostic, causal, in every tick |
| `packages/perception-py`: pose backends (MediaPipe, rtmlib), trackers (TAPNet, CoTracker3, SAM 2.1), lifting (MotionBERT, VideoPose3D), smoothing | listed in `docs/05_PERCEPTION_TECH_STACK.md` | Every adapter exposes `commercial_ok`; non-commercial models require opt-in |
| `apps/ai-service`: `/v1/perception` and `/v1/tracking` job routes | | Offline results flagged retrospective |
| `ml/`: ST-GCN++ port, contrastive pretraining, open-set calibration, JSONL dataset | kennymckormick/pyskl (architecture) | No mmcv dependency |
| `contracts`: `TrackSet` schema (TS + Pydantic + fixtures) | | Shared by all trackers |

## 5. Phase 3 (squash: the first sport engine to be trained)

Requested as "create a squash sports engine"; the coaches will provide static and dynamic recordings for model training. Added without any change to the shared core's sport neutrality:

| Addition | Source | Notes |
|---|---|---|
| `sport-packs/squash` (8 files, sealed) | WSF Court Specifications (Jan 2017) and WSF Singles Rules 2025 V1.2, read from the PDFs; coaching heuristics and the squash CV literature for provisional content | Court and rules `approved` with citations; all 106 criteria, 15 phase graphs and 106 cues `provisional` / `draft` |
| `tools/gen_squash_pack.py` | | Regenerates ontology, graphs, criteria, cues, provenance and manifest; court, rules and equipment files are hand-written |
| `tools/extract_features.ts` (`npm run extract:features`) | | Runs the edge signal pipeline + feature engine over PoseFrame JSONL so training uses the deployed feature code |
| `ml/sports/squash/` | | Label schema synced from the pack, dataset manifest template (schema-valid), TCN and ST-GCN++ configs (14 classes + UNKNOWN), capture checklist, phase-threshold fitting script |
| `docs/06_SQUASH_DOMAIN.md` | | Court, rules, equipment, movement taxonomy, observability limits, camera setup, capture protocol, evaluation plan |
| `tests/golden/squash.test.ts` | | Lunge and drive segmentation, strict-mode abstention, capability gating of racket criteria, handedness flip |
| `landmark_set` enum: `halpe_26`, `coco_wholebody_133` | | Schema, TS and Pydantic; adapters now stamp the set on the frame |
| Frontend dashboard card, register list, backend validators, `BRAIN_SPORTS` | | Squash routes to the on-device worker |
| `packages/brain-client/src/scheduler.ts` + training page wiring | TRD 01 fallback order | Capture rate, then input resolution, degrade from measured processing time, queue age and thermal state; core checks are never disabled |
| Calibration UI: camera tilt, scale marker, floor orientation | TRD 02 | Without a scale marker the Brain reports normalized body units only |
| `tests/golden/pack_migration.test.ts` | TRD 05 / 11 | Archived pack version reproduces old session scoring next to a newer version |
| `packages/features/src/feature_catalog.test.ts`, perception edge cases | TRD 04 / 02 | Every feature kind: analytic, mirrored, missing joint, confidence; capture edge cases |
| `apps/backend/prisma/migrations/0001_brain_init` | TRD 13 | Generated SQL migration + hand-written down script |

## 6. Review fixes (2026-10-25)

An external review of the coaching and sync paths found four defects; all are fixed with regression tests:

| Finding | Fix | Test |
|---|---|---|
| Provisional `phase_duration` criteria returned PASS in strict mode (the approval gate was applied after the timing branch returned) | Strict gate applied to timing rubrics in `packages/scoring/src/evaluator.ts` | `tests/golden/squash.test.ts` (strict recovery time) |
| Recovery time measured the terminal phase's confirmation dwell (always ~120 ms) | `phase_duration` gained `from_phase_id` / `measure`; recovery criteria measure bottom or contact to recovered; pack validation rejects a terminal-phase span | `squash.test.ts` (dwell scales), `sport_runtime` validation |
| Positive reinforcement bypassed the draft-cue review gate and the phase cue permission | `CoachingPolicy.positive` applies `cue_allowed`, active-cue and review gates | `packages/coaching/src/policy.test.ts` |
| Event sync read a bare outcome while the backend returns `{ success, data }`; completion posted the summary as the body instead of `{ summary, duration_s }`; the outbox was memory-only | `unwrapIngestResponse`, fixed `completeSession` body, durable `OutboxSink` with an IndexedDB store in the worker and `recoverPersistedOutbox` on launch, flush on page hide | `packages/brain-client/src/sync.test.ts`, `packages/runtime/src/outbox.test.ts` |

## 7. Human variance (2026-10-25)

Requested as "humans are not perfect ... a certain percentage of variance, for example 5%", sport-specific. Research summary and model in `docs/07_HUMAN_VARIANCE.md`.

| Addition | Where | Notes |
|---|---|---|
| Variance mechanism (band, zones, repetition tracker) with inert defaults | `packages/scoring/src/variance.ts`, evaluator `judge()` | No numbers in the core; packs without a profile behave exactly as before |
| New criterion reason `WITHIN_NORMAL_VARIANCE` | contracts (schema, TS, Pydantic) | UNCERTAIN with the measurement retained, no correction |
| Rubric profile `aggregation.human_variance` and per-criterion `evaluator.human_variance_relative` | contracts, pack validation | Declared profiles need a validation status; approval needs an approved dataset or coach source |
| Squash variance profile | `tools/gen_squash_pack.py` -> `sport-packs/squash/technique_criteria.json` | 5 percent baseline; 10 to 20 percent for racket-arm, derivative and timing families; novice x1.5, advanced x0.8; provisional |
| Tolerance-aware boundary metric | `ml/evaluation/metrics.py` | Phase boundary errors inside the timing floor are not model errors |
| Tests | `packages/scoring/src/variance.test.ts`, `tests/golden/squash.test.ts` | Zones, context scaling, natural single-rep variation versus consistent fault |

## 8. Complete squash engine from the labeled data (2026-10-25)

Requested as "complete the sports engine": divide movements broadly first, then into branches, with similarity checked on the labeled data.

| Addition | Where | Notes |
|---|---|---|
| Labeled catalog copy | `ml/sports/squash/source_catalog.json` | 182 squash movements from the Data Capture labels bucket, with checksum |
| Similarity measured on the recordings + hierarchy builder | `ml/sports/squash/pose_similarity.py`, `build_taxonomy.py`, `taxonomy_names.json` | Same-view pose distance + label distance, Ward on MDS, silhouette-chosen families and branches |
| Taxonomy contract | movement catalog `taxonomy`, movement `family_id` / `group_id` / `data_status` / `source` (schema, TS, Pydantic); pack validation | Every movement in exactly one group of a same-type family |
| Hierarchical recognition | `packages/analysis/src/hierarchy.ts`, detector, worker | Movement -> group -> family fallback; gates from the pack |
| Full pack | `tools/gen_squash_pack.py` | 184 movements, 184 graphs, 848 criteria, 66 expert reference models, measured hard negatives, legacy seed ids as aliases |
| Expert reference extraction | `tools/extract_reference_vectors.ts` | Deployed feature engine over the static captures |
| Travel phase graph and criteria | squash pack | ready -> travel -> settle |
| Hierarchical picker, recognition level, readable names | frontend `MovementPicker`, `MovementRecognitionPanel`, training page, results | |
| One-command rebuild | `npm run build:squash-engine` | |

## 9. Remaining-work list (2026-10-25)

Item-by-item status, measurements and blockers are in `docs/09_SQUASH_REMAINING_WORK.md`.

| Addition | Where |
|---|---|
| Owner attestations (right-handed coach, consent from coach and club) applied to datasets with audit trail | `ml/sports/squash/athlete_attestations.json`, `tools/athlete_attestations.py`, `tools/prepare_capture_dataset.py` |
| `identity_only` frame gate and historical `geometric` research continuity; superseded for live use by shared `tracker_root_v1` | `ml/datasets/jsonl_dataset.py`, `packages/brain-client/src/movement_detector.ts` |
| Hip-centered `world_bodyframe_v1` input (training + browser, numerical parity tested; view generalization remains unvalidated) | same files; `packages/brain-client/src/world_bodyframe.test.ts` |
| Hierarchy-aware loss, speed augmentation, training recipes | `ml/training/train.py`, `tools/train_squash_models.py` |
| Leave-one-camera-view-out evaluation with gate curves | `ml/sports/squash/cross_view_eval.py`, `ml/runs/squash/cross_view/` |
| Phase-activation exploration on training recordings + unreviewed phase proposals | `tools/calibrate_phase_graphs.ts`, `ml/sports/squash/phase_calibration.json`, `phase_prelabels.jsonl` |
| Handedness canonicalisation for recognition | detector, model contract (`canonical_handedness`), worker |
| Recognition-gated coaching (off by default, validated recognizers only) | `packages/runtime`, worker; `tests/golden/recognition_gating.test.ts` |

## 10. Local completion of five engineering items (2026-10-25)

Tracking ROI and matched continuity, equipment/court measurements, criterion/variance fitting, real recorded regression, and display/provenance cleanup are documented in `docs/09_SQUASH_REMAINING_WORK.md`. The full replay also found and corrected 71 sideways still images with audited extraction overrides. Corrected references and the static classifier were rebuilt; original bytes remain in a versioned snapshot. Coach labels, new athletes and release validation were not inferred.

## 11. Browser validation and fixes (2026-10-25)

The production frontend now has a reproducible browser regression using four existing landscape squash Data Capture videos, plus a native-resolution variant. It exercises real MediaPipe and ONNX inference, local session results, IndexedDB chronology, strict/development gates, capture lifecycle, sustained playback and explicit fallback/failure cases. Edge supplies a separate live/paused rendering check. Fixtures and reports preserve source/build/model hashes; no model predictions or coach labels are fabricated.

Browser-discovered fixes bound transferred images to one outstanding bitmap, dispose fatal workers and camera resources, expire stale skeletons, align host/worker clocks, prevent frames before session start commits, scale overlays to displayed video dimensions, and respect offline status during outbox recovery. The missing shared grid asset is restored. Regression coverage and remaining evidence limits are in `docs/09_SQUASH_REMAINING_WORK.md`.

## 12. Technical completion on the existing system (2026-10-26)

Re-ID requests now bind to the pinned identity and capture lifecycle, with delayed-result regressions. The browser audit adds real tap/re-pin/unpin gestures and exposed a frame/processing-clock chronology bug, now covered by runtime tests. Clean-checkout tests use committed ONNX fixtures; strict installed-model parity uses a checked-in artifact lock and offline export/restore tools. CI separates those paths. Ensemble model-card lineage now contains actual dataset, split and member checkpoint hashes.

Real-data contrastive pretraining now reads train-only captures; verified warm-start retains a fresh classification head. A local real-data smoke exercises both paths without replacing deployed weights. Replay and annotation artifacts now cover 625 current captures; annotation source verification checks every media/pose hash without inferring human review. See `docs/09_SQUASH_REMAINING_WORK.md`, `tests/models/README.md` and `ml/training/PRETRAINING.md` for results and commands.

## 13. Rollback

Every layer keeps the previous behaviour reachable: legacy sports never touched the Brain; Brain sports can be removed from `BRAIN_SPORTS` to fall back to the relay; the registry retains the previous known-good pack version; the backend v1 routes are additive and the Prisma additions are new tables only.
