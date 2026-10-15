-- Plans can be retired without being deleted (#369). Existing plans stay on offer.
ALTER TABLE "BillingPlan" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
