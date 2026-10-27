-- Existing assets are quarantined until ownership, S3 version, consent and hash are reviewed.
ALTER TABLE "ObjectAsset"
  ADD COLUMN "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
  ADD COLUMN "byte_size" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "version_id" TEXT,
  ADD COLUMN "consent_scope" TEXT NOT NULL DEFAULT 'deep_analysis',
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'QUARANTINED',
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "delete_after" TIMESTAMP(3),
  ADD COLUMN "deleted_at" TIMESTAMP(3);
CREATE INDEX "ObjectAsset_status_expires_at_delete_after_idx" ON "ObjectAsset"("status", "expires_at", "delete_after");
