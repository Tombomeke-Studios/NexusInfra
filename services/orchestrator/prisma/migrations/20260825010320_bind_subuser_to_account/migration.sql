-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ServerSubuser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServerSubuser_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ServerSubuser" ("createdAt", "deploymentId", "email", "id", "role") SELECT "createdAt", "deploymentId", "email", "id", "role" FROM "ServerSubuser";
DROP TABLE "ServerSubuser";
ALTER TABLE "new_ServerSubuser" RENAME TO "ServerSubuser";
CREATE UNIQUE INDEX "ServerSubuser_deploymentId_email_key" ON "ServerSubuser"("deploymentId", "email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Preserve access that already worked.
-- Before this migration a grant was matched purely by address, so every existing
-- row was effectively active. Letting them all default to 'pending' would revoke
-- access from people who currently have it, silently. Bind the ones whose address
-- already has an account and mark them active; the rest stay pending, which is
-- the correct state for an address nobody has signed up with.
UPDATE "ServerSubuser"
SET "userId" = (SELECT "id" FROM "User" WHERE "User"."email" = "ServerSubuser"."email"),
    "status" = 'active'
WHERE EXISTS (SELECT 1 FROM "User" WHERE "User"."email" = "ServerSubuser"."email");
