-- AlterTable: drain flag for a node (#258). Defaults false so every existing
-- node stays in the placement pool.
ALTER TABLE "Node" ADD COLUMN "maintenance" BOOLEAN NOT NULL DEFAULT false;
