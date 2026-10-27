# Backend for the Apexformz web interface

The web interface uses this repository's canonical backend for accounts, legacy APIs, and Brain `/api/v1` sessions. Live squash inference executes in the browser worker; the Python service is not needed for live squash training.

From this repository, with the projects in sibling directories:

```powershell
node tools/web-backend.mjs db:generate
node tools/web-backend.mjs db:plan
node tools/web-backend.mjs db:prepare
node tools/web-backend.mjs dev
```

Use `--web-root "C:\path\to\Apexformz"` when the interface lives elsewhere. The launcher reads that project's `apps/backend/.env`; explicit process environment variables take precedence. It does not copy or print secrets. Existing account tokens remain compatible when the existing database and JWT secrets are retained. The default API port is 4000, and the default allowed web origin is `http://localhost:3000`.

`SPORT_PACKS_DIR` defaults to this Brain repository's sport packs. If explicitly supplied, a relative path is resolved from the web backend directory. Retrospective job dispatch is off unless `ENABLE_JOB_DISPATCHER=true` is explicitly configured. Production startup still applies the Brain's secret, origin, and pack-signing validation.

## Existing web database

The committed initial migration creates legacy tables as well as Brain tables, so running it directly over an existing web database causes conflicts. `db:plan` prints the schema delta without changing the database. Keep a database backup before schema changes.

`db:prepare` is an explicit bootstrap command. It regenerates the delta and applies it only if every statement creates a new table, schema, or an index/foreign key on a table created by that same plan. It refuses modifications to existing tables, table/column deletion, data changes, or unsupported SQL before execution. Allowed statements run in one transaction. It neither resets the database nor edits migration history.

If preparation refuses a plan, use the reviewed migration/baseline workflow in [the migration guide](../apps/backend/prisma/migrations/README.md). A database already managed by the Brain migration chain should continue to use `prisma migrate deploy` with its configured environment. Preparation never runs automatically on application startup.

## Build and verification

```powershell
node tools/web-backend.mjs typecheck
node tools/web-backend.mjs build
node tools/web-backend.mjs start
node --test tools/web-backend.test.mjs
```

`build` and `start` use the Brain backend's own scripts and bundled server. `db:generate` generates the client against the Brain schema. Stop the running backend before regenerating Prisma on Windows, where a loaded native engine can lock the generated client.

`/health` checks the HTTP service; `/ready` also checks the database connection. Neither endpoint proves tables have been prepared. Authenticated session create, event ingestion, completion, history, and results are the integration checks for Brain persistence.
