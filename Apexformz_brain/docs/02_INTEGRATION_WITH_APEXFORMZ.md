# Integration with the existing ApexFormz app

Written for: frontend and backend developers connecting the Brain to the original app.

## Connected web project

The sibling `Apexformz` interface is connected through `tools/connect-web-interface.mjs`. Its squash routes use the maintained Brain setup/training adapter, full movement catalog, local model assets, and shared `@apexformz/*` packages. The web backend launcher uses this repository's canonical API with the existing web database and account secrets. See the web project's `BRAIN_INTEGRATION.md` and [backend launcher guide](WEB_BACKEND.md) for startup and additive database preparation.

Authenticated `GET /api/v1/sessions` and `GET /api/v1/sessions/:id` now return complete Brain reviews for history and remote result loading. Completion stores the review and duration alongside the runtime summary, preserves null scores, and supports idempotent retries. Local browser history and event recovery are scoped to the athlete account. `tools/test_web_integration.mjs` exercises real static/dynamic inference, camera pause/resume, a failed-save retry, server-backed result reload, and dashboard history using recorded squash camera input.

## Integration boundary

Connect the current web interface to the shared Brain. The Brain owns recognition (exact movement, supported closest match, group and family), analysis, score eligibility and coaching policy. The interface owns camera controls, session controls and presentation. A future mobile interface must consume the same Brain behavior, model contracts and sport-pack versions through its own platform adapter; it does not need a separately trained "phone Brain".

Today, `@apexformz/runtime` and the other core packages execute inside the web worker through `@apexformz/brain-client`. React uses `useApexBrain` to send input and receive results. Backend APIs handle authenticated sessions, event persistence and asynchronous analysis. This is a shared engine embedded through an adapter, not a deployed central live-inference API. See [Architecture](01_ARCHITECTURE.md) for the boundary and current execution topology.

The current web entry points are `apps/frontend/src/components/brain/BrainTrainingPage.tsx` and the setup/results components. Keep platform integration there; keep recognition and coaching decisions in the Brain. The `platform: 'web'` configuration identifies the execution environment, not a different learned model.

## Existing app routing

| | Legacy sports (cricket, tennis, yoga, running, boxing, football, taekwondo by default) | Brain sports (badminton, shooting, pickleball, table_tennis, squash) |
|---|---|---|
| Pose | MediaPipe Holistic on the main thread | MediaPipe Pose Landmarker inside the Brain worker (CPU fallback) |
| Analysis | Socket.IO relay → Express → FastAPI static/dynamic analyzers | `BrainRuntime` in the worker; no network per frame |
| Output | `FrameAnalysis` (score, issues) | `BrainTick` (quality, features, temporal state, assessment, feedback); adapted to `FrameAnalysis` by `toLegacyFrameAnalysis` for the existing components |
| Persistence | `PoseFrame` rows per frame | Event outbox synced to `/api/v1/sessions/:id/events` (idempotent by event id) |
| Score | Always a number | `null` until coverage and rubric approval allow a score; UI shows "Not scored" |

The switch is `isBrainSport(sport)` from `@smartcoach/types` (legacy shim). Taekwondo has a migrated pack but stays legacy by default; add it to `BRAIN_SPORTS` to trial the pack.

Routing a sport to the Brain does not imply that it has a trained movement classifier. The current learned recognition models are for squash; the other packs provide their configured drill analysis and taxonomy. Recognition preview and coaching rubric approval are separate controls.

## Frontend wiring

```ts
// Existing web-app helper; trust comes from generated build metadata.
import { runtimeConfig } from '@/lib/brain/config';

const brain = useApexBrain({
  createWorker: () => new Worker(new URL('@apexformz/brain-client/worker', import.meta.url), { type: 'module' }),
  config: runtimeConfig('strict'),
  detector: { wasm_base_url: '<tasks-vision wasm>', model_asset_path: '/models/pose_landmarker.task', delegate: 'GPU' },
  detector_in_worker: true,
  packs: () => Promise.all(['badminton'].map((id) => fetchSportPack('/api/brain', id))),
  sync: { transport: httpSyncTransport(`${API}/v1`, getAccessToken) },
});
```

Production builds use the generated Ed25519 public trust registry. Changing coaching or recognition preview mode must not weaken pack signature verification. The example shows base worker wiring; use `BrainTrainingPage.tsx` for the complete current model-loading, session and camera lifecycle.

Per frame: `brain.offerImage(await createImageBitmap(video), { session_id, timestamp_ms: performance.now(), camera_id, mirror: true, orientation })`. The hook exposes `tick`, `lastPose`, `sessionState`, `startInfo` (movement, phase graph, criteria for the UI).

If the worker cannot run the detector, keep detection on the main thread (legacy Holistic hook or `PoseDetectorBridge`) and call `offerPoseFrame` with a `PoseFrame` built by `fromLegacyKeypoints` or `fromPoseLandmarkerResult`.

## Backend wiring

- Create the session with `POST /api/v1/sessions` (SessionStartRequest) so the outbox can sync; the session id is pinned in every event.
- `POST /api/v1/sessions/:id/events` accepts batches and returns `accepted`, `duplicates` and `rejected`; both accepted and duplicates count as committed on the client.
- `POST /api/v1/sessions/:id/complete` receives the `SessionSummary`; XP is duration-based only when `last_score` is `null`.
- Serve packs from `/api/v1/sport-packs/:id/manifest` and `/assets/:asset` (ETag) or let the frontend's own `/api/brain` route read the repo directory.

## Legacy data reuse

- One-Euro filter, phase FSM semantics, tracking-confidence gating and issue persistence were ported from `apps/ai-service/app/services/dynamic`.
- Taekwondo blueprints and expert frames became `sport-packs/taekwondo` (reference-set criteria).
- Hand-authored static blueprints for other sports are intentionally not migrated; they lack provenance.
