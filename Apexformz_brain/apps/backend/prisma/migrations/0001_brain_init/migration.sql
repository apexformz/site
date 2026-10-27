-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "preferred_sport" TEXT NOT NULL DEFAULT 'cricket',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStats" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "longest_streak" INTEGER NOT NULL DEFAULT 0,
    "total_sessions" INTEGER NOT NULL DEFAULT 0,
    "best_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_session_date" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achievement" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "earned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Achievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingSession" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "duration_s" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "feedback_summary" TEXT NOT NULL DEFAULT '',
    "xp_earned" INTEGER NOT NULL DEFAULT 0,
    "frame_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoseFrame" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "timestamp_ms" INTEGER NOT NULL,
    "keypoints" JSONB NOT NULL,
    "angles" JSONB NOT NULL,
    "feedback" JSONB NOT NULL,
    "frame_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoseFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardEntry" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "weekly_xp" INTEGER NOT NULL DEFAULT 0,
    "all_time_xp" INTEGER NOT NULL DEFAULT 0,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnhancedStreak" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "longest_streak" INTEGER NOT NULL DEFAULT 0,
    "risk_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "save_tokens" INTEGER NOT NULL DEFAULT 0,
    "identity_tier" TEXT NOT NULL DEFAULT 'Novice',
    "last_valid_session" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnhancedStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shared_streak" INTEGER NOT NULL DEFAULT 0,
    "circle_health" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Circle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleMember" (
    "id" TEXT NOT NULL,
    "circle_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleActivity" (
    "id" TEXT NOT NULL,
    "circle_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "posture_score" DOUBLE PRECISION NOT NULL,
    "improvement_delta" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "duration_s" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrainSession" (
    "id" TEXT NOT NULL,
    "athlete_id" TEXT NOT NULL,
    "sport_id" TEXT NOT NULL,
    "pack_version" TEXT NOT NULL,
    "movement_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "summary" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrainSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "monotonic_ms" DOUBLE PRECISION NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_schema" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sequence" INTEGER,
    "ingested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MovementExecution" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "movement_id" TEXT NOT NULL,
    "start_ms" DOUBLE PRECISION NOT NULL,
    "end_ms" DOUBLE PRECISION,
    "model_versions" JSONB NOT NULL,
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MovementExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CriterionAssessment" (
    "id" TEXT NOT NULL,
    "execution_id" TEXT,
    "session_id" TEXT NOT NULL,
    "criterion_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "rubric_version" TEXT NOT NULL,
    "evidence_ref" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriterionAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRelease" (
    "id" TEXT NOT NULL,
    "sport_id" TEXT NOT NULL,
    "semver" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "compatibility" JSONB NOT NULL,
    "rollout" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "asset_ref" TEXT,
    "consent_scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "output_ref" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "request" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectAsset" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "retention_policy" TEXT NOT NULL,
    "encryption_metadata" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObjectAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "UserStats_user_id_key" ON "UserStats"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "Achievement_user_id_type_key" ON "Achievement"("user_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardEntry_user_id_sport_key" ON "LeaderboardEntry"("user_id", "sport");

-- CreateIndex
CREATE UNIQUE INDEX "EnhancedStreak_user_id_key" ON "EnhancedStreak"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "CircleMember_circle_id_user_id_key" ON "CircleMember"("circle_id", "user_id");

-- CreateIndex
CREATE INDEX "BrainSession_athlete_id_sport_id_idx" ON "BrainSession"("athlete_id", "sport_id");

-- CreateIndex
CREATE INDEX "SessionEvent_session_id_sequence_idx" ON "SessionEvent"("session_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "SessionEvent_session_id_id_key" ON "SessionEvent"("session_id", "id");

-- CreateIndex
CREATE INDEX "MovementExecution_session_id_idx" ON "MovementExecution"("session_id");

-- CreateIndex
CREATE INDEX "CriterionAssessment_session_id_criterion_id_idx" ON "CriterionAssessment"("session_id", "criterion_id");

-- CreateIndex
CREATE UNIQUE INDEX "ModelRelease_sport_id_semver_key" ON "ModelRelease"("sport_id", "semver");

-- CreateIndex
CREATE INDEX "AnalysisJob_status_updated_at_idx" ON "AnalysisJob"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectAsset_storage_key_key" ON "ObjectAsset"("storage_key");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStats" ADD CONSTRAINT "UserStats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achievement" ADD CONSTRAINT "Achievement_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingSession" ADD CONSTRAINT "TrainingSession_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoseFrame" ADD CONSTRAINT "PoseFrame_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "TrainingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardEntry" ADD CONSTRAINT "LeaderboardEntry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnhancedStreak" ADD CONSTRAINT "EnhancedStreak_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_circle_id_fkey" FOREIGN KEY ("circle_id") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "BrainSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovementExecution" ADD CONSTRAINT "MovementExecution_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "BrainSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriterionAssessment" ADD CONSTRAINT "CriterionAssessment_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "BrainSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

