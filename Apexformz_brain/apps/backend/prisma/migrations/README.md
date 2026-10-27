# Prisma migrations

`0001_brain_init/migration.sql` is generated from `schema.prisma` with

```bash
cd apps/backend
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0001_brain_init/migration.sql
```

It creates every table of a fresh deployment: the eleven legacy SmartCoach tables and the seven TRD 13 Brain tables. `migration_lock.toml` pins the provider to PostgreSQL.

`0002_event_scope_job_leases` changes the `SessionEvent` primary key to `(session_id, id)` and adds durable retry dates, expiring worker claims and remote job IDs. This migration is transactional. Existing RUNNING jobs become recoverable; existing RETRYABLE jobs retain their available timestamp. It does not reconstruct retry deadlines lost by the earlier implementation.

`0003_durable_analysis_output` stores completed retrospective analysis output as JSON, so restarting the Python service cannot lose already committed results.

## Fresh database

```bash
cp .env.example .env            # set DATABASE_URL
npx prisma generate
npx prisma migrate deploy
```

## Existing SmartCoach database (legacy tables already present)

Do not apply `0001_brain_init` to existing legacy tables. A database without migration history needs a separately reviewed bootstrap and baseline. Generate the delta against that database without overwriting the committed migration chain:

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > reviewed-bootstrap.sql
```

Review the generated SQL and take a database backup before applying it. Only after the database is verified to match the current schema should all already represented migrations be marked applied with `prisma migrate resolve --applied <migration-name>`. Do not mark the initial migration applied while required Brain tables are still absent. Databases already managed by this migration chain use `prisma migrate deploy` normally.

## Rollback plan

Prisma does not generate down migrations; `0001_brain_init/down.sql` is the hand-written rollback for the Brain tables only (dependency order: `CriterionAssessment`, `MovementExecution`, `SessionEvent`, `BrainSession`, `AnalysisJob`, `ModelRelease`, `ObjectAsset`).

1. `pg_dump` the database (artifact registry and queue backups are covered in `infrastructure/deployment/README.md`).
2. Apply with `npx prisma migrate deploy`.
3. Prefer restoring the verified backup into an isolated replacement database for rollback. `down.sql` removes Brain tables and their data; it is not a production data-preserving downgrade. Prisma's `resolve --rolled-back` concerns failed migrations, not undoing successfully applied migrations.

The three-migration chain was executed on local PostgreSQL 15.19 on 2026-10-26. The isolated integration suite also verifies repeat deploy, concurrent idempotency, transaction rollback, worker recovery, and backup/restore content equality. See `apps/backend/tests/README.md` for the reproducible command. This is local release evidence, not a migration of an existing user database.
