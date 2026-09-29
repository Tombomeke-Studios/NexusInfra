import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { PrismaRepository } from './db.js';
import { PortConflictError } from './portPool.js';

// The Prisma repository against a real database (#242). The in-memory repository
// backs every unit test; these are the behaviours only the database can prove —
// the migrations apply from nothing, a unique index refuses a race, a
// conditional update claims a row once, a transaction deletes everything.
//
// Against each database the panel supports (#241): SQLite always, PostgreSQL
// when TEST_POSTGRES_URL names one — which CI's integration job does, with
// REQUIRE_POSTGRES so a lost database fails the job instead of skipping it.

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(here, '..');
const prismaBin = path.join(serviceDir, '..', '..', 'node_modules', '.bin', 'prisma');
const PG_URL = process.env.TEST_POSTGRES_URL;
if (process.env.REQUIRE_POSTGRES && !PG_URL) throw new Error('REQUIRE_POSTGRES is set but TEST_POSTGRES_URL is not');

interface Target {
  name: string;
  /** Migrate a fresh database from nothing, and return a client for it plus how to throw it away. */
  setup(): { client: PrismaClient; teardown(): Promise<void> };
}

const targets: Target[] = [
  {
    name: 'SQLite',
    setup() {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'nexusinfra-prisma-'));
      const url = `file:${path.join(dir, 'test.db')}`;
      // Every migration, in order, from an empty file — what a fresh install does.
      execFileSync(prismaBin, ['migrate', 'deploy'], { cwd: serviceDir, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
      const client = new PrismaClient({ datasources: { db: { url } } });
      return { client, teardown: async () => { await client.$disconnect(); rmSync(dir, { recursive: true, force: true }); } };
    },
  },
];

if (PG_URL) {
  targets.push({
    name: 'PostgreSQL',
    setup() {
      // A schema of its own per run, so runs never see each other's rows.
      const schema = `it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const url = `${PG_URL}${PG_URL.includes('?') ? '&' : '?'}schema=${schema}`;
      execFileSync(prismaBin, ['migrate', 'deploy', '--schema', 'prisma/postgres/schema.prisma'], { cwd: serviceDir, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
      const { PrismaClient: PgClient } = createRequire(import.meta.url)('../generated/postgres/index.js') as { PrismaClient: new (o: unknown) => PrismaClient };
      const client = new PgClient({ datasources: { db: { url } } });
      return {
        client,
        teardown: async () => {
          await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          await client.$disconnect();
        },
      };
    },
  });
}

describe.each(targets)('PrismaRepository against $name (#242, #241)', (target) => {
  let client: PrismaClient;
  let teardown: () => Promise<void>;
  let repo: PrismaRepository;

  beforeAll(() => {
    ({ client, teardown } = target.setup());
    repo = new PrismaRepository(client);
  }, 60_000);

  afterAll(async () => {
    await teardown?.();
  });

  async function server(name: string, extra: Record<string, unknown> = {}) {
    await repo.upsertNode({ id: 'node-a', lastHeartbeat: new Date().toISOString() });
    const config = await repo.createServerConfig({ userId: 'u1', name, dockerImage: 'nginx', ...extra });
    return (await repo.createDeployment(config.id, 'node-a')).id;
  }

  it('round-trips a server with everything added since the first migration', async () => {
    const id = await server('full', { persistPaths: ['/srv', '/etc/app'], ports: { '8080': '80' } });
    await repo.updateDeploymentConfig(id, { backupRetention: { keepLast: 3, keepDays: 7 } });
    const detail = await repo.getDeployment(id);
    expect(detail).toMatchObject({ name: 'full', persistPaths: ['/srv', '/etc/app'], backupRetention: { keepLast: 3, keepDays: 7 }, ports: { '8080': '80' } });
  });

  it('refuses a host port another server holds, with the unique index — the race the unit tests cannot stage', async () => {
    const a = await server('a');
    const b = await server('b');
    await repo.replacePortAllocations(a, 'node-a', [25565]);
    // Both at once, as two concurrent requests would.
    const results = await Promise.allSettled([repo.replacePortAllocations(b, 'node-a', [25565]), repo.replacePortAllocations(b, 'node-a', [25565])]);
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof PortConflictError)).toBe(true);
    expect((await repo.listPortAllocations({ nodeId: 'node-a' })).filter((p) => p.port === 25565).map((p) => p.deploymentId)).toEqual([a]);
  });

  it('keeps the primary port across a change', async () => {
    const id = await server('primary');
    await repo.replacePortAllocations(id, 'node-a', [30001, 30002]);
    await repo.setPrimaryPort(id, 30002);
    await repo.replacePortAllocations(id, 'node-a', [30002, 30003]);
    expect((await repo.listPortAllocations({ deploymentId: id })).find((p) => p.primary)?.port).toBe(30002);
  });

  it('lets exactly one of several drains claim a notification', async () => {
    const channel = await repo.createNotificationChannel({ userId: 'u1', kind: 'webhook', target: 'https://x.test', format: 'json', events: ['server.crashed'], secret: 's', allowPrivate: false, enabled: true });
    const [delivery] = await repo.enqueueDeliveries([{ channelId: channel.id, event: 'server.crashed', payload: '{}' }]);
    const claims = await Promise.all(Array.from({ length: 5 }, () => repo.claimDelivery(delivery.id, 0)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('deletes a server and every child row in one go', async () => {
    const id = await server('doomed');
    await repo.appendDeploymentEvent(id, 'created', 'x');
    await repo.createBackup({ deploymentId: id, name: 'b', path: '/data', ref: 'bk_1', sizeBytes: 1 });
    await repo.createSchedule({ deploymentId: id, name: 's', cron: '* * * * *', action: 'backup' });
    await repo.replacePortAllocations(id, 'node-a', [40000]);
    await repo.deleteDeployment(id);
    expect(await repo.getDeployment(id)).toBeNull();
    expect(await repo.listPortAllocations({ deploymentId: id })).toEqual([]);
    expect(await repo.listBackups(id)).toEqual([]);
  });

  it('clears a stopped server\'s container id (#321) and keeps a node\'s pool through heartbeats (#233)', async () => {
    const id = await server('status');
    await repo.updateDeploymentStatus(id, { status: 'running', containerId: 'c1' });
    await repo.updateDeploymentStatus(id, { status: 'stopped', containerId: null });
    expect((await repo.getDeployment(id))?.containerId).toBeNull();

    await repo.registerNode({ id: 'node-a', portRange: { start: 30000, end: 30100 } });
    await repo.upsertNode({ id: 'node-a', lastHeartbeat: new Date().toISOString(), cpuPercent: 10 });
    const node = (await repo.listNodes()).find((n) => n.id === 'node-a');
    expect([node?.portRangeStart, node?.portRangeEnd]).toEqual([30000, 30100]);
  });
  // #344: a reset link is single-use even when it is submitted twice at once,
  // and a newer link supersedes the older one.
  it('spends a password reset exactly once, and only the newest works', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const now = new Date().toISOString();
    await repo.createPasswordReset({ userId: 'u-reset', tokenHash: 'old-hash', expiresAt: future });
    await repo.createPasswordReset({ userId: 'u-reset', tokenHash: 'new-hash', expiresAt: future });
    expect(await repo.consumePasswordReset('old-hash', now)).toBeNull();

    const claims = await Promise.all([1, 2, 3, 4].map(() => repo.consumePasswordReset('new-hash', now)));
    expect(claims.filter((c) => c === 'u-reset')).toHaveLength(1);

    await repo.createPasswordReset({ userId: 'u-reset', tokenHash: 'expired-hash', expiresAt: now });
    expect(await repo.consumePasswordReset('expired-hash', new Date(Date.now() + 1000).toISOString())).toBeNull();
  });
});
