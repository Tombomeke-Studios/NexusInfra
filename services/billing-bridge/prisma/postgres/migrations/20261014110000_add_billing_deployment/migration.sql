-- Who owns a deployment and how big it is, kept so billing survives a restart (#364).
CREATE TABLE "BillingDeployment" (
    "deploymentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "limits" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingDeployment_pkey" PRIMARY KEY ("deploymentId")
);

CREATE INDEX "BillingDeployment_userId_idx" ON "BillingDeployment"("userId");
