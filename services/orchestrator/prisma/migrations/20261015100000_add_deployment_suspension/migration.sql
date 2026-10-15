-- When billing stopped a server for lack of credit, and why (#380). Nullable:
-- nothing is suspended until billing says so, and a start clears it.
ALTER TABLE "Deployment" ADD COLUMN "suspendedAt" DATETIME;
ALTER TABLE "Deployment" ADD COLUMN "suspendedReason" TEXT;
