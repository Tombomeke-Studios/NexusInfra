import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConfigRouter, finvaultFromEnv } from './config.js';

// /config is public (mounted before requireAuth) so the dashboard can read the
// edition before login. It must never require a token.

describe('GET /config', () => {
  it('reports the community edition by default', async () => {
    const app = express().use(createConfigRouter('community'));
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ edition: 'community', passwordResetByEmail: false, sftpPort: null, emailVerification: false, features: ['agent-link'] });
  });

  it('reports the hosted edition when configured', async () => {
    const app = express().use(createConfigRouter('hosted'));
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ edition: 'hosted', passwordResetByEmail: false, sftpPort: null, emailVerification: false, features: ['agent-link'] });
  });

  it('says whether a forgotten password can be reset by email (#344)', async () => {
    const app = express().use(createConfigRouter('community', { passwordResetByEmail: true }));
    expect((await request(app).get('/config')).body.passwordResetByEmail).toBe(true);
  });

  it('tells the panel which port SFTP listens on, or null when it is off (#235)', async () => {
    const app = express().use(createConfigRouter('community', { sftpPort: 2022 }));
    expect((await request(app).get('/config')).body.sftpPort).toBe(2022);
  });

  it('lists the agent link among its features, so a client can ask before relying on it (#416)', async () => {
    const app = express().use(createConfigRouter('community'));
    expect((await request(app).get('/config')).body.features).toContain('agent-link');
  });

  it('requires no authentication', async () => {
    const app = express().use(createConfigRouter('community'));
    const res = await request(app).get('/config'); // no Authorization header
    expect(res.status).toBe(200);
  });
});

describe('FinVault payment details (#435, #436)', () => {
  const finvault = { url: 'https://finvault.example', payee: { name: 'NexusInfra', iban: 'BE89377007719941' } };

  it('tells a hosted panel where to pay a top-up', async () => {
    const app = express().use(createConfigRouter('hosted', { finvault }));
    expect((await request(app).get('/config')).body.finvault).toEqual(finvault);
  });

  it('never tells a community panel, which has no billing', async () => {
    const app = express().use(createConfigRouter('community', { finvault }));
    expect((await request(app).get('/config')).body).not.toHaveProperty('finvault');
  });

  it('reads FINVAULT_URL and the payee from the environment', () => {
    expect(finvaultFromEnv({ FINVAULT_URL: 'https://finvault.example/', FINVAULT_MERCHANT_NAME: ' NexusInfra ', FINVAULT_MERCHANT_IBAN: 'be89 3770 0771 9941' }))
      .toEqual({ url: 'https://finvault.example', payee: { name: 'NexusInfra', iban: 'BE89377007719941' } });
  });

  it('gives each half on its own, and nothing when neither is set', () => {
    expect(finvaultFromEnv({})).toBeNull();
    expect(finvaultFromEnv({ FINVAULT_URL: 'https://finvault.example' })).toEqual({ url: 'https://finvault.example', payee: null });
    expect(finvaultFromEnv({ FINVAULT_MERCHANT_NAME: 'N', FINVAULT_MERCHANT_IBAN: 'BE89377007719941' })).toEqual({ url: null, payee: { name: 'N', iban: 'BE89377007719941' } });
  });

  it('refuses what it would only get wrong: a link that is not http(s), a malformed IBAN, a name without an IBAN', () => {
    expect(finvaultFromEnv({ FINVAULT_URL: 'javascript:alert(1)' })).toBeNull();
    expect(finvaultFromEnv({ FINVAULT_MERCHANT_NAME: 'N', FINVAULT_MERCHANT_IBAN: 'not an iban' })).toBeNull();
    expect(finvaultFromEnv({ FINVAULT_MERCHANT_NAME: 'N' })).toBeNull();
  });
});

describe('the billing test tools flag (#439)', () => {
  it('is only ever there in hosted, and only when switched on', async () => {
    const on = express().use(createConfigRouter('hosted', { billingTestTools: true }));
    expect((await request(on).get('/config')).body.billingTestTools).toBe(true);
    const community = express().use(createConfigRouter('community', { billingTestTools: true }));
    expect((await request(community).get('/config')).body).not.toHaveProperty('billingTestTools');
    const off = express().use(createConfigRouter('hosted'));
    expect((await request(off).get('/config')).body).not.toHaveProperty('billingTestTools');
  });
});
