import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

// The two schemas and their migrations stay in step (#241). The PostgreSQL
// schema is derived from the SQLite one; each has its own migrations. A model
// changed in one place and not the others used to be found on somebody's
// upgrade — now it fails here. (The PostgreSQL migrations are replayed against
// a real server in CI's integration job; SQLite needs none, so it is here.)

const serviceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serviceDir, '..', '..');
const prisma = path.join(repoRoot, 'node_modules', '.bin', 'prisma');

describe('database schemas (#241)', () => {
  it('the PostgreSQL schema is generated from the SQLite one and up to date', () => {
    const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'postgres-schema.mjs'), '.', '--check'], { cwd: serviceDir, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  // The check above proves nothing if the script never runs: on Windows it used
  // to exit 0 without doing anything (#361). A schema with no PostgreSQL
  // counterpart must be reported, on every platform.
  it('the check fails when the PostgreSQL schema is missing', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexusinfra-schema-'));
    try {
      mkdirSync(path.join(dir, 'prisma'));
      const schema = ['datasource db {', '  provider = "sqlite"', '  url      = "file:./x.db"', '}', '', 'generator client {', '  provider = "prisma-client-js"', '}', ''];
      writeFileSync(path.join(dir, 'prisma', 'schema.prisma'), schema.join('\n'));
      const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'postgres-schema.mjs'), dir, '--check'], { encoding: 'utf8' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('out of date');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the SQLite migrations produce exactly the SQLite schema', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexusinfra-shadow-'));
    try {
      const run = spawnSync(
        prisma,
        ['migrate', 'diff', '--exit-code', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel', 'prisma/schema.prisma', '--shadow-database-url', `file:${path.join(dir, 'shadow.db')}`],
        // `.bin/prisma` is a shell script; on Windows only a shell can start it (#361).
        { cwd: serviceDir, encoding: 'utf8', shell: process.platform === 'win32' }
      );
      // 0: no difference. 2: the migrations are missing something — add one.
      expect(run.status, `the SQLite migrations do not produce prisma/schema.prisma — add a migration:\n${run.stdout}${run.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
