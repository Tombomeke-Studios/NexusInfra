import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '../generated/prisma/index.js';
import { PrismaRepository } from './db.js';
import { createBillingService } from './service.js';

// The billing repository against a real database (#298). What the in-memory
// repository cannot prove: that the top-up status change is one conditional
// UPDATE, so two deliveries of one confirmation credit once — on each database
// the panel supports (#241), PostgreSQL when TEST_POSTGRES_URL names one.

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceDir = path.resolve(here, '..');
const prismaBin = path.join(serviceDir, '..', '..', 'node_modules', '.bin', 'prisma');
const PG_URL = process.env.TEST_POSTGRES_URL;
if (process.env.REQUIRE_POSTGRES && !PG_URL) throw new Error('REQUIRE_POSTGRES is set but TEST_POSTGRES_URL is not');

interface Target {
  name: string;
  setup(): { client: PrismaClient; teardown(): Promise<void> };
}

const targets: Target[] = [
  {
    name: 'SQLite',
    setup() {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'nexusinfra-billing-'));
      const url = `file:${path.join(dir, 'test.db')}`;
      execFileSync(prismaBin, ['migrate', 'deploy'], { cwd: serviceDir, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
      const client = new PrismaClient({ datasources: { db: { url } } });
      return {
        client,
        teardown: async () => {
          await client.$disconnect();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

if (PG_URL) {
  targets.push({
    name: 'PostgreSQL',
    setup() {
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

describe.each(targets)('billing PrismaRepository against $name (#298)', (target) => {
  let client: PrismaClient;
  let teardown: () => Promise<void>;
  let repo: PrismaRepository;

  beforeAll(async () => {
    ({ client, teardown } = target.setup());
    repo = new PrismaRepository(client);
    await repo.ensureDefaultPlan();
  }, 60_000);

  afterAll(async () => {
    await teardown?.();
  });

  const service = () => createBillingService({ repo, publish: async () => true, log: () => undefined });

  it('credits a top-up once when its confirmation is delivered several times at once', async () => {
    const svc = service();
    const { reference } = await svc.requestTopUp('race-user', 25);
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.handlePaymentConfirmed({ reference, amount: 25 })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.getWallet('race-user')).balance).toBe(25);
  });

  it('moves a status only from the states named', async () => {
    const svc = service();
    const { entry } = await svc.requestTopUp('transition-user', 10);
    expect(await repo.transitionLedgerStatus(entry.id, ['expired'], 'confirmed')).toBe(false);
    expect(await repo.transitionLedgerStatus(entry.id, ['pending'], 'expired')).toBe(true);
    expect(await repo.transitionLedgerStatus(entry.id, ['pending'], 'expired')).toBe(false);
    expect((await repo.getLedgerByReference(entry.reference))?.status).toBe('expired');
  });

  it('finds only pending top-ups older than the cutoff', async () => {
    const svc = service();
    const { entry } = await svc.requestTopUp('stale-user', 10);
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    expect((await repo.listPendingTopUps(future)).map((e) => e.id)).toContain(entry.id);
    expect((await repo.listPendingTopUps(past)).map((e) => e.id)).not.toContain(entry.id);
  });
});
