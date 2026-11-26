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

describe('during a token rotation', () => {
  function rotating() {
    const a = express();
    a.use(requireInternalToken(['new-token', 'old-token']));
    a.get('/billing/u1/wallet', (_req, res) => res.json({ balance: 5 }));
    return a;
  }

  it('serves a caller still holding the previous token', async () => {
    for (const token of ['new-token', 'old-token']) {
      expect((await request(rotating()).get('/billing/u1/wallet').set(INTERNAL_TOKEN_HEADER, token)).status).toBe(200);
    }
  });

  it('refuses any other token', async () => {
    expect((await request(rotating()).get('/billing/u1/wallet').set(INTERNAL_TOKEN_HEADER, 'older-token')).status).toBe(401);
  });
});
