# PostgreSQL and AI-service integration

Run from the repository root:

```powershell
$env:APEXFORMZ_TEST_DATABASE_URL = 'postgresql://test_user:test_password@127.0.0.1:5432/apexformz_test'
npm run db:generate --workspace=apps/backend
npm run build:backend
node tools/test_backend_postgres.mjs
```

Supply a test database and a user allowed to create schemas. Do not point this at
a production database. The runner ignores the connection's schema setting,
creates a random `apexformz_it_<uuid>` schema, applies the actual migration chain,
runs the dedicated suite, backs up and restores that schema, and drops only that
generated schema. There is no `migrate reset`, database drop or public-schema
cleanup. It fails if the connection, required tools or tests are unavailable;
tests cannot silently skip. Fixture users and pose sequences are synthetic.

Requirements:

- Installed Node dependencies and Prisma CLI/client.
- The built `apps/backend/dist/server.cjs`. The runner starts that distributable and checks database readiness, authentication, persisted registration and verified pack serving in addition to the source-level integration suite.
- PostgreSQL and matching-or-newer `pg_dump` / `pg_restore` clients. Set
  `APEXFORMZ_POSTGRES_BIN` to their directory when they are not on PATH.
- Python with `fastapi`, `uvicorn`, `pydantic`, `numpy`, `scipy` and the local
  contracts package dependencies. `APEXFORMZ_PYTHON` overrides the interpreter;
  otherwise the runner uses the local `.venv` when present, then `python`.

The suite starts a temporary loopback HTTP server for the authenticated Express
router and a temporary Python host for the production FastAPI analysis-job
router. It verifies JWT authentication and ownership, concurrent session
creation, duplicate event ingestion and derived-row atomicity, transactional
session completion/rewards, leased queue claims, persisted retry deadlines,
stale-worker fencing, and recovery after an actual Python service restart.
The CPU retrospective analyzer processes a real JSON feature bundle made from
synthetic poses. Completed output is stored in `AnalysisJob.output` and remains
available through the authenticated job endpoint after the Python process ends.
Structured Python errors are persisted as readable strings.

`POST /api/v1/analysis/jobs` accepts a consented inline `feature_bundle` of valid
PoseFrame objects (up to 5,000 frames, also bounded by the HTTP body limit).
Optional `handedness`, `view` and `capabilities` are retained for the analyzer.
Reference-only video/feature decoding remains unavailable in the Python deep
analysis route; such jobs explicitly fail `MODEL_UNAVAILABLE`. No media-fetching
or object-storage credentials are inferred from a reference.

Queue claims use expiring leases and unique tokens. A worker can commit only
while its token still owns the RUNNING job. Expired claims can be recovered by
another process; a persisted remote ID resumes polling. A remote 404 clears that
ID and retries the original durable request with the same job ID. Network
failures retain the remote ID, and retries remain bounded. `stop()` stops new
claims; in-flight jobs may finish, or their leases expire after a process exit.

Timestamped evidence and the fixture-only PostgreSQL archive are written under
`data/audit/postgres/`. The report verifies row counts and content hashes for
every restored table and records successful schema cleanup. The PostgreSQL
server itself is owned and stopped by the caller, not by the test runner.
