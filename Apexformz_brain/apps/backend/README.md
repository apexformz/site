# ApexFormz Backend (`@apexformz/backend`)

Node 20 / Express / Prisma service evolved from the original SmartCoach backend. It owns auth, athlete sessions, the sport-pack catalog and manifest distribution, event ingestion, progress and analysis job scheduling (TRD 13). It never performs real-time inference: Brain sports run on-device; legacy sports still use the WebSocket relay to the Python ai-service.

## Setup

```bash
# from repo root
npm install
cd apps/backend
cp .env.example .env            # DATABASE_URL, JWT secrets, AI_SERVICE_URL, SPORT_PACKS_DIR
npx prisma generate
npx prisma migrate dev --name brain_v1   # needs PostgreSQL (docker compose in infrastructure/)
npm run dev                              # ts-node-dev on :4000
```

Typecheck: `npx tsc -p tsconfig.json --noEmit`. Tests: `npx vitest run --project backend` from the repo root (pure modules, no database).

## Endpoints

Legacy (`/api/auth`, `/api/users`, `/api/sessions`, `/api/gamification`, `/api/leaderboard`, `/api/circles`, Socket.IO relay) are unchanged except that sport lists accept the Brain sports and the relay refuses to forward frames for them.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/sessions` | Body = `SessionStartRequest` (contract validated). Pins pack/movement. Idempotent on `session_id`. |
| POST | `/api/v1/sessions/:id/events` | Array of `EventEnvelope` (max 500). Exactly-once on `(session_id, event_id)`; returns `{accepted, duplicates, rejected}` with 200. |
| POST | `/api/v1/sessions/:id/complete` | Body `{summary, duration_s?}`. Null `last_score` earns base XP only. |
| GET | `/api/v1/sport-packs` | Installed packs from `SPORT_PACKS_DIR`. |
| GET | `/api/v1/sport-packs/:sportId/manifest` | Strong ETag (sha256), `If-None-Match` -> 304. |
| GET | `/api/v1/sport-packs/:sportId/assets/:asset` | Only assets listed in the manifest; traversal rejected. |
| GET | `/api/v1/model-releases/compatible?core_version=&platform=` | Semver-compatible releases. |
| POST | `/api/v1/analysis/jobs` | 202 `{job_id, status, retry_after_ms}`; requires `consent_scope`. |
| GET | `/api/v1/analysis/jobs/:jobId` | Owner only. QUEUED -> RUNNING -> COMPLETED / FAILED / RETRYABLE. |
| GET | `/api/v1/athletes/:athleteId/progress` | Self only; scores aggregated per rubric version. |

All v1 responses carry `X-API-Version: 1`. API, model, sport-pack and schema versions are independent.

## Job dispatcher

`src/v1/jobs.ts` is a pure state machine (injectable store, HTTP client, clock) used by `src/v1/prismaJobs.ts` against the ai-service (`POST /v1/analysis/jobs`, `GET /v1/analysis/jobs/:id`). Bounded retries (5) with exponential backoff; disable with `ENABLE_JOB_DISPATCHER=false`.

## Rollback

See `prisma/migrations/README.md`. Client outboxes retry idempotently, so no session data is lost across a rollback/re-apply.
