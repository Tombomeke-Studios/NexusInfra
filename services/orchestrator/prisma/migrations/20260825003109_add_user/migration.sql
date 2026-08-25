-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "platformRole" TEXT NOT NULL DEFAULT 'user',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- Backfill owners for servers created before accounts existed.
-- ServerConfig.userId held the stub login's username ("admin") or the anonymous
-- fallback ("dev-user"). Without a matching row those deployments would have an
-- owner that resolves to nobody, and every access check on them would deny.
--
-- The seeded hash '!' is deliberately not a valid bcrypt digest, so it can never
-- verify against any password: these accounts exist to own servers, not to sign
-- in. The service's first-run bootstrap sets a real password on the admin
-- account (see users.ts), which is what makes it usable again.
INSERT INTO "User" ("id", "email", "displayName", "passwordHash", "platformRole")
SELECT DISTINCT
    "userId",
    "userId" || '@local',
    "userId",
    '!',
    CASE WHEN "userId" = 'admin' THEN 'owner' ELSE 'user' END
FROM "ServerConfig"
WHERE "userId" NOT IN (SELECT "id" FROM "User");
