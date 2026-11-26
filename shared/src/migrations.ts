import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { databaseProvider } from './database.js';

// Is the database migrated? (#192)
//
// Migrations are applied by each service's `migrate` image (the Prisma CLI), not
// by the service itself, so the runtime image can leave the CLI and its schema
// engine out. That moves a step a hand-assembled stack can forget. A service
// started against an unmigrated database would not fail cleanly: it would run
// until the first query touching a missing column. So it checks first.
//
// This only reads the table Prisma Migrate keeps (`_prisma_migrations`). It never
// writes to it and never applies anything: applying stays Prisma's job.

export interface AppliedMigration {
  migration_name: string;
  finished_at: unknown;
  rolled_back_at: unknown;
}

/** The migrations shipped in `dir`: every subdirectory holding a `migration.sql`, in order. */
export function shippedMigrations(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
    .map((entry) => entry.name)
    .sort();
}

/** The migrations directory for the database `url` names, as `db:deploy` picks it (#241). */
export function migrationsDirFor(serviceDir: string, url: string | undefined = process.env.DATABASE_URL): string {
  return databaseProvider(url) === 'postgresql'
    ? join(serviceDir, 'prisma', 'postgres', 'migrations')
    : join(serviceDir, 'prisma', 'migrations');
}

/**
 * Shipped migrations the database has not applied. A migration counts as applied
 * when one of its rows finished and was not rolled back; Prisma keeps a failed
 * attempt's row beside the one that later succeeded.
 */
export function pendingMigrations(shipped: string[], applied: AppliedMigration[]): string[] {
  const finished = new Set(applied.filter((m) => m.finished_at != null && m.rolled_back_at == null).map((m) => m.migration_name));
  return shipped.filter((name) => !finished.has(name));
}

/** True for the errors that mean "there is no `_prisma_migrations` table yet". */
function isMissingTable(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  // SQLite: "no such table"; PostgreSQL: undefined_table (42P01), "does not exist".
  return /_prisma_migrations/.test(text) && /no such table|does not exist|42P01/i.test(text);
}

export interface AssertMigratedOptions {
  /** Service name, for the message and the migrate image's name. */
  service: string;
  shipped: string[];
  /** Reads the `_prisma_migrations` rows. */
  readApplied: () => Promise<AppliedMigration[]>;
  log?: Pick<Console, 'error' | 'warn'>;
  exit?: (code: number) => void;
}

/**
 * Exit the process (code 1) unless every shipped migration is applied. A database
 * newer than this image only warns: a rolled-back image must still start.
 */
export async function assertMigrated(options: AssertMigratedOptions): Promise<void> {
  const { service, shipped, readApplied } = options;
  const log = options.log ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let applied: AppliedMigration[];
  try {
    applied = await readApplied();
  } catch (err) {
    if (!isMissingTable(err)) {
      log.error(`[${service}] could not check the database's migrations: ${err instanceof Error ? err.message : String(err)}`);
      exit(1);
      return;
    }
    applied = [];
  }

  const pending = pendingMigrations(shipped, applied);
  if (pending.length > 0) {
    log.error(
      `[${service}] ${pending.length} migration${pending.length === 1 ? '' : 's'} not applied to this database (first: ${pending[0]}). ` +
        `Run the ${service}-migrate image against the same DATABASE_URL first — the release compose files do this ` +
        `on every start — or \`npm run db:deploy\` from the service directory when running from source.`,
    );
    exit(1);
    return;
  }

  const known = new Set(shipped);
  const unknown = applied.filter((m) => !known.has(m.migration_name)).map((m) => m.migration_name);
  if (unknown.length > 0) {
    log.warn(`[${service}] the database has migrations this image does not know (${[...new Set(unknown)].join(', ')}); it was migrated by a newer release`);
  }
}
