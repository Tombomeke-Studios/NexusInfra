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
  createRequireAuth,
  requirePlatformAdmin,
  signToken,
} from './auth.js';
import { createLoginLimiter } from './loginLimiter.js';

// A small app: public auth routes, the account routes, and one protected route
// behind requireAuth — enough to exercise the whole login → token → identity path
// against a real in-memory account store.
function buildApp(
  users: UserService,
  repo: InMemoryRepository,
  allowSelfRegistration = false,
  loginLimiter?: ReturnType<typeof createLoginLimiter>
) {
  const app = express();
  app.use(express.json());
  app.use(createAuthRouter({ users, repo, allowSelfRegistration, loginLimiter }));
  app.use(createRequireAuth({ repo }));
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
    const session = await repo.createSession({ userId: 'someone' });
    const token = signToken({ id: 'someone', platformRole: 'nonsense' as never, sessionId: session.id });
    const res = await request(app).get('/protected').set('authorization', `Bearer ${token}`);
    expect(res.body.principal).toEqual({ id: 'someone', platformRole: 'user', sessionId: session.id });
  });
});

// A JWT used to stay valid until it expired no matter what happened to the
// account behind it, so signing out was a client-side gesture (#227).
describe('sessions', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    app = buildApp(users, repo);
    await seedOwner(users);
  });

  async function signIn(password = 'admin123!') {
    const res = await request(app).post('/auth/login').send({ email: 'admin@local', password });
    return res.body.token as string;
  }

  it('gives every login its own session', async () => {
    const first = await signIn();
    const second = await signIn();

    const sessions = (await request(app).get('/me/sessions').set('authorization', `Bearer ${second}`)).body;
    expect(sessions).toHaveLength(2);
    // The caller can tell which one they are using, so "end the others" is safe.
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(first).not.toBe(second);
  });

  it('stops honouring a token the moment its session ends', async () => {
    const token = await signIn();
    expect((await request(app).get('/protected').set('authorization', `Bearer ${token}`)).status).toBe(200);

    await request(app).post('/auth/logout').set('authorization', `Bearer ${token}`).expect(204);

    // Immediately, not whenever the token happened to expire.
    const after = await request(app).get('/protected').set('authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it('refuses a token that names no session at all', async () => {
    // Minted before sessions existed, or by something that does not create them.
    // Either way it cannot be revoked, which is the thing being fixed.
    const token = signToken({ id: 'someone', platformRole: 'user' });
    expect((await request(app).get('/protected').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('refuses a token whose session belongs to somebody else', async () => {
    const session = await repo.createSession({ userId: 'other-person' });
    const token = signToken({ id: 'admin', platformRole: 'owner', sessionId: session.id });
    expect((await request(app).get('/protected').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('ends every other session when the password changes', async () => {
    const laptop = await signIn();
    const phone = await signIn();

    await request(app)
      .post('/me/password')
      .set('authorization', `Bearer ${phone}`)
      .send({ currentPassword: 'admin123!', newPassword: 'a-better-one' })
      .expect(204);

    // The other device is signed out — that is the point of changing a password
    // you think somebody else knows.
    expect((await request(app).get('/protected').set('authorization', `Bearer ${laptop}`)).status).toBe(401);
    // And the one that made the change is not punished for it.
    expect((await request(app).get('/protected').set('authorization', `Bearer ${phone}`)).status).toBe(200);
  });

  it('ends one named session without touching the rest', async () => {
    const laptop = await signIn();
    const phone = await signIn();

    const sessions = (await request(app).get('/me/sessions').set('authorization', `Bearer ${phone}`)).body;
    const other = sessions.find((s: { current: boolean }) => !s.current);

    await request(app).delete(`/me/sessions/${other.id}`).set('authorization', `Bearer ${phone}`).expect(204);
    expect((await request(app).get('/protected').set('authorization', `Bearer ${laptop}`)).status).toBe(401);
    expect((await request(app).get('/protected').set('authorization', `Bearer ${phone}`)).status).toBe(200);
  });

  it('ends every session but the current one on request', async () => {
    const laptop = await signIn();
    const phone = await signIn();

    await request(app).delete('/me/sessions').set('authorization', `Bearer ${phone}`).expect(204);
    expect((await request(app).get('/protected').set('authorization', `Bearer ${laptop}`)).status).toBe(401);
    expect((await request(app).get('/protected').set('authorization', `Bearer ${phone}`)).status).toBe(200);
  });

  it("answers 404 for somebody else's session rather than 403", async () => {
    const token = await signIn();
    const theirs = await repo.createSession({ userId: 'someone-else' });

    // 403 would confirm the session exists; ids are not probeable, same rule as
    // servers (#175).
    const res = await request(app).delete(`/me/sessions/${theirs.id}`).set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(await repo.getSession(theirs.id)).not.toBeNull();
  });

  it('records where a session came from, so it can be recognised', async () => {
    await request(app)
      .post('/auth/login')
      .set('user-agent', 'Firefox on the laptop')
      .send({ email: 'admin@local', password: 'admin123!' });

    const token = await signIn();
    const sessions = (await request(app).get('/me/sessions').set('authorization', `Bearer ${token}`)).body;
    expect(sessions.some((s: { userAgent: string }) => s.userAgent === 'Firefox on the laptop')).toBe(true);
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

// Credential checks were unlimited: the gateway's limiter is bypassed by the
// dashboard's nginx, which proxies /api straight here (#225).
describe('login rate limiting', () => {
  let repo: InMemoryRepository;
  let users: UserService;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    await seedOwner(users);
  });

  function appWithLimiter(now: () => number) {
    return buildApp(users, repo, false, createLoginLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 5000, now }));
  }

  it('locks out after repeated wrong passwords', async () => {
    const app = appWithLimiter(() => 0);

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });
      expect(res.status).toBe(401);
    }

    // Even the correct password is refused once locked out.
    const locked = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' });
    expect(locked.status).toBe(401);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('answers a lockout exactly like a wrong password', async () => {
    const app = appWithLimiter(() => 0);
    const wrong = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });
    for (let i = 0; i < 3; i++) await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });
    const locked = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });

    // A distinct "account locked" reply would confirm the account exists and is
    // worth attacking — the same thing the identical 401 for unknown accounts
    // exists to prevent.
    expect(locked.status).toBe(wrong.status);
    expect(locked.body).toEqual(wrong.body);
  });

  it('does not lock an account that has never been attacked', async () => {
    const app = appWithLimiter(() => 0);
    await users.register({ email: 'ada@example.com', password: 'correct-horse' });
    for (let i = 0; i < 3; i++) await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });

    // Same address, different account: the per-account key is untouched, but the
    // per-IP key is spent — which is the point of checking both.
    const res = await request(app).post('/auth/login').send({ email: 'ada@example.com', password: 'correct-horse' });
    expect(res.status).toBe(401);
  });

  it('lets a correct password through and clears the count', async () => {
    const app = appWithLimiter(() => 0);
    await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });
    await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });

    const ok = await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' });
    expect(ok.status).toBe(200);

    // Someone who mistypes twice and then succeeds starts from zero, so normal
    // use never approaches the limit.
    for (let i = 0; i < 2; i++) await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });
    expect((await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' })).status).toBe(200);
  });

  it('allows attempts again once the lockout expires', async () => {
    let t = 0;
    const app = appWithLimiter(() => t);
    for (let i = 0; i < 3; i++) await request(app).post('/auth/login').send({ email: 'admin@local', password: 'wrong' });

    t = 5001;
    expect((await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' })).status).toBe(200);
  });

  it('limits registration too, the other unauthenticated write', async () => {
    const t = 0;
    const app = buildApp(users, repo, true, createLoginLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 5000, now: () => t }));

    // Failed registrations (too-short password) burn the address's budget.
    for (let i = 0; i < 3; i++) {
      await request(app).post('/auth/register').send({ email: `x${i}@example.com`, password: 'short' });
    }
    const res = await request(app).post('/auth/register').send({ email: 'ok@example.com', password: 'long-enough-1' });
    expect(res.status).toBe(429);
  });
});
