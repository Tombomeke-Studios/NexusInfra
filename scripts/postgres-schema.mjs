#!/usr/bin/env node
// Keep a service's PostgreSQL schema in step with its SQLite one (#241).
//
// Prisma fixes the database provider in the schema file, and a generated client
// only speaks to the provider it was generated for. So each service carries two
// schemas and two clients. The SQLite schema is the one people edit; this
// derives prisma/postgres/schema.prisma from it, so the two cannot quietly
// disagree about a model — `--check` fails CI when they do.
//
// Usage:
//   node scripts/postgres-schema.mjs services/orchestrator          # write
//   node scripts/postgres-schema.mjs services/orchestrator --check  # verify
//
// A schema change still needs a migration for each database: see
// docs/deployment.md#postgresql.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HEADER = `// GENERATED from ../schema.prisma by scripts/postgres-schema.mjs — do not edit.
// Change ../schema.prisma, run \`npm run db:sync-postgres\`, and add a migration
// for each database (see docs/deployment.md#postgresql).
`;

export function toPostgres(source) {
  let out = source;
  const datasource = /datasource\s+db\s*\{[^}]*\}/m;
  if (!datasource.test(out)) throw new Error('no `datasource db` block found');
  out = out.replace(datasource, (block) => {
    if (!/provider\s*=\s*"sqlite"/.test(block)) throw new Error('the source schema is expected to use the sqlite provider');
    return block.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
  });

  const generator = /generator\s+client\s*\{[^}]*\}/m;
  if (!generator.test(out)) throw new Error('no `generator client` block found');
  out = out.replace(generator, (block) =>
    /output\s*=/.test(block)
      ? block.replace(/output\s*=\s*"[^"]*"/, 'output   = "../../generated/postgres"')
      : block.replace(/\}\s*$/, '  output   = "../../generated/postgres"\n}')
  );
  return HEADER + '\n' + out;
}

function main() {
  const [service, flag] = process.argv.slice(2);
  if (!service) {
    console.error('usage: node scripts/postgres-schema.mjs <service dir> [--check]');
    process.exit(2);
  }
  const source = join(service, 'prisma', 'schema.prisma');
  const target = join(service, 'prisma', 'postgres', 'schema.prisma');
  const wanted = toPostgres(readFileSync(source, 'utf8'));

  if (flag === '--check') {
    let current = '';
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      // missing counts as out of date
    }
    if (current !== wanted) {
      console.error(`✖ ${target} is out of date with ${source}. Run \`npm run db:sync-postgres\` in ${service} and add a PostgreSQL migration.`);
      process.exit(1);
    }
    console.log(`✔ ${target} matches ${source}`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wanted);
  console.log(`wrote ${target}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
