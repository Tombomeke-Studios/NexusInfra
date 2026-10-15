import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { INTERNAL_TOKEN_HEADER } from 'shared';
import { requireInternalToken } from './internalAuth.js';

function app() {
  const a = express();
  a.get('/health', (_req, res) => res.json({ status: 'healthy' }));
  a.use(requireInternalToken('the-token'));
  a.get('/billing/u1/wallet', (_req, res) => res.json({ balance: 5 }));
  return a;
}

describe('the Billing Bridge internal token (#372)', () => {
  it('refuses a caller without the token, or with the wrong one', async () => {
    expect((await request(app()).get('/billing/u1/wallet')).status).toBe(401);
    expect((await request(app()).get('/billing/u1/wallet').set(INTERNAL_TOKEN_HEADER, 'guess')).status).toBe(401);
  });

  it('serves a caller that holds it', async () => {
    const res = await request(app()).get('/billing/u1/wallet').set(INTERNAL_TOKEN_HEADER, 'the-token');
    expect(res.body).toEqual({ balance: 5 });
  });

  it('leaves the health probe open', async () => {
    expect((await request(app()).get('/health')).status).toBe(200);
  });
});
