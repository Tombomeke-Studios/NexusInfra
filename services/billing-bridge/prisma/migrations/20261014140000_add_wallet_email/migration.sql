-- The address an account's top-ups were billed to (#375), kept so the monthly
-- statement can say whose it is. Nullable: nobody has one until they top up.
ALTER TABLE "CreditWallet" ADD COLUMN "email" TEXT;
