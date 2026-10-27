# ApexFormz frontend (Brain edition)

Next.js 14 (App Router) frontend evolved from the original ApexFormz/SmartCoach UI. Every legacy
feature is kept (auth, dashboard, gamification, circles, legacy WebSocket training for cricket,
tennis, yoga, running, boxing, football, taekwondo, paddle) and sport-pack sports (badminton,
shooting, pickleball, table_tennis, squash) are coached **on-device by the ApexFormz Brain**.

## How a Brain session works

1. `/train/<sport>/setup` loads the sport pack (movement catalog + phase graphs) from
   `/api/brain/sport-packs/<sport>/...` (Next route handlers reading the repo `sport-packs/`
   directory), lets the athlete pick a movement, calibrate (camera view, dominant hand, athlete
   level, full-body framing), choose a pose model (see "Pose backends") and a coaching mode.
2. `/train/<sport>?movement=<id>&mode=<strict|development>&backend=<mediapipe|onnx_rtmo>` renders
   `BrainTrainingPage`: camera frames are transferred as `ImageBitmap`s to a module worker
   (`src/workers/brain.worker.ts` → `@apexformz/brain-client/worker`) that runs the chosen pose model
   and the whole Brain pipeline (signal → features → phases → criteria → coaching → repetition estimate).
   The main thread only renders. If the worker cannot start the detector, detection falls back to
   the main thread and PoseFrames are posted to the worker instead.
3. The session is created on the backend (`POST /api/v1/sessions`) when logged in and reachable,
   else it is local-only. Brain events sync asynchronously to `POST /api/v1/sessions/:id/events`
   (exactly-once by event id). On stop the summary is posted to `/complete` and also stored in
   `localStorage` under `brain_session_<id>` so `/results/<id>` works offline.

Frames never leave the device. Only pose-derived events are synced.

## Coaching modes

| Mode | Provisional rubrics | Draft cues | Use |
|------|---------------------|-----------|-----|
| `strict` (default) | abstain: `UNCERTAIN` / `RUBRIC_UNVALIDATED` | never issued | production |
| `development` | evaluated, labelled PROVISIONAL | shown, labelled PROVISIONAL | engineering and coach review |

All current pack thresholds are engineering seeds; the UI shows abstention reasons instead of fake
numbers (`—` / "Not scored" when coverage or rubric gates block a score).

## Pose backends

| Choice | Model | Runtime | Landmarks | Needs |
|--------|-------|---------|-----------|-------|
| `mediapipe` (default; required for squash recognition) | MediaPipe Pose Landmarker full | Installed `@mediapipe/tasks-vision` WASM served locally, GPU delegate → CPU fallback | 33 + estimated depth | `public/models/pose_landmarker_full.task` |
| `onnx_rtmo` | RTMO-s body7 640x640 (OpenMMLab, Apache-2.0) | `onnxruntime-web` 1.30 WebGPU → WASM fallback | COCO-17 (mapped to the 33-slot contract; missing landmarks abstain) | `public/models/rtmo-s_640.onnx` |

```bash
npm run fetch:models    # in apps/frontend: node scripts/fetch-onnx-models.mjs (downloads rtmo-s_640.onnx, writes .sha256)
```

The ONNX backend needs WebGPU for real-time speed (Chrome/Edge 113+); without it onnxruntime-web
falls back to WASM, and if the worker cannot start any detector the page falls back to MediaPipe on
the main thread. `onnxruntime-web` itself is not bundled: `next.config.mjs` aliases it to
`src/lib/brain/ort-shim.mjs`, which loads `ort.webgpu.bundle.min.mjs` from this app's `/runtime/`
directory. `npm run prepare:runtime` copies ORT and MediaPipe WASM assets from the installed packages,
records SHA-256 hashes, and generates matching versioned paths for the shim and detector configuration.
It runs automatically before dev, build, start and typecheck, and makes no network requests. Distribute
`public/runtime/` with the built app. Brain inference needs no CDN access; the local app and model files
must still be reachable (this does not install an offline service worker).

The "Repetitions" tile and the results page show the Brain's class-agnostic repetition estimate
(RepNet-style self-similarity over the pack's features): rep count, period and periodicity. It needs
no sport rules, so it works before any rubric is approved; completed phase-graph executions are shown
next to it.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000/api` | Node backend (auth, legacy sessions, `/v1` Brain API) |
| `NEXT_PUBLIC_SOCKET_URL` | `http://<host>:4000` | Legacy Socket.IO relay for legacy sports |
| `SPORT_PACKS_DIR` | `../../sport-packs` (relative to `apps/frontend`) | Server-side pack directory for `/api/brain/*` |

## Model files

`public/models/pose_landmarker_full.task` and `public/models/rtmo-s_640.onnx` (~38 MB) are gitignored.
Use the same official MediaPipe **full** model as the capture preprocessing pipeline; the older
`pose_landmarker.task` file in the original repository is heavy and must not be substituted. Fetch the
optional RTMO ONNX model with `npm run fetch:models`. Sources, licenses and checksums are listed in
`public/models/README.md`.

## Squash movement recognition

`public/models/squash/index.json` lists up to two artifacts, with paths relative to that index:

```json
[
  { "deployment_url": "static_pose.deployment.json", "model_url": "static_pose.onnx" },
  { "deployment_url": "dynamic_movement.deployment.json", "model_url": "dynamic_movement.onnx" }
]
```

Both load attempts finish before Start is enabled. Missing models show an unavailable state while the
selected drill remains usable. Metadata pins the ONNX digest, classes, preprocessing and calibration;
static models use one observed frame, and dynamic models wait for causal history. Separate cards show
the exact captured movement name, model confidence and abstention reason. Recognition never selects a
coaching movement or treats a label as evidence of correct technique.

Strict mode withholds all provisional outputs. Development mode can show a top probability candidate
as **Model suggestion (unvalidated)** while accepted recognition stays withheld. No UNKNOWN examples
means threshold 1 until suitable held-out calibration evidence is available.

## Pack signature keys

Packs are verified in the worker with the development HMAC key exported by
`@apexformz/sport-runtime` (`dev-local-2026`). Production builds must replace this with the
ed25519 key registry shipped with the core (TRD 13/14); never ship the dev secret.

## Browser requirements

- Module workers (`new Worker(url, { type: 'module' })`) and `createImageBitmap`.
- WebGPU or WebGL for the MediaPipe GPU delegate; the bridge falls back to the CPU delegate, then to
  main-thread detection. The RTMO ONNX backend prefers WebGPU and falls back to WASM.
- `localStorage` for setup and offline summaries (optional).

## Commands

```bash
npm install            # at the repo root
npm run dev --workspace=apps/frontend
npm run build --workspace=apps/frontend
npm run typecheck --workspace=apps/frontend
npm run prepare:runtime --workspace=apps/frontend # local installed JS/WASM assets; no downloads
npm run fetch:models --workspace=apps/frontend   # RTMO ONNX model for the onnx_rtmo backend
```
