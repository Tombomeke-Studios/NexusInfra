-- CreateTable
CREATE TABLE "ServerBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deploymentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ServerBackup_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
