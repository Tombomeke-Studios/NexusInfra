-- Directories a server keeps across restarts (#324).
ALTER TABLE "ServerConfig" ADD COLUMN "persistPaths" TEXT NOT NULL DEFAULT '[]';
