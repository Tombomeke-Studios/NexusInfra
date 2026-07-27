import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'http';
import express from 'express';
import request from 'supertest';
import { INTERNAL_TOKEN_HEADER } from 'shared';
import { requireInternalToken, upgradeAuthorized } from './internalAuth.js';

const TOKEN = 'a-real-secret';

// Mirrors index.ts: /health is mounted before the guard, everything else after.
function app() {
  const a = express();
  a.get('/health', (_req, res) => res.json({ status: 'healthy' }));
  a.use(requireInternalToken(TOKEN));
  a.post('/exec/:id', (_req, res) => res.json({ ok: true }));
  return a;
}

describe('requireInternalToken', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app()).post('/exec/abc');
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong token', async () => {
    const res = await request(app()).post('/exec/abc').set(INTERNAL_TOKEN_HEADER, 'guess');
    expect(res.status).toBe(401);
  });

  it('allows a request with the correct token', async () => {
    const res = await request(app()).post('/exec/abc').set(INTERNAL_TOKEN_HEADER, TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('leaves /health open so probes still work', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('upgradeAuthorized (WebSocket handshake)', () => {
  const reqWith = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;

  it('rejects an upgrade without the token', () => {
    expect(upgradeAuthorized(reqWith({}), TOKEN)).toBe(false);
  });

  it('rejects an upgrade with the wrong token', () => {
    expect(upgradeAuthorized(reqWith({ [INTERNAL_TOKEN_HEADER]: 'guess' }), TOKEN)).toBe(false);
  });

  it('accepts an upgrade carrying the correct token', () => {
    expect(upgradeAuthorized(reqWith({ [INTERNAL_TOKEN_HEADER]: TOKEN }), TOKEN)).toBe(true);
  });
});
