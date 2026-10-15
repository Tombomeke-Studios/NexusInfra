-- Confirming an account's email address (#367). Existing accounts start
-- unconfirmed; nothing is gated on it unless the installation can send mail.
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" DATETIME;

CREATE TABLE "EmailVerification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "EmailVerification_tokenHash_key" ON "EmailVerification"("tokenHash");
CREATE INDEX "EmailVerification_userId_idx" ON "EmailVerification"("userId");
