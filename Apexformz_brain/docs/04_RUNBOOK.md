# Runbook

Written for: developers setting up, testing and releasing the Brain locally.

## Prerequisites

Node 20+, npm 10+, Python 3.11+ (3.14 used here), optional Docker for Postgres/Redis.

## Install

```bash
cd Apexformz_brain
npm install
pip install -e packages/contracts/python
pip install -r apps/ai-service/requirements.txt
```

## Verify

```bash
npm run typecheck          # all TypeScript packages and tests
npm test                   # unit + golden (G01-G10) + contracts + backend projects
npm run validate:packs     # load every pack with digest and signature checks
npm run py:test            # Pydantic parity, ai-service, ml
npm run bench -- 20 30     # 20-minute synthetic session at 30 FPS (writes tests/performance/results)
```

## Sport packs

Edit the JSON under `sport-packs/<sport>/`, then re-seal:

```bash
npm run seal:packs         # recomputes sha256 asset_hashes and signs manifests with the dev key
npm run validate:packs
```

Regenerate the squash pack's generated files (movements, graphs, criteria, cues, provenance, manifest) with `npm run gen:squash-pack`; its court, rules and equipment files are hand-written from the WSF documents and must be edited directly. Regenerate the two generated seed packs with `npm run gen:seed-packs`; regenerate the taekwondo migration with `python tools/migrate_taekwondo_pack.py <path-to-original-Apexformz>`.

Training data for a sport: extract pose JSONL (`npm run extract:real` or the perception service), then `npm run extract:features -- --pack squash --view back --handedness right --in <pose.jsonl> --out features.jsonl` to get per-frame features from the deployed feature engine; see `ml/sports/squash/README.md` for the rest of the pipeline.

Database: `apps/backend/prisma/migrations/README.md` covers fresh deployments (`prisma migrate deploy`), the delta path for an existing SmartCoach database, and the hand-written rollback.

Production signing: set `APEXFORMZ_PACK_SIGNING_KEY_ID` and `APEXFORMZ_PACK_SIGNING_SECRET` for the backend and the worker config; replace HMAC with ed25519 once the key registry exists.

## Run the apps

```bash
# database
docker compose -f infrastructure/deployment/docker-compose.yml up postgres redis
cd apps/backend && cp .env.example .env && npx prisma migrate dev --name brain_v1 && cd ../..
npm run dev                # backend :4000 + frontend :3000
cd apps/ai-service && uvicorn main:app --port 8000
```

The frontend serves sport packs from `/api/brain/...` directly from the repo, so Brain sports work without the backend; cloud sync and progress need the backend.

## Rollback

- Pack: `registry.rollback(sportId)` returns to the newest known-good version; on disk, revert the pack directory and re-seal.
- Backend: v1 routes are additive; disable the job dispatcher with `ENABLE_JOB_DISPATCHER=false`; Prisma down-migration notes live in `apps/backend/prisma/migrations/README.md`.
- Frontend: remove a sport from `BRAIN_SPORTS` in `packages/legacy-types/index.ts` to send it back to the legacy relay.

## Release gates

See `infrastructure/monitoring/release_gates.md`: golden-sequence diff report, model card, provenance, migration plan, privacy assessment, canary protocol and rollback runbook are all required before a production release.
