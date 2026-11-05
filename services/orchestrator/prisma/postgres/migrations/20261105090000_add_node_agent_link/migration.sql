-- How the control plane reaches a node's agent, and the digest of its agent
-- link token (#416). Every node before this was called directly.
ALTER TABLE "Node" ADD COLUMN "connection" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "Node" ADD COLUMN "linkTokenHash" TEXT;
