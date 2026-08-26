-- CreateTable: one signed-in session (#227). A JWT names a session row, so a
-- session that is deleted is a token that stops working — which is what makes
-- "log me out everywhere" and "end this person's access" true rather than
-- something that takes effect whenever the token happens to expire.
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT
);

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
