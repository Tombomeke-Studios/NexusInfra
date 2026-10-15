-- When an account was last warned that its credit is running low (#379), so a
-- restart of the bridge does not warn twice. Nullable: nobody has been warned yet.
ALTER TABLE "CreditWallet" ADD COLUMN "lowCreditWarnedAt" DATETIME;
