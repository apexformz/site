# ApexFormz Brain

Hybrid, local-first sports coaching runtime built from the ApexFormz Brain TRD v1.0 (`trd_docs/`). The shared Brain owns perception, time, normalization, generic biomechanics, temporal recognition, evidence fusion and the coaching workflow. Sport packs own every court dimension, rule, movement, phase graph, rubric and cue. The original ApexFormz app is reused and extended, not replaced.

## Repository map (TRD 00 "Implementation map")

```
apps/            frontend (Next.js, Brain worker + legacy flows), backend (Express + Prisma, /api/v1), ai-service (FastAPI, retrospective jobs)
packages/        contracts, signal, features, perception, sport-runtime, analysis, scoring, coaching, runtime, brain-client, legacy-types
sport-packs/     squash (first training sport: WSF court + rules approved; 184 movements in 14 families and 50 groups measured on the labeled recordings; 848 provisional criteria); badminton, shooting, pickleball, table_tennis (seeds); taekwondo (legacy migration)
ml/              datasets, training (causal TCN), evaluation, export (ONNX)
tests/           golden (G01-G10), contracts (TS/Python parity), performance (sustained-session bench)
infrastructure/  deployment (docker-compose), monitoring (metrics, alerts, release gates)
tools/           pack generators (incl. gen_squash_pack.py), feature extraction for training (extract_features.ts), the taekwondo migration
ml/sports/squash/ training-readiness kit for the first sport (label schema, manifest template, configs, threshold fitting)
docs/            change map, architecture, integration guide, unresolved validation, runbook
```

## Work packages

| WP | Output | Where |
|---|---|---|
| WP01 | JSON Schemas + TypeScript/Pydantic validators, shared fixtures | `packages/contracts`, `packages/contracts/python`, `tests/contracts` |
| WP02 | Camera/pose worker, latest-frame slot, duration-bounded window, monotonic time guard | `packages/brain-client/src/worker.ts`, `packages/runtime`, `packages/signal` |
| WP03 | Pose adapters, subject tracking, framing and quality gates | `packages/perception` |
| WP04 | Normalization, One-Euro filtering, outlier gate, feature catalog with typed missingness | `packages/signal`, `packages/features` |
| WP05 | Pack schema, digest/signature verification, cross-validation, registry, router | `packages/sport-runtime`, `sport-packs/*` |
| WP06 | Heuristic phase segmenter with the TRD recognition states, recognizer/ONNX contract, TCN skeleton | `packages/analysis`, `ml/training` |
| WP07 | Criterion evaluator with abstention, coverage-gated score, coaching policy | `packages/scoring`, `packages/coaching` |
| WP08 | Session persistence, outbox sync, manifests, analysis jobs | `packages/runtime`, `apps/backend/src/v1`, `apps/ai-service/app/brain` |
| WP09 | Athlete-disjoint splits, metrics, export | `ml/` |
| WP10 | Signed packs, release gates, benchmark harness, docker deployment | `infrastructure/`, `tests/performance` |

## Perception and tracking stack (phase 2)

Industry models sit behind contract-typed interfaces (`PoseFrame`, `TrackSet`, `EquipmentObservation`); see `docs/05_PERCEPTION_TECH_STACK.md` for the decision matrix with licenses.

- Live (worker): MediaPipe Pose Landmarker or RTMO/RTMPose ONNX via onnxruntime-web (WebGPU, WASM fallback), ByteTrack subject identity, RepNet-style class-agnostic repetition counting.
- Server (`apps/ai-service`, `packages/perception-py`): RTMPose/RTMW/DWPose/ViTPose through rtmlib, Google DeepMind TAPNet point trackers (BootsTAPIR offline and causal online, TAPNext++), Meta SAM 2.1 object tracking for implements and projectiles, Meta CoTracker3 (non-commercial, opt-in), MotionBERT and VideoPose3D 2D-to-3D lifting (the latter non-commercial), zero-phase smoothing marked retrospective.
- Learning (`ml/`): causal TCN baseline, ST-GCN++ challenger, contrastive pretraining, open-set threshold calibration, ONNX export with model cards.

## Golden fixtures (TRD 15)

G01 collinear elbow = 180°, G02 degenerate segment → `null` + `DEGENERATE_GEOMETRY`, G03 time gap resets temporal state with no invented velocity, G04 mirrored sequence keeps semantics and the mirror flag, G05 second person → `AMBIGUOUS_SUBJECT` and suppressed coaching, G06 only the selected pack executes, G07 unobserved contact → `NOT_ASSESSABLE`, G08 digest mismatch rejected with known-good retained, G09 exactly-once ingestion by event id, G10 version pinned during an active session. All in `tests/golden/golden.test.ts`.

## Squash engine (first trained sport)

`sport-packs/squash` holds the WSF court specification and the 2025 singles rules as approved, cited data, plus every labeled movement in the Data Capture catalog (70 static poses, 112 dynamic movements) and the pack-defined serve and return. Movements are organised family -> group -> movement by similarity measured on the recordings (`docs/08_SQUASH_TAXONOMY.md`); recognition reports the group or family when near-identical movements cannot be told apart. Every movement has a phase graph and criteria from the template matching its catalog instruction, and every recorded static position an expert-reference posture check. Rebuild everything with `npm run build:squash-engine`. `docs/06_SQUASH_DOMAIN.md` explains what a camera can observe in squash, the camera setup and the capture protocol for the coaches' static and dynamic recordings; `ml/sports/squash/` is the training kit. `tests/golden/squash.test.ts` drives the lunge, drive and ready graphs end to end.

## Human variance

Athletes never repeat a movement exactly and the camera measurement has a floor, so the Brain does not correct every small excursion. Each sport pack declares a variance profile (squash: 5 percent baseline, wider for racket-arm and derivative features, scaled by athlete level); deviations inside the band are reported as UNCERTAIN with reason WITHIN_NORMAL_VARIANCE and never spoken, a single off repetition inside the athlete's own spread is not corrected, and a consistent fault is. The shared core carries no variance numbers. Research and model: `docs/07_HUMAN_VARIANCE.md`.

## First vertical slice

- Static: `shooting.setup_stance` (hold detection, stance width, trunk lean, elbow extension, shoulder level, wrist stability; sight alignment abstains without hardware).
- Dynamic: `badminton.lunge` (ready → drive → bottom [estimated contact] → recovery; knee depth, knee-over-foot, trunk lean from the side view only, recovery time, racket-arm extension, leg-before-arm sequencing; racket contact abstains).

In strict mode (production default) every provisional rubric returns `UNCERTAIN` with reason `RUBRIC_UNVALIDATED` and no cue is spoken. Development mode evaluates the seeds and labels everything provisional.

## Commands

```bash
npm ci && pip install -e packages/contracts/python
npm run typecheck && npm test && npm run validate:packs && npm run py:test
npm run bench -- 20 30        # synthetic 20-minute session
npm run dev                   # backend :4000 and frontend :3000
```

## Status and honesty

Every technique threshold in the packs is provisional (`docs/03_UNRESOLVED_VALIDATION.md`). No coaching rule or technique cutoff is approved. The only approved pack data are the squash court dimensions and competition rules, which are transcribed from the WSF documents cited in the pack's provenance. Installed squash recognition covers 68 static and 109 dynamic labels; the dynamic model is a TCN/ST-GCN++ ensemble. Recorded replay uses 625 identity-corrected captures. Production browser checks execute actual MediaPipe, ONNX, camera lifecycle and pin gestures on recorded fake-camera input; physical-camera and independent-athlete accuracy remain unvalidated. See [current engineering status](docs/09_SQUASH_REMAINING_WORK.md).

Ordinary `npm test` uses checked-in ONNX fixtures and needs no model binaries. `npm run test:models` strictly verifies the installed models; `models:verify`, `models:export` and `models:restore` reproduce the exact local artifact set. See [model test instructions](tests/models/README.md). Real-data contrastive pretraining and verified encoder warm-start are documented in [the pretraining guide](ml/training/PRETRAINING.md).
