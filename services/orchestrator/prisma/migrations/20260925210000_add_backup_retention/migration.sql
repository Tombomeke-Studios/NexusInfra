-- How many backups a server keeps, and for how long (#232).
ALTER TABLE "ServerConfig" ADD COLUMN "backupRetention" TEXT NOT NULL DEFAULT '{}';
-- Whether a backup's copy reached the off-site store (#232).
ALTER TABLE "ServerBackup" ADD COLUMN "offsite" TEXT;
