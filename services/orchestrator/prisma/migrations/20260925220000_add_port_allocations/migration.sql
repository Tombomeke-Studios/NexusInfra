-- A node's host-port pool (#233).
ALTER TABLE "Node" ADD COLUMN "portRangeStart" INTEGER;
ALTER TABLE "Node" ADD COLUMN "portRangeEnd" INTEGER;

-- Host ports held by servers, one row per port per node (#233).
CREATE TABLE "PortAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PortAllocation_nodeId_port_key" ON "PortAllocation"("nodeId", "port");
CREATE INDEX "PortAllocation_deploymentId_idx" ON "PortAllocation"("deploymentId");
