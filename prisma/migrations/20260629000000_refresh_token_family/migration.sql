-- Add rotation-chain family id to refresh tokens for reuse detection.
-- Existing rows are each backfilled as their own family (id), then the column
-- is made NOT NULL.
ALTER TABLE "oauth_refresh_tokens" ADD COLUMN "familyId" TEXT;
UPDATE "oauth_refresh_tokens" SET "familyId" = "id" WHERE "familyId" IS NULL;
ALTER TABLE "oauth_refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;

-- Indexes for revocation-by-client, family revocation, and expiry pruning.
CREATE INDEX "oauth_refresh_tokens_clientId_idx" ON "oauth_refresh_tokens"("clientId");
CREATE INDEX "oauth_refresh_tokens_familyId_idx" ON "oauth_refresh_tokens"("familyId");
CREATE INDEX "oauth_refresh_tokens_expiresAt_idx" ON "oauth_refresh_tokens"("expiresAt");

-- Expiry index on sessions for pruning.
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");
