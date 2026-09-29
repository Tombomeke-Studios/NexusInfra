#!/usr/bin/env node
// Apply a service's migrations to whichever database DATABASE_URL names (#241).
// Run from the service directory (`npm run db:deploy`), which is also what the
// images do at start. Node rather than shell so it behaves the same on Windows.

import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL ?? '';
const postgres = /^postgres(ql)?:\/\//i.test(url);
const args = ['prisma', 'migrate', 'deploy', ...(postgres ? ['--schema', 'prisma/postgres/schema.prisma'] : [])];
console.log(`[db] applying ${postgres ? 'PostgreSQL' : 'SQLite'} migrations`);
const run = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(run.status ?? 1);
