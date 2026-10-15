-- Two-factor authentication (#229). The panel hands out root shells inside
-- containers and control over the Docker hosts behind them; a single password
-- was the whole defence, and a password is the credential people reuse.
--
-- The secret exists from the moment enrolment starts; totpEnabledAt is what
-- says the person proved they can produce a code from it, so an abandoned
-- enrolment never locks anyone out.
ALTER TABLE "User" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "User" ADD COLUMN "totpEnabledAt" DATETIME;

-- CreateTable: one unused recovery code. Stored as a digest and deleted as it
-- is used, so a code works exactly once. Without these, enabling 2FA on a
-- self-hosted panel is a way to lose your own machines to a broken phone.
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_codeHash_key" ON "RecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");
