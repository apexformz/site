# Squash web integration

This web project now uses the sibling `Apexformz_brain` project as the source of its squash engine, model assets, browser adapter, and backend. Keep the two projects beside each other. The web interface retains its accounts, dashboard, public pages, and legacy sports; squash uses the full Brain workflow.

## Start locally

From the `Apexformz` directory:

```powershell
npm install
npm run db:plan
npm run db:prepare
npm run dev
```

The database must be running at the address in `apps/backend/.env`. `db:prepare` adds missing Brain tables only and refuses changes to existing tables. It is safe to rerun; it never resets the database. Existing accounts use the same database and JWT settings. The Python AI service is not needed for live squash.

The frontend normally uses port 3000 and selects another available port during development if it is occupied. To choose port 3001 explicitly, start `npm run dev:backend` in one terminal and `npm run dev:frontend -- --port 3001` in another. The browser talks to `/api` on its own origin; Next proxies account and session requests to the backend on port 4000. `APEXFORMZ_API_ORIGIN` changes that backend origin at build/dev startup.

## Squash journey

1. Open `/train/squash/setup`. Search or browse the 184 pack-defined movements, including static positions and dynamic drills.
2. Set the camera view, dominant hand, and athlete level. Choose recognition preview or reviewed recognition only, independently of reviewed coaching or coaching preview.
3. Enter the studio, enable the camera, and start a session. Pose detection, static/dynamic recognition, tracking, phase analysis and coaching run in browser workers. Tap the athlete to pin tracking when needed.
4. Finish the session to see measurements, criterion outcomes, repetitions, and reasons feedback was withheld. Account-backed results also appear in the dashboard and reload from the server on another browser.

An unavailable technique score is displayed as **Not scored**, never as zero or a fabricated technique verdict. Squash criteria remain provisional. Recognition preview can name movements while reviewed coaching withholds unapproved scores/cues. Unscored sessions earn duration-based XP; score-based enhanced streaks still require an eligible score.

Guest results stay on that browser. Signed-in sessions can continue locally if the connection drops; results show a pending account save and a retry button. Pending data is scoped to its athlete account. No raw camera frames are uploaded by this flow.

## How source updates reach the website

`prepare:brain` copies the maintained browser adapter, both worker entry points and checksum-bound squash/re-identification models from the Brain. It stages installed MediaPipe/ONNX runtimes locally. The core `@apexformz/*` dependencies are file links to the sibling packages. Preparation runs before development, typechecking, and building. Generated adapter directories should be edited in the Brain source and refreshed with `npm run prepare:brain`.

The web build owns its generated runtime and pack-trust metadata. Startup does not overwrite a compiled build's assets. Production builds require an active production signing registry and appropriately signed packs, following the Brain's production signing guide. To verify an optimized **local** build against the existing development packs:

```powershell
$env:NEXT_PUBLIC_PACK_TRUST_MODE = 'development'
$env:APEXFORMZ_PACK_TRUST_MODE = 'development'
npm run build
npm run start --workspace=apps/frontend -- --port 3001
```

Do not use these local development trust settings for a public production deployment. The optional `docker-compose.brain.yml` is also explicitly a local recipe; see `infrastructure/docker/README.md`. It reuses the existing database and does not manage or remove its volume.

## Validation and recovery

From the Brain directory, `node tools/test_web_integration.mjs` exercises the actual website with Chrome and an existing recorded squash camera fixture. It creates a temporary account, runs real model inference, checks completion/history/remote results, and removes its own test account. The report and screenshots are under `data/audit/web-integration/`. This verifies integration, not independent athlete accuracy or a physical camera.

`node tools/connect-web-interface.mjs --apply` installs the integration overlay into the sibling interface and keeps each overwritten file under `.brain-integration-backups/`. A pre-integration database backup is stored privately in the Brain's `data/local-backups/`. Neither path is committed. Existing Brain deployment and signing instructions continue to apply.

Windows demo restart: run npm run demo from the web project. It starts Docker Desktop if necessary, starts the existing smartcoach-db container and waits for PostgreSQL before launching the API and interface. Wait for both servers to report ready.
