-- Who owns a deployment and how big it is, kept so billing survives a restart (#364).
CREATE TABLE "BillingDeployment" (
    "deploymentId" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "limits" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "BillingDeployment_userId_idx" ON "BillingDeployment"("userId");
