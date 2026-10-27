# S3 service operations

The runtime uses Amazon S3 for private asset bodies, PostgreSQL backup archives, telemetry snapshots, deletion tombstones and release/canary receipts. PostgreSQL remains the transactional store for users, ownership, sessions and durable jobs. Container layers and bounded decoding scratch files are local execution caches, not an alternative asset store.

## Resources and boundaries

See infrastructure/deployment/aws-storage.json for the verified AWS account, region and newly created buckets. The primary bucket has public access blocked, ACLs disabled, TLS required, SSE-S3 encryption and versioning. Access logs go to a separate private bucket to avoid recursive logging. This deployment has CloudWatch health, backlog, expired lease, pending deletion and backup-age alarms.

S3 storage, requests, logs, egress and CloudWatch metrics/alarms incur usage charges. No public production endpoint, registry publication, coach approval or model promotion is implied by this engineering verification. CloudTrail S3 data events should be attached to the account's encrypted audit trail before public production. Alarm states are available in CloudWatch; an on-call notification destination is not configured.

The runtime IAM policy is generated from actual SDK calls using IAM Policy Autopilot, then narrowed to the exact project bucket and metric namespace. Optional ACL, retention-bypass, KMS and Object Lambda grants were removed. The exact policy is infrastructure/deployment/runtime-policy.json. Local credentials use a protected directory and an expiring role session; they are not in images, source archives, audit output or frontend bundles. A production host should use its managed workload role rather than this operator-login bridge.

## Private asset API

All routes require a user bearer token.

1. POST /api/v1/assets with Content-Type application/octet-stream, binary body, X-Asset-Content-Type, X-Content-SHA256 (lowercase hexadecimal SHA-256), and X-Consent-Scope (deep_analysis or quality_improvement).
2. Send the returned opaque asset_ref to POST /api/v1/analysis/jobs with the pack/version/movement and the same consent scope. Arbitrary URLs, foreign assets, expired assets and mismatched consent are rejected.
3. GET /api/v1/assets/:id/download returns a version-pinned download URL valid for 60 seconds, only for the owner.
4. DELETE /api/v1/assets/:id immediately denies new access and cancels durable jobs. A retention sweep permanently deletes every object version, removes cached remote analysis output and records completion.

Uploads are limited to 64 MiB and verified against SHA-256 before becoming READY. Accepted types are JSON PoseFrame arrays, MP4, WebM, JPEG and PNG. JSON bundles contain at most 5,000 validated frames. Media uses the existing locked MediaPipe full model; videos are limited to 120 seconds and 8.5 megapixels, images to 16 megapixels. Up to 3,600 video frames are sampled across the clip. Missing or ambiguous subjects do not become confident assessments. Research APIs accepting arbitrary local file paths are disabled in production.

Default retention is 7 days for deep analysis and 30 days for quality improvement. These operational defaults need product/privacy review before public launch. A just-created upload has a five-minute deletion fence to cover an in-flight upload; the sweep runs every minute. A previously issued download URL may remain usable until its 60-second expiry. S3 lifecycle expiry is a backstop, not proof of immediate erasure.

Deletion tombstones are retained so that restoring an older database cannot resurrect deleted assets or derived analysis. Backups expire after 35 days; restoration must reapply tombstones before serving traffic. The AI result cache expires after 15 minutes and ignores late writes for cancelled jobs.

## Compose and verification

The verified project name is apexformz-ops. Its new PostgreSQL volume is separate from the existing smartcoach-db. Local ports are frontend 3100, backend 4100, PostgreSQL 55433 and the canary gateway 4102. The AI service is internal only. The generated environment is under ignored data/audit/operations/compose.env; never commit it.

Run from the repository root:

    docker compose -p apexformz-ops -f infrastructure/deployment/docker-compose.yml --env-file data/audit/operations/compose.env --profile operations up -d

The operations service publishes a health snapshot every minute, writes snapshots to S3, and creates a PostgreSQL backup daily. Every backup is downloaded by version, SHA-256 checked, restored to a generated disposable database, and checked after deletion-tombstone replay. Temporary restore databases are removed. Missing metrics and stale backups alarm rather than reporting success.

The local credential bridge is tools/runtime_credentials.py --loop. It refreshes the scoped one-hour role session while the operator's AWS login remains valid. Reauthenticate when that session expires. Stopping this machine also stops its Compose monitoring and backup worker; an always-on production host remains necessary.

Live checks:

    python tools/test_s3_stack.py
    python tools/canary_rollout.py --candidate-image <local-image-id> --inject-failure --out data/audit/operations/canary-rollback-drill.json

Only generated non-personal fixtures are uploaded by the integration test. It verifies private access, owner isolation, JSON and real media decoding, durable output, expiry, deletion of all S3 versions and removal of derived results. It also restores a backup taken before deletion, reapplies the deletion ledger, and verifies that the restored analysis input/output has been erased.

The final evidence is data/audit/operations/operations-completion.json, also saved under releases/verification/ in S3. It records actual image IDs, live endpoint responses, five alarm states, recent health samples, backup versions, test evidence hashes and rollback results. The current source and safe operations evidence are backed up by tools/archive_operations_s3.py; its receipt is operations-source-s3-archive.json. This source backup is separate from the earlier engineering baseline archive containing locked model binaries. Neither archive is a production approval.

The canary drill resolves an immutable local backend image, routes 10% through a real Nginx gateway, observes both upstreams, deliberately stops the candidate, and verifies stable routing after rollback. It always returns to stable; it does not grant model production eligibility or promote a release. Application/schema changes must remain backward compatible during a rollout.

## Legacy database baseline

The existing smartcoach-db has 11 legacy tables and no Brain migration chain. The read-only schema export, additive SQL delta and review receipt are under data/audit/operations/legacy-*. The delta adds seven Brain tables. tools/review_legacy_database.mjs applied it to a disposable schema-only copy, verified zero Prisma drift, marked the four represented migrations, and confirmed a repeated deployment has no work. tools/backup_legacy_s3.py also backed up the actual legacy database to private S3, downloaded and restored that exact version, applied the additive delta to a disposable data-bearing clone, and verified all 11 legacy table counts and content hashes were unchanged. The source database was not modified.

Do not run fresh migration 0001 against that existing database. For actual cutover: identify and back up the intended database to S3, check the schema still matches the reviewed export, review the generated delta, apply it transactionally during the cutover, compare data/integrity, and only then mark the represented migrations. The source database has not been modified by the review.

## Docker recovery

Docker Desktop 4.52.0 was blocked by inaccessible Windows socket reparse points in its run directory and docker-secrets-engine directory. Both directories were preserved with .stale timestamps and recreated; image and volume data were untouched. Disabling the optional Model Runner alone did not fix the issue; it was re-enabled after recovery. The Linux engine now runs and the images have been built and exercised.

If this Windows-specific socket problem recurs, stop Docker completely, inspect the error's exact socket directory and preserve/recreate only that runtime directory. Do not factory-reset Docker or delete volumes. The original settings backup is in ignored audit storage.

## Remaining production cutover work

New athlete data, coach validation and physical-device testing remain deferred. Infrastructure verification does not change provisional model thresholds, commercial weight-license restrictions or rubric approvals.

A real public deployment still needs its target host/domain, TLS ingress, workload identity, production database least-privilege accounts, notification recipients, signing-key custody, account audit-trail configuration and an approved cutover of any legacy database. Existing private capture archives have not been bulk-migrated or deleted.

