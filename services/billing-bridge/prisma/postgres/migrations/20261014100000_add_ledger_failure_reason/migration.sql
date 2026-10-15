-- Why a top-up failed (#351). Nullable: nothing before this recorded a reason.
ALTER TABLE "CreditLedger" ADD COLUMN "failureReason" TEXT;
