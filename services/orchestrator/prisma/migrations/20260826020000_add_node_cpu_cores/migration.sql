-- AlterTable: the node's real CPU count (#261). Nullable: a node that has not
-- reported one stays unknown rather than being guessed at.
ALTER TABLE "Node" ADD COLUMN "cpuCores" INTEGER;
