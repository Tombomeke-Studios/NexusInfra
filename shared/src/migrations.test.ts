import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertMigrated, migrationsDirFor, pendingMigrations, shippedMigrations } from './migrations.js';

const done = (name: string) => ({ migration_name: name, finished_at: new Date(), rolled_back_at: null });

describe('shippedMigrations', () => {
  it('lists the migration directories in order, ignoring anything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    try {
      for (const name of ['20260102_b', '20260101_a']) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'migration.sql'), '-- sql');
      }
      mkdirSync(join(dir, '20260103_empty')); // no migration.sql: not a migration
      writeFileSync(join(dir, 'migration_lock.toml'), 'provider = "sqlite"');
      expect(shippedMigrations(dir)).toEqual(['20260101_a', '20260102_b']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migrationsDirFor', () => {
  it('picks the SQLite or PostgreSQL migrations by the database URL', () => {
    expect(migrationsDirFor('/svc', 'file:./x.db')).toBe(join('/svc', 'prisma', 'migrations'));
    expect(migrationsDirFor('/svc', 'postgresql://u:p@h/db')).toBe(join('/svc', 'prisma', 'postgres', 'migrations'));
  });
});

describe('pendingMigrations', () => {
  it('is empty when every shipped migration finished', () => {
    expect(pendingMigrations(['a', 'b'], [done('a'), done('b')])).toEqual([]);
  });

  it('names the shipped migrations the database has not applied', () => {
    expect(pendingMigrations(['a', 'b', 'c'], [done('a')])).toEqual(['b', 'c']);
  });

  it('counts a migration that started and never finished as pending', () => {
    expect(pendingMigrations(['a'], [{ migration_name: 'a', finished_at: null, rolled_back_at: null }])).toEqual(['a']);
  });

  it('counts a rolled-back migration as pending', () => {
    expect(pendingMigrations(['a'], [{ migration_name: 'a', finished_at: new Date(), rolled_back_at: new Date() }])).toEqual(['a']);
  });

  it('counts a migration as applied if any of its rows finished', () => {
    // Prisma keeps the failed attempt's row and adds a new one when it is retried.
    const failed = { migration_name: 'a', finished_at: null, rolled_back_at: new Date() };
    expect(pendingMigrations(['a'], [failed, done('a')])).toEqual([]);
  });
});

describe('assertMigrated', () => {
  function harness(shipped: string[], read: () => Promise<unknown[]>) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let exitCode: number | undefined;
    const run = () =>
      assertMigrated({
        service: 'orchestrator',
        shipped,
        readApplied: read as never,
        log: { error: (m: string) => errors.push(m), warn: (m: string) => warnings.push(m) },
        exit: (code: number) => {
          exitCode = code;
        },
      });
    return { run, errors, warnings, exitCode: () => exitCode };
  }

  it('lets a fully migrated database through', async () => {
    const h = harness(['a', 'b'], async () => [done('a'), done('b')]);
    await h.run();
    expect(h.exitCode()).toBeUndefined();
    expect(h.errors).toEqual([]);
  });

  it('stops the service when migrations are pending, and says how to apply them', async () => {
    const h = harness(['a', 'b'], async () => [done('a')]);
    await h.run();
    expect(h.exitCode()).toBe(1);
    expect(h.errors.join('\n')).toMatch(/1 migration.*not applied/);
    expect(h.errors.join('\n')).toMatch(/orchestrator-migrate/);
  });

  it('treats a database with no migrations table as having none applied', async () => {
    const h = harness(['a'], async () => {
      throw new Error('no such table: _prisma_migrations');
    });
    await h.run();
    expect(h.exitCode()).toBe(1);
  });

  it('reports a database it cannot reach as that, not as missing migrations', async () => {
    const h = harness(['a'], async () => {
      throw new Error("Can't reach database server at `postgres:5432`");
    });
    await h.run();
    expect(h.exitCode()).toBe(1);
    expect(h.errors.join('\n')).toMatch(/could not check/);
    expect(h.errors.join('\n')).toMatch(/postgres:5432/);
    expect(h.errors.join('\n')).not.toMatch(/not applied/);
  });

  it('only warns when the database is newer than the image', async () => {
    const h = harness(['a'], async () => [done('a'), done('z_from_a_newer_release')]);
    await h.run();
    expect(h.exitCode()).toBeUndefined();
    expect(h.warnings.join('\n')).toMatch(/z_from_a_newer_release/);
  });
});
