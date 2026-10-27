-- Event ids are idempotent within their session, not globally across athletes.
BEGIN;
ALTER TABLE "SessionEvent" DROP CONSTRAINT "SessionEvent_pkey";
DROP INDEX "SessionEvent_session_id_id_key";
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("session_id", "id");

-- Durable retry scheduling and expiring fenced worker claims.
ALTER TABLE "AnalysisJob"
  ADD COLUMN "remote_id" TEXT,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3);
UPDATE "AnalysisJob" SET "next_attempt_at" = "updated_at" WHERE "status" = 'RETRYABLE';
UPDATE "AnalysisJob" SET "lease_expires_at" = CURRENT_TIMESTAMP WHERE "status" = 'RUNNING';
CREATE INDEX "AnalysisJob_status_next_attempt_at_lease_expires_at_idx"
  ON "AnalysisJob"("status", "next_attempt_at", "lease_expires_at");
COMMIT;
