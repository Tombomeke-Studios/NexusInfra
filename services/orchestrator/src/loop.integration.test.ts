import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { PrismaRepository } from './db.js';
import { createLifecycle } from './lifecycle.js';
import { startCommandFor } from './startCommand.js';
import { createAgent } from '../../node-agent/src/agent.js';
import type { ContainerRuntime } from '../../node-agent/src/runtime.js';

// The deployment loop end to end over a real broker and a real database (#242):
// the orchestrator publishes a command, a node agent (with a fake Docker) acts
// on it and reports back, and the orchestrator's record changes — every hop
// the unit tests replace with a captured function.

const URL = process.env.RABBITMQ_URL;
// CI sets REQUIRE_BROKER, so a job that lost its broker fails instead of
// skipping — a green run that tested nothing is the failure this suite exists
// to prevent.
if (process.env.REQUIRE_BROKER && !URL) throw new Error('REQUIRE_BROKER is set but RABBITMQ_URL is not');
const here = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!URL)('the deployment loop over RabbitMQ and Prisma (#242)', () => {
  let shared: typeof import('shared');
  let dir: string;
  let client: PrismaClient;
  let repo: PrismaRepository;
  const nodeId = `node-it-${randomUUID().slice(0, 8)}`;
  const containers = new Map<string, { running: boolean; exitCode: number }>();
  let agent: ReturnType<typeof createAgent>;

  const fakeRuntime = {
    async start() {
      const id = `c-${randomUUID().slice(0, 12)}`;
      containers.set(id, { running: true, exitCode: 0 });
      return id;
    },
    async stop(id: string) {
      containers.delete(id);
    },
    async inspectContainer(id: string) {
      const c = containers.get(id);
      return c ? { ...c, oomKilled: false } : null;
    },
  } as unknown as ContainerRuntime;

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
    for (let i = 0; i < 150; i++) {
      const v = await read();
      if (ok(v)) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  beforeAll(async () => {
    process.env.FINVAULT_MESSAGE_KEY = 'integration-test-key-0123456789abcdef';
    shared = await import('shared');

    dir = mkdtempSync(path.join(os.tmpdir(), 'nexusinfra-loop-'));
    const url = `file:${path.join(dir, 'loop.db')}`;
    execFileSync(path.resolve(here, '../../../node_modules/.bin/prisma'), ['migrate', 'deploy'], { cwd: path.resolve(here, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    client = new PrismaClient({ datasources: { db: { url } } });
    repo = new PrismaRepository(client);

    agent = createAgent({ nodeId, runtime: fakeRuntime, publish: shared.publishRabbitEvent, settleMs: 0 });
    await shared.consumeRabbitQueue(`nexusinfra.test.agent.${nodeId}`, ['infra.server.start', 'infra.server.stop'], (e) => agent.handleCommand(e));
    const lifecycle = createLifecycle(repo);
    await shared.consumeRabbitQueue(`nexusinfra.test.orchestrator.${nodeId}`, ['infra.server.started', 'infra.server.stopped', 'infra.server.crashed'], (e) => lifecycle.handleReport(e));
  });

  afterAll(async () => {
    await client?.$disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts, crashes and stops a server — each report landing in the database', async () => {
    await repo.upsertNode({ id: nodeId, lastHeartbeat: new Date().toISOString() });
    const config = await repo.createServerConfig({ userId: 'u1', name: 'loop', dockerImage: 'nginx', persistPaths: ['/srv'] });
    const { id } = await repo.createDeployment(config.id, nodeId);

    // Start: orchestrator → broker → agent → broker → orchestrator.
    await shared.publishRabbitEvent('infra.server.start', shared.buildEnvelope('orchestrator', { type: 'server.start', payload: startCommandFor(config, id, nodeId) }));
    const running = await until(() => repo.getDeployment(id), (d) => d?.status === 'running', 'running');
    expect(running?.containerId).toMatch(/^c-/);

    // The container dies on its own (#332): the agent notices, the record follows.
    containers.set(running!.containerId!, { running: false, exitCode: 137 });
    await agent.handleContainerEvent({ action: 'die', containerId: running!.containerId!, deploymentId: id, exitCode: 137 });
    const crashed = await until(() => repo.getDeployment(id), (d) => d?.status === 'crashed', 'crashed');
    expect(crashed?.events.at(-1)?.message).toBe('exited with code 137');

    // Start again, then stop: the id is forgotten on stop (#321).
    await shared.publishRabbitEvent('infra.server.start', shared.buildEnvelope('orchestrator', { type: 'server.start', payload: startCommandFor(config, id, nodeId) }));
    const again = await until(() => repo.getDeployment(id), (d) => d?.status === 'running', 'running again');
    await shared.publishRabbitEvent('infra.server.stop', shared.buildEnvelope('orchestrator', { type: 'server.stop', payload: { deploymentId: id, nodeId, containerId: again!.containerId! } }));
    const stopped = await until(() => repo.getDeployment(id), (d) => d?.status === 'stopped', 'stopped');
    expect(stopped?.containerId).toBeNull();
  });
});
