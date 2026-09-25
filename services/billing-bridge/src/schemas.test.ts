import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
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

  it('the SQLite migrations produce exactly the SQLite schema', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nexusinfra-shadow-'));
    try {
      const run = spawnSync(
        prisma,
        ['migrate', 'diff', '--exit-code', '--from-migrations', 'prisma/migrations', '--to-schema-datamodel', 'prisma/schema.prisma', '--shadow-database-url', `file:${path.join(dir, 'shadow.db')}`],
        { cwd: serviceDir, encoding: 'utf8' }
      );
      // 0: no difference. 2: the migrations are missing something — add one.
      expect(run.status, `the SQLite migrations do not produce prisma/schema.prisma — add a migration:\n${run.stdout}${run.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
