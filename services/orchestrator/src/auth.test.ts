import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createUserService, type UserService } from './users.js';
import {
  createAccountRouter,
  createAuthRouter,
  createUserAdminRouter,
  principalOf,
  requireAuth,
  requirePlatformAdmin,
  signToken,
} from './auth.js';

// A small app: public auth routes, the account routes, and one protected route
// behind requireAuth — enough to exercise the whole login → token → identity path
// against a real in-memory account store.
function buildApp(users: UserService, repo: InMemoryRepository, allowSelfRegistration = false) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter({ users, allowSelfRegistration }));
  app.use(requireAuth);
  app.use(createAccountRouter({ users, repo }));
  app.use(createUserAdminRouter({ users, repo }));
  app.get('/protected', (req, res) => {
    res.json({ userId: (req as express.Request & { userId?: string }).userId, principal: principalOf(req) });
  });
  app.get('/admin-only', requirePlatformAdmin, (_req, res) => res.json({ ok: true }));
  return app;
}

async function seedOwner(users: UserService) {
  await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' });
}

describe('authentication', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    app = buildApp(users, repo);
    await seedOwner(users);
  });

  it('issues a token for valid credentials', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('rejects a bad password with 401', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('gives the same answer for an unknown account as for a wrong password', async () => {
    // Otherwise the login form doubles as a way to discover which emails exist.
    const unknown = await request(app).post('/auth/login').send({ email: 'nobody@example.com', password: 'whatever1' });
    const wrong = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'whatever1' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('carries the user id and platform role through the token', async () => {
    const login = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' });
    const res = await request(app).get('/protected').set('authorization', `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.principal).toMatchObject({ platformRole: 'owner' });
    expect(res.body.userId).toBe(res.body.principal.id);
  });

  it('blocks a protected route without a token', async () => {
    // The removed `dev-user` fallback used to make this a silent success.
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
  });

  it('blocks a protected route with an invalid token', async () => {
    const res = await request(app).get('/protected').set('authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });

  it('defaults an unrecognised role claim to the least privilege', async () => {
    const token = signToken({ id: 'someone', platformRole: 'nonsense' as never });
    const res = await request(app).get('/protected').set('authorization', `Bearer ${token}`);
    expect(res.body.principal).toEqual({ id: 'someone', platformRole: 'user' });
  });
});

describe('self-registration', () => {
  let repo: InMemoryRepository;
  let users: UserService;

  beforeEach(() => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
  });

  it('is refused with 403 when the edition disables it', async () => {
    const app = buildApp(users, repo, false);
    const res = await request(app).post('/auth/register').send({ email: 'ada@example.com', password: 'lovelace1' });
    expect(res.status).toBe(403);
    expect(await repo.countUsers()).toBe(0);
  });

  it('creates an ordinary account and signs the user straight in when enabled', async () => {
    const app = buildApp(users, repo, true);
    const res = await request(app).post('/auth/register').send({ email: 'ada@example.com', password: 'lovelace1' });
    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toMatchObject({ email: 'ada@example.com', platformRole: 'user' });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('never lets a registration claim an elevated role', async () => {
    const app = buildApp(users, repo, true);
    await request(app).post('/auth/register').send({ email: 'ada@example.com', password: 'lovelace1', platformRole: 'owner' });
    expect((await repo.getUserByEmail('ada@example.com'))?.platformRole).toBe('user');
  });
});

describe('account routes', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;
  let token: string;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    app = buildApp(users, repo);
    await seedOwner(users);
    const login = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' });
    token = login.body.token;
  });

  it('returns the caller without their password hash', async () => {
    const res = await request(app).get('/me').set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'admin@local', platformRole: 'owner' });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it('changes a password only with the current one', async () => {
    const bad = await request(app).post('/me/password').set('authorization', `Bearer ${token}`).send({ currentPassword: 'wrong', newPassword: 'newpassword1' });
    expect(bad.status).toBe(401);

    const good = await request(app).post('/me/password').set('authorization', `Bearer ${token}`).send({ currentPassword: 'admin123!', newPassword: 'newpassword1' });
    expect(good.status).toBe(204);
    expect(await users.authenticate('admin@local', 'newpassword1')).not.toBeNull();
  });
});

describe('account administration', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    app = buildApp(users, repo);
    await seedOwner(users);
  });

  const tokenFor = async (email: string, password: string) =>
    (await request(app).post('/auth/login').send({ email, password })).body.token as string;

  it('lets an administrator create the accounts the community edition cannot self-register', async () => {
    const token = await tokenFor('admin@local', 'admin123!');
    const res = await request(app).post('/users').set('authorization', `Bearer ${token}`).send({ email: 'ada@example.com', password: 'lovelace1' });
    expect(res.status).toBe(201);
    expect(await users.authenticate('ada@example.com', 'lovelace1')).not.toBeNull();
  });

  it('refuses account administration to an ordinary user', async () => {
    await users.register({ email: 'ada@example.com', password: 'lovelace1' });
    const token = await tokenFor('ada@example.com', 'lovelace1');

    expect((await request(app).get('/users').set('authorization', `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).post('/users').set('authorization', `Bearer ${token}`).send({ email: 'x@example.com', password: 'password1' })).status).toBe(403);
    expect((await request(app).get('/admin-only').set('authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('rejects an unknown platform role rather than storing it', async () => {
    const token = await tokenFor('admin@local', 'admin123!');
    const res = await request(app).post('/users').set('authorization', `Bearer ${token}`).send({ email: 'ada@example.com', password: 'lovelace1', platformRole: 'superuser' });
    expect(res.status).toBe(400);
  });
});
