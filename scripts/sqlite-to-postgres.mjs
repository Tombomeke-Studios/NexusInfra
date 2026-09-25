#!/usr/bin/env node
// Copy a service's data from its SQLite file into PostgreSQL (#241).
//
//   node scripts/sqlite-to-postgres.mjs services/orchestrator \
//     --from file:/data/orchestrator.db --to postgresql://nexus:…@postgres:5432/nexus
//
// Stop the service first: the copy checks row counts at the end and refuses to
// call a moving source a success. The target is migrated here (idempotent) and
// must be empty — see shared/src/copyDatabase.ts for the rules, and
// docs/deployment.md#postgresql for the whole procedure.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const service = resolve(args[0] ?? '');
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const from = flag('--from');
const to = flag('--to');

if (!args[0] || !from || !to) {
  console.error('usage: node scripts/sqlite-to-postgres.mjs <service dir> --from file:<sqlite path> --to postgresql://…');
  process.exit(2);
}
if (!from.startsWith('file:')) {
  console.error('--from must be a SQLite URL (file:…)');
  process.exit(2);
}
if (!/^postgres(ql)?:\/\//i.test(to)) {
  console.error('--to must be a PostgreSQL URL (postgresql://…)');
  process.exit(2);
}

const { copyDatabase, delegateName, modelsFromDmmf } = await import(join(here, '..', 'shared', 'dist', 'index.js'));
const require = createRequire(join(service, 'package.json'));
// The SQLite client is wherever the service generates it: its own directory
// (billing-bridge) or the hoisted default (orchestrator).
const sqliteModule = existsSync(join(service, 'generated', 'prisma', 'index.js')) ? require(join(service, 'generated', 'prisma')) : require('@prisma/client');
const postgresModule = require(join(service, 'generated', 'postgres'));

console.log('[copy] migrating the target database');
const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/postgres/schema.prisma'], {
  cwd: service,
  env: { ...process.env, DATABASE_URL: to },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const source = new sqliteModule.PrismaClient({ datasources: { db: { url: from } } });
const target = new postgresModule.PrismaClient({ datasources: { db: { url: to } } });
try {
  const models = modelsFromDmmf(sqliteModule.Prisma.dmmf);
  const results = await copyDatabase({
    models,
    from: (m) => source[delegateName(m)],
    to: (m) => target[delegateName(m)],
    log: (line) => console.log(`[copy] ${line}`),
  });
  const total = results.reduce((n, r) => n + r.rows, 0);
  console.log(`[copy] done — ${total} rows in ${results.length} tables. Point DATABASE_URL at PostgreSQL and start the service.`);
} catch (err) {
  console.error(`[copy] ✖ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await source.$disconnect();
  await target.$disconnect();
}
