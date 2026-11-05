import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConfigRouter } from './config.js';

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
