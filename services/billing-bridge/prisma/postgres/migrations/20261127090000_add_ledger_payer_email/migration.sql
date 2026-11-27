-- Where a top-up was sent (#445). Null: a scan-only top-up, or not a top-up.
ALTER TABLE "CreditLedger" ADD COLUMN "payerEmail" TEXT;
