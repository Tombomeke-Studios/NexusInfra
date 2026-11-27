import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSystemRouter, featureChecklist, probeHealth, systemReport, versionProblem, type ComponentReport, type SystemDeps } from './systemReport.js';
import type { NodeRecord } from './types.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const row = (over: Partial<ComponentReport>): ComponentReport => ({ service: 's', label: 'S', reachable: true, version: '0.5.0', edition: 'hosted', ...over });
const byId = (items: ReturnType<typeof featureChecklist>) => Object.fromEntries(items.map((i) => [i.id, i]));

describe('featureChecklist (#447)', () => {
  it('warns about insecure defaults on a bare installation', () => {
    const f = byId(featureChecklist({}, false));
    expect(f['jwt-secret'].state).toBe('warning');
    expect(f['internal-token'].state).toBe('warning');
    expect(f.mail.state).toBe('off');
    expect(f['password-reset'].summary).toContain('SMTP_URL and PANEL_URL');
    // Community has no billing rows.
    expect(f['qr-topup']).toBeUndefined();
  });

  it('says which half is missing for a feature that needs two settings', () => {
    expect(byId(featureChecklist({ SMTP_URL: 'smtp://mail' }, false))['password-reset'].summary).toMatch(/needs PANEL_URL\./);
  });

  it('turns rows on as their variables are set', () => {
    const f = byId(
      featureChecklist({ JWT_SECRET: 'x'.repeat(40), INTERNAL_API_TOKEN: 'y'.repeat(40), SMTP_URL: 'smtp://m', PANEL_URL: 'https://p', SFTP_PORT: '2022', SFTP_PUBLIC_PORT: '22', METRICS_TOKEN: 't' }, false),
    );
    for (const id of ['jwt-secret', 'internal-token', 'mail', 'password-reset', 'sftp', 'metrics-token']) expect(f[id].state).toBe('on');
    expect(f.sftp.summary).toContain('port 22');
  });

  it('adds the hosted rows: QR needs a valid payee, test tools are a warning', () => {
    const f = byId(featureChecklist({ FINVAULT_MERCHANT_NAME: 'NexusInfra', FINVAULT_MERCHANT_IBAN: 'not an iban', BILLING_TEST_TOOLS: 'true' }, true));
    expect(f['qr-topup'].state).toBe('off');
    expect(f['finvault-key'].state).toBe('warning');
    expect(f['billing-test-tools'].state).toBe('warning');
    expect(byId(featureChecklist({ FINVAULT_MERCHANT_NAME: 'NexusInfra', FINVAULT_MERCHANT_IBAN: 'BE89 3770 0771 9941' }, true))['qr-topup'].state).toBe('on');
  });

  it('names variables, never their values', () => {
    const secret = 'super-secret-value-123';
    const text = JSON.stringify(featureChecklist({ JWT_SECRET: secret, INTERNAL_API_TOKEN: secret, SMTP_URL: `smtp://u:${secret}@m`, METRICS_TOKEN: secret, FINVAULT_MESSAGE_KEY: secret }, true));
    expect(text).not.toContain(secret);
  });
});

describe('versionProblem', () => {
  it('is quiet when every part that answered agrees, or is a dev build', () => {
    expect(versionProblem([row({}), row({ label: 'B' }), row({ label: 'C', reachable: false, version: null }), row({ label: 'D', version: '0.0.0-dev' })])).toBeNull();
  });

  it('names who runs what when they disagree', () => {
    const problem = versionProblem([row({ label: 'Orchestrator' }), row({ label: 'Node agent · one', version: '0.4.1' })]);
    expect(problem).toContain('Orchestrator on 0.5.0');
    expect(problem).toContain('Node agent · one on 0.4.1');
  });
});

describe('probeHealth', () => {
  const base = { service: 'control-room', label: 'Control Room' };
  it('reads version and edition', async () => {
    expect(await probeHealth(base, async () => json({ version: '0.5.0', edition: 'hosted' }))).toMatchObject({ reachable: true, version: '0.5.0', edition: 'hosted' });
  });
  it('turns an error status, a refusal and a silence into a row', async () => {
    expect(await probeHealth(base, async () => json({}, 401))).toMatchObject({ reachable: false, problem: 'answered 401' });
    expect(await probeHealth(base, async () => { throw new Error('ECONNREFUSED'); })).toMatchObject({ reachable: false, problem: 'could not be reached' });
    const silent = (signal: AbortSignal) => new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await probeHealth(base, silent, 20)).toMatchObject({ reachable: false, problem: expect.stringContaining('no answer') });
  });
});

const node = (id: string, name: string) => ({ id, name }) as NodeRecord;

function deps(over: Partial<SystemDeps> = {}): SystemDeps {
  return {
    self: { version: '0.5.0', edition: 'hosted' },
    env: {},
    hosted: true,
    listNodes: async () => [node('n1', 'alpha'), node('n2', 'beta')],
    agentUrlFor: async (id) => `http://agent-${id}`,
    agentFetch: async (url) => (url.includes('n2') ? json({ version: '0.4.1', edition: 'hosted' }) : json({ version: '0.5.0', edition: 'hosted' })),
    bridgeFetch: async () => json({ version: '0.5.0', edition: 'hosted' }),
    controlRoomUrl: 'http://control-room',
    fetch: (async () => { throw new Error('down'); }) as unknown as typeof fetch,
    ...over,
  };
}

describe('systemReport', () => {
  it('reports every part, a dead one included, and the version split', async () => {
    const report = await systemReport(deps());
    expect(report.components.map((c) => [c.label, c.reachable])).toEqual([
      ['Orchestrator', true],
      ['Control Room', false],
      ['Billing Bridge', true],
      ['Node agent · alpha', true],
      ['Node agent · beta', true],
    ]);
    expect(report.versionProblem).toContain('Node agent · beta on 0.4.1');
  });

  it('does not ask for a billing bridge in the community edition', async () => {
    const report = await systemReport(deps({ hosted: false }));
    expect(report.components.some((c) => c.service === 'billing-bridge')).toBe(false);
  });
});

describe('GET /admin/system', () => {
  const appAs = (platformRole: 'user' | 'admin') =>
    express()
      .use((req, _res, next) => {
        (req as express.Request & { principal?: unknown }).principal = { id: 'u1', platformRole };
        next();
      })
      .use(createSystemRouter(deps()));

  it('is for platform administrators only', async () => {
    expect((await request(appAs('user')).get('/admin/system')).status).toBe(403);
    const res = await request(appAs('admin')).get('/admin/system');
    expect(res.status).toBe(200);
    expect(res.body.features.length).toBeGreaterThan(5);
  });
});
