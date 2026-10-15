-- CreateTable: an API token (#228). Automating anything against the panel used
-- to mean storing a person's password in a script; this is a credential that
-- can be scoped down, revoked on its own, and seen for what it is in a list.
--
-- Only the digest is stored. The secret is shown once, at creation, and cannot
-- be recovered afterwards — a database that leaks yields nothing usable.
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");
