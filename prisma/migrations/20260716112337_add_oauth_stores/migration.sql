-- CreateTable
CREATE TABLE "oauth_states" (
    "state" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "oauth_pending" (
    "state" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "clientState" TEXT,
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_pending_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "oauth_codes" (
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionTokenEnc" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("codeHash")
);

-- CreateIndex
CREATE INDEX "oauth_states_expiresAt_idx" ON "oauth_states"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_pending_expiresAt_idx" ON "oauth_pending"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_codes_expiresAt_idx" ON "oauth_codes"("expiresAt");
