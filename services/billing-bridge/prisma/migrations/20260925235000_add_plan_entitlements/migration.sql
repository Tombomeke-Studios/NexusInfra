-- Plan entitlements (#297). Nullable: an existing plan keeps behaving as it did
-- (no ceiling) until someone sets one; a fresh install seeds the default plan
-- with its values.
ALTER TABLE "BillingPlan" ADD COLUMN "maxRamMb" INTEGER;
ALTER TABLE "BillingPlan" ADD COLUMN "maxBackupsPerServer" INTEGER;
