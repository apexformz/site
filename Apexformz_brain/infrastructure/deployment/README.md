# Deployment and local release verification

The backend uses PostgreSQL for sessions, derived assessments, job retries, worker leases and completed analysis results. Redis is not required. The Python analysis service executes jobs; the backend persists the result and resubmits the saved request if that service loses its in-memory state during a restart.

## Local stack

Build from the repository root using `infrastructure/deployment/docker-compose.yml`. Copy the adjacent `.env.example` to `.env` and generate four independent random values for the database password, access-token secret, refresh-token secret and internal service token. Use at least 32 characters for each token secret and a URL-safe hexadecimal database password. Configure the private S3 bucket and local credential-process files described in the operations runbook. The example selects development trust explicitly for the existing provisional packs.

```powershell
docker compose -f infrastructure/deployment/docker-compose.yml --env-file infrastructure/deployment/.env config --quiet
docker compose -f infrastructure/deployment/docker-compose.yml --env-file infrastructure/deployment/.env up --build
```

The database volume is persistent. The one-shot migration service must complete successfully before the backend starts. `/health` is process liveness; `/ready` actually queries PostgreSQL. The services bind exposed ports to loopback. The AI service is reachable only inside the Compose network. Runtime images use non-root users. Only the public trust-registry file is mounted; private signing keys are never included in the service images or mounted by Compose.

Frontend URLs and browser trust are build-time values. Changing them requires rebuilding the frontend; changing a runtime environment variable cannot rewrite browser trust metadata. Restore the ten-file model bundle with `npm run models:restore -- --from <bundle>` before building. `.dockerignore` excludes capture data, environment files, private keys, unpinned optional model binaries and local build caches.

## Signing and release candidates

See `docs/PRODUCTION_PACK_SIGNING.md` and `docs/RELEASE_CANDIDATES.md`. The original development packs stay in `sport-packs/`; production signatures are written to a separate output directory. A valid signature authenticates bytes, not coaching quality. Current model eligibility and coaching metadata still prohibit promotion.

For production, supply `PACK_TRUST_MODE=production`, the vetted public registry as `PACK_TRUST_REGISTRY_JSON`, and `PACK_ROOT` pointing to the separately signed packs. Set real HTTPS public origins. The current local release key needs protected backup and provisioning to an authorized signing environment before remote use. Never put a private key in a `NEXT_PUBLIC_*` value or image build argument.

The backend build emits `apps/backend/dist/server.cjs`, bundling workspace code and schemas while keeping Prisma's native engine external. The frontend emits a Next.js standalone server. The AI image installs the full hash-pinned `requirements.lock` and the local contracts package. A release check receipt binds tests to source and build hashes; the candidate inventory detects changed or extra files. Container verification has its own receipt and is mandatory for promotion.

## Real database checks

Use a PostgreSQL server dedicated to tests. The runner creates a randomly named schema, applies all migrations, reruns deployment to check idempotency, exercises authenticated HTTP and concurrency, boots the actual built backend, and restores a `pg_dump` archive to compare all table contents. It removes only that generated schema.

```powershell
$env:APEXFORMZ_TEST_DATABASE_URL = '<dedicated test connection>'
$env:APEXFORMZ_POSTGRES_BIN = '<directory containing pg_dump and pg_restore>'
$env:APEXFORMZ_PYTHON = '<Python executable with service dependencies>'
npm run db:generate --workspace=apps/backend
npm run build:backend
npm run test:postgres
```

The local Windows verification uses PostgreSQL 15.19 on `127.0.0.1:55432`, with its cluster and credentials under ignored `data/local-postgres/`. Credentials are excluded from reports. This is an isolated test database; no existing user database was migrated. Existing legacy databases require the separate baseline procedure in `apps/backend/prisma/migrations/README.md`.

## Recovery and deployment boundaries

Private S3 upload, version-pinned asset decoding, ownership/consent checks, retention, version purging, remote-result cancellation, scheduled S3 backups, restore drills, CloudWatch metrics and weighted canary rollback are implemented. See `docs/PRODUCTION_SERVICE_OPERATIONS.md` for the API, generated AWS configuration, operational defaults and verification commands.

Docker's Linux engine was restored by preserving and recreating its two broken runtime socket directories. Linux images and an isolated Compose stack now build and run. Existing Docker volumes and the legacy database remain intact. A container check never grants model production promotion by itself.

There is no Git repository/remote configured in this workspace. No hosted CI run or registry push is claimed. S3 resources were created in the authorized AWS account; operational receipts are stored there. New athlete collection, coach review and physical-device testing remain deferred. Public deployment and legacy-database cutover require the target-specific steps in the operations runbook.
