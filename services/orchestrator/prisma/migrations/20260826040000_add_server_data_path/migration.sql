-- AlterTable: an existing host directory on the node, mounted as this server's
-- data directory (#268). Null for a server that starts from an empty container.
ALTER TABLE "ServerConfig" ADD COLUMN "dataPath" TEXT;
