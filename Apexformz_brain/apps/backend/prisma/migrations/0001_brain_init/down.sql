-- Rollback for 0001_brain_init, Brain (TRD 13) tables only. Legacy SmartCoach tables are left in place.
-- Order respects foreign keys. Run inside a transaction after a pg_dump.
BEGIN;
DROP TABLE IF EXISTS "CriterionAssessment";
DROP TABLE IF EXISTS "MovementExecution";
DROP TABLE IF EXISTS "SessionEvent";
DROP TABLE IF EXISTS "BrainSession";
DROP TABLE IF EXISTS "AnalysisJob";
DROP TABLE IF EXISTS "ModelRelease";
DROP TABLE IF EXISTS "ObjectAsset";
COMMIT;
-- then: npx prisma migrate resolve --rolled-back 0001_brain_init
