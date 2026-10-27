# ApexFormz Brain — Architecture

Written for: engineers implementing or reviewing the Brain against TRD v1.0.

## One Brain, multiple interfaces

The Brain is the shared engine: model contracts, movement recognition and taxonomy, signal processing, analysis, scoring, coaching rules and session behavior. These responsibilities belong to the Brain regardless of whether an athlete uses the web interface or a future mobile interface. Sport packs and model releases are versioned Brain assets, not separate models trained for each interface.

An interface captures input, supplies session settings and displays the Brain's output. Its adapter translates camera/model-runtime data into the common contracts and handles platform facilities such as workers, local persistence and network transport. Recognition decisions, score eligibility and coaching policy must not be reimplemented in screen components.

```text
Web interface (current) ---- web adapter -------+
                                              +-- Shared Brain core and versioned assets
Mobile interface (future) - mobile adapter ----+
                                              +-- Shared backend services and private storage
```

Logical separation does not require every frame to travel to a server. The current web adapter executes the shared Brain in a browser worker; the backend provides authenticated sessions, persistence and asynchronous analysis. A single hosted service running all live inference is not the current implementation.

The core packages below are separate from React and browser camera APIs. `brain-client` is currently the web adapter; it also contains the reusable causal movement detector orchestration, while hierarchy decisions and model contracts live in `analysis`. A future mobile adapter must reuse that behavior and the same versioned contracts, with a compatible inference backend. Native mobile integration and device validation are still pending.

## Current web execution

```
CAMERA (main thread) --ImageBitmap (transferred)--> WORKER
   WORKER: PoseLandmarker -> PoseFrame -> SignalPipeline -> FeatureEngine -> PhaseSegmenter
           -> CriterionEvaluator -> CoachingPolicy -> BrainTick --postMessage--> UI (render only)
   WORKER: EventOutbox --drain/ack--> OutboxSyncer --POST /api/v1/sessions/:id/events--> Backend
Backend (Express + Prisma): sessions, idempotent event ingestion, pack manifests with ETag,
                            model releases, analysis jobs, athlete progress
AI service (FastAPI): /v1/analysis/jobs retrospective analyzer (zero-phase, marked retrospective)
```

No network call sits on the per-frame path. The latest-frame slot has size one; stale frames are counted as discarded, never queued.

## Packages (shared core, sport-agnostic)

| Package | TRD | Responsibility |
|---|---|---|
| `contracts` | 00/01, WP01 | JSON Schemas, TypeScript types, ajv validators, enums, errors, version compatibility, fixtures. Python mirror in `contracts/python`. |
| `signal` | 03 | Time guard (regression, duplicates, gaps), mirror canonicalization, body-relative normalization (hip-mid origin, torso-length scale, aspect corrected), outlier gate with flagged prediction, One-Euro filtering, duration-bounded `PoseWindow` with masked resampling. |
| `features` | 04 | Pure feature functions (`angle_at`, `line_inclination`, `segment_orientation`, `interjoint_distance_ratio`, `center_of_keypoints`, `landmark_coordinate`, `landmark_offset`, `time_derivative`/`angular_velocity`, `relative_phase_timing`, `stability_variability`, `path_smoothness`, `window_*`, `min_of`/`max_of`), dependency-graph compilation, per-frame cache, typed missingness, view applicability, dominant-side tokens resolved from calibration handedness. |
| `perception` | 02 | Adapters from MediaPipe Pose Landmarker results and legacy pixel keypoints to `PoseFrame`, `SubjectTracker` (ambiguity and track-change detection), framing checks, quality gate, equipment adapter interface. |
| `sport-runtime` | 05 | Pack loading with digest and signature verification, cross-reference validation (movement/graph/criteria/feature/feedback consistency, disallowed cycles, no cross-sport edges), registry (immutable versions, activation only between sessions, known-good rollback, per-session pins, residency cap), router (explicit sport selection; cross-sport access rejected). |
| `analysis` | 10 | `PhaseSegmenter`: IDLE → CANDIDATE → CONFIRMED → EXECUTING → COMPLETE / ABORTED / UNKNOWN driven by the pack's phase graph with hysteresis, minimum durations, timeouts and causal-only evaluation; recognizer interface with open-set thresholds and the ONNX tensor contract. |
| `scoring` | 11 | `CriterionEvaluator`: gating chain (disabled, athlete context, view, capability, contact evidence, quality, feature availability, confidence, contradiction, rubric validation) → PASS / IMPROVE / UNCERTAIN / NOT_ASSESSABLE / NOT_APPLICABLE, phase accumulators, reference-set evaluator, coverage-gated weighted score. |
| `coaching` | 11 | `CoachingPolicy`: setup/safety instructions first, stability guard, priority rank, cooldowns, one primary cue at a time, phase-gated timing, positive reinforcement, repeated-error rationale. |
| `runtime` | 01, 13 | `BrainRuntime` orchestrator, session state machine, latest-frame slot, degraded/revalidation logic, bounded event outbox, telemetry, idempotent ingestion ledger. |
| `brain-client` | 01, 13 | Worker protocol and entry, PoseLandmarker bridge, host `BrainClient`, `useApexBrain` React hook, outbox syncer, legacy UI adapter. |

## Coordinate systems

`image_normalized` (0..1, origin top-left, view dependent) → canonicalized exactly once when `mirror` is true (x → 1−x, left/right ids swapped) → `body_relative` (aspect-corrected pixels minus hip midpoint, divided by torso length). `estimated_world` from the pose model is carried but not used for criteria; `calibrated_world` requires a documented calibration and is not produced yet, so no metric speeds are ever emitted.

## Error semantics

Missing or occluded data is `value: null` with a `MissingReason`. Recoverable failures are `BrainError` with `recoverable: true`; unknown model ids, incompatible contracts, digest or signature failures and schema violations are rejected closed (`recoverable: false`).

## Observability

Each tick carries per-stage durations (EMA and max), queue age, discarded frames, dropped inferences, abstention reasons, unknown-movement rate, criteria coverage and executed packs. No images or identifying media are logged.
