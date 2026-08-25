-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "pricePerHour" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "freeHoursPerMonth" REAL NOT NULL DEFAULT 0,
    "maxServers" INTEGER NOT NULL DEFAULT 5,
    "maxDatabases" INTEGER NOT NULL DEFAULT 5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserPlan" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ServerBilling" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "limits" TEXT NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL,
    "stoppedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CreditWallet" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "balance" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR'
);

-- CreateTable
CREATE TABLE "CreditLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BillingCycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ServerBilling_userId_idx" ON "ServerBilling"("userId");

-- CreateIndex
CREATE INDEX "ServerBilling_deploymentId_idx" ON "ServerBilling"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedger_reference_key" ON "CreditLedger"("reference");

-- CreateIndex
CREATE INDEX "CreditLedger_userId_idx" ON "CreditLedger"("userId");

-- CreateIndex
CREATE INDEX "BillingCycle_userId_idx" ON "BillingCycle"("userId");
