import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuthRouter, requireAuth, signToken } from './auth.js';

// A small app: public login + one protected route guarded by requireAuth.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter());
  app.get('/protected', requireAuth, (req, res) => {
    res.json({ userId: (req as express.Request & { userId?: string }).userId });
  });
  return app;
}

describe('stub auth', () => {
  const app = buildApp();

  it('issues a token for the seeded dev user', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'admin', password: 'admin' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('rejects bad credentials with 401', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('allows a protected route with a valid token and exposes the user id', async () => {
    const login = await request(app).post('/auth/login').send({ username: 'admin', password: 'admin' });
    const res = await request(app).get('/protected').set('authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('admin');
  });

  it('blocks a protected route without a token', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('blocks a protected route with an invalid token', async () => {
    const res = await request(app).get('/protected').set('authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('signs a token whose subject is the user id', async () => {
    const token = signToken('someone');
    const res = await request(app).get('/protected').set('authorization', `Bearer ${token}`);
    expect(res.body.userId).toBe('someone');
  });
});
