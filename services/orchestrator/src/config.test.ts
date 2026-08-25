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
    expect(res.body).toEqual({ edition: 'community' });
  });

  it('reports the hosted edition when configured', async () => {
    const app = express().use(createConfigRouter('hosted'));
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ edition: 'hosted' });
  });

  it('requires no authentication', async () => {
    const app = express().use(createConfigRouter('community'));
    const res = await request(app).get('/config'); // no Authorization header
    expect(res.status).toBe(200);
  });
});
