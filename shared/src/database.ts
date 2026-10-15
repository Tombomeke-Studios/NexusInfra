// Which database a service talks to (#241). SQLite by default — a file next to
// the service, nothing to run — and PostgreSQL when DATABASE_URL says so. Prisma
// fixes the provider at generation time, so each service carries both clients
// and picks by this at start; one rule here so the two services cannot disagree.

export type DatabaseProvider = 'sqlite' | 'postgresql';

export function isPostgresUrl(url: string | undefined): boolean {
  return /^postgres(ql)?:\/\//i.test(url ?? '');
}

export function databaseProvider(url: string | undefined = process.env.DATABASE_URL): DatabaseProvider {
  return isPostgresUrl(url) ? 'postgresql' : 'sqlite';
}
