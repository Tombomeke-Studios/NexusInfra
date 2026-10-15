import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  requireTokenScope,
  requireTotpEnrolment,
  signToken,
} from './auth.js';
import { createLoginLimiter } from './loginLimiter.js';
import { counterFor, totpCode } from './totp.js';

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
    // `mfa: false` because this token was minted without a second factor being
    // satisfied — the claim is about that login, not about the account (#229).
    expect(res.body.principal).toEqual({ id: 'someone', platformRole: 'user', sessionId: session.id, mfa: false });
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

// Forgetting a password used to mean editing the database by hand (#226). The
// community edition has no mail server to assume, so an administrator sets a new
// one — which makes who may reset whom the whole design question.
describe('password reset by an administrator', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    app = buildApp(users, repo);
    await seedOwner(users);
  });

  async function tokenFor(email: string, password: string) {
    const res = await request(app).post('/auth/login').send({ email, password });
    return res.body.token as string;
  }

  async function makeUser(email: string, password: string, platformRole: 'user' | 'admin' | 'owner' = 'user') {
    const result = await users.register({ email, password, platformRole });
    if (!result.ok) throw new Error(result.error);
    return result.user;
  }

  it('lets an administrator set a new password, which then works', async () => {
    const ada = await makeUser('ada@example.com', 'forgotten-one');
    const admin = await tokenFor('admin@local', 'admin123!');

    await request(app)
      .post(`/users/${ada.id}/password`)
      .set('authorization', `Bearer ${admin}`)
      .send({ newPassword: 'a-fresh-start' })
      .expect(204);

    expect((await request(app).post('/auth/login').send({ email: 'ada@example.com', password: 'a-fresh-start' })).status).toBe(200);
    expect((await request(app).post('/auth/login').send({ email: 'ada@example.com', password: 'forgotten-one' })).status).toBe(401);
  });

  it('signs the account out everywhere', async () => {
    const ada = await makeUser('ada@example.com', 'forgotten-one');
    const hers = await tokenFor('ada@example.com', 'forgotten-one');
    const admin = await tokenFor('admin@local', 'admin123!');

    await request(app).post(`/users/${ada.id}/password`).set('authorization', `Bearer ${admin}`).send({ newPassword: 'a-fresh-start' });

    // A reset is what you do when you think somebody else is in the account, so
    // leaving their token working would defeat the whole exercise (#227).
    expect((await request(app).get('/protected').set('authorization', `Bearer ${hers}`)).status).toBe(401);
  });

  it('refuses to reset an account that outranks the caller', async () => {
    // Otherwise any administrator an owner appoints can lock the owner out and
    // take the installation.
    const owner = await repo.getUserByEmail('admin@local');
    const adminUser = await makeUser('admin2@example.com', 'admin-password', 'admin');
    const adminToken = await tokenFor('admin2@example.com', 'admin-password');

    const res = await request(app)
      .post(`/users/${owner!.id}/password`)
      .set('authorization', `Bearer ${adminToken}`)
      .send({ newPassword: 'taking-over-now' });

    expect(res.status).toBe(403);
    expect((await request(app).post('/auth/login').send({ email: 'admin@local', password: 'admin123!' })).status).toBe(200);
    expect(adminUser.platformRole).toBe('admin');
  });

  it('allows an administrator to reset another administrator', async () => {
    // They already hold the same power; refusing this only makes the panel
    // useless the moment one of two admins forgets a password.
    await makeUser('admin2@example.com', 'admin-password', 'admin');
    const other = await makeUser('admin3@example.com', 'their-password', 'admin');
    const token = await tokenFor('admin2@example.com', 'admin-password');

    await request(app).post(`/users/${other.id}/password`).set('authorization', `Bearer ${token}`).send({ newPassword: 'reset-by-peer' }).expect(204);
  });

  it('is refused to an ordinary user', async () => {
    const ada = await makeUser('ada@example.com', 'her-password');
    await makeUser('bob@example.com', 'his-password');
    const token = await tokenFor('bob@example.com', 'his-password');

    expect(
      (await request(app).post(`/users/${ada.id}/password`).set('authorization', `Bearer ${token}`).send({ newPassword: 'not-yours' })).status
    ).toBe(403);
  });

  it('applies the same password rules as anywhere else', async () => {
    const ada = await makeUser('ada@example.com', 'her-password');
    const admin = await tokenFor('admin@local', 'admin123!');

    const res = await request(app).post(`/users/${ada.id}/password`).set('authorization', `Bearer ${admin}`).send({ newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('404s an account that does not exist', async () => {
    const admin = await tokenFor('admin@local', 'admin123!');
    expect(
      (await request(app).post('/users/nobody/password').set('authorization', `Bearer ${admin}`).send({ newPassword: 'a-fresh-start' })).status
    ).toBe(404);
  });
});

// ── API tokens (#228) ────────────────────────────────────────────────────────
//
// The whole point is a credential a script can hold: it authenticates as the
// account, can be narrowed below what the account may do, and can be withdrawn
// on its own without locking the person out.

describe('API tokens', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;

  /** The real stack: auth, the scope guard, then a read and a write route. */
  function buildTokenApp() {
    const a = express();
    a.use(express.json());
    a.use(createAuthRouter({ users, repo, allowSelfRegistration: false }));
    a.use(createRequireAuth({ repo }));
    a.use(requireTokenScope);
    a.use(createAccountRouter({ users, repo }));
    a.use(createUserAdminRouter({ users, repo }));
    a.get('/things', (req, res) => res.json({ userId: principalOf(req).id }));
    a.post('/things', (_req, res) => res.status(201).json({ ok: true }));
    return a;
  }

  async function signIn(email = 'admin@local', password = 'admin123!') {
    const res = await request(app).post('/auth/login').send({ email, password });
    return res.body.token as string;
  }

  /** Mint a token through the API, as a person would. */
  async function mint(jwt: string, body: Record<string, unknown> = { name: 'ci' }) {
    return request(app).post('/me/tokens').set('Authorization', `Bearer ${jwt}`).send(body);
  }

  beforeEach(async () => {
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' });
    app = buildTokenApp();
  });

  it('shows the secret once, at creation, and never again', async () => {
    const jwt = await signIn();
    const created = await mint(jwt, { name: 'ci', scopes: ['write'] });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^nxi_/);

    const list = await request(app).get('/me/tokens').set('Authorization', `Bearer ${jwt}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ name: 'ci', scopes: ['write'] });
    // Neither the secret nor the digest — a list that returned either would make
    // every row a credential again.
    expect(JSON.stringify(list.body)).not.toContain(created.body.secret);
    expect(list.body[0].tokenHash).toBeUndefined();
  });

  it('authenticates as the account that owns it', async () => {
    const jwt = await signIn();
    const secret = (await mint(jwt)).body.secret as string;

    const me = await request(app).get('/things').set('Authorization', `Bearer ${secret}`);
    expect(me.status).toBe(200);
    const owner = await repo.getUserByEmail('admin@local');
    expect(me.body.userId).toBe(owner!.id);
  });

  it('is read-only unless it was given the write scope', async () => {
    const jwt = await signIn();
    const readOnly = (await mint(jwt, { name: 'reader' })).body.secret as string;
    const writer = (await mint(jwt, { name: 'writer', scopes: ['write'] })).body.secret as string;

    expect((await request(app).get('/things').set('Authorization', `Bearer ${readOnly}`)).status).toBe(200);
    expect((await request(app).post('/things').set('Authorization', `Bearer ${readOnly}`)).status).toBe(403);
    expect((await request(app).post('/things').set('Authorization', `Bearer ${writer}`)).status).toBe(201);
  });

  it('does not administer the panel without the admin scope', async () => {
    // The account here is the installation owner, so this is entirely about the
    // token being narrower than the person behind it.
    const jwt = await signIn();
    const plain = (await mint(jwt, { name: 'ci', scopes: ['write'] })).body.secret as string;
    const admin = (await mint(jwt, { name: 'ops', scopes: ['write', 'admin'] })).body.secret as string;

    expect((await request(app).get('/users').set('Authorization', `Bearer ${plain}`)).status).toBe(403);
    expect((await request(app).get('/users').set('Authorization', `Bearer ${admin}`)).status).toBe(200);
  });

  it('cannot mint another token', async () => {
    // A token that mints tokens cannot really be revoked: withdraw it and its
    // offspring keep working.
    const jwt = await signIn();
    const secret = (await mint(jwt, { name: 'ci', scopes: ['write', 'admin'] })).body.secret as string;

    const res = await request(app).post('/me/tokens').set('Authorization', `Bearer ${secret}`).send({ name: 'child' });
    expect(res.status).toBe(403);
  });

  it('stops working the moment it is revoked', async () => {
    const jwt = await signIn();
    const created = await mint(jwt);
    const secret = created.body.secret as string;
    expect((await request(app).get('/things').set('Authorization', `Bearer ${secret}`)).status).toBe(200);

    expect((await request(app).delete(`/me/tokens/${created.body.id}`).set('Authorization', `Bearer ${jwt}`)).status).toBe(204);
    expect((await request(app).get('/things').set('Authorization', `Bearer ${secret}`)).status).toBe(401);
  });

  it('hides another account’s token behind 404 rather than 403', async () => {
    const jwt = await signIn();
    const created = await mint(jwt);

    const other = await users.register({ email: 'other@example.com', password: 'other12345', platformRole: 'user' });
    if (!other.ok) throw new Error('expected registration to succeed');
    const otherJwt = (await request(app).post('/auth/login').send({ email: 'other@example.com', password: 'other12345' })).body.token;

    const res = await request(app).delete(`/me/tokens/${created.body.id}`).set('Authorization', `Bearer ${otherJwt}`);
    expect(res.status).toBe(404);
    // And it still works, since nothing was deleted.
    expect((await request(app).get('/things').set('Authorization', `Bearer ${created.body.secret}`)).status).toBe(200);
  });

  it('lists only your own tokens', async () => {
    const jwt = await signIn();
    await mint(jwt, { name: 'mine' });
    const other = await users.register({ email: 'other@example.com', password: 'other12345', platformRole: 'user' });
    if (!other.ok) throw new Error('expected registration to succeed');
    const otherJwt = (await request(app).post('/auth/login').send({ email: 'other@example.com', password: 'other12345' })).body.token;

    expect((await request(app).get('/me/tokens').set('Authorization', `Bearer ${otherJwt}`)).body).toEqual([]);
  });

  it('refuses to mint a token that has already expired', async () => {
    const jwt = await signIn();
    expect((await mint(jwt, { name: 'stale', expiresAt: '2020-01-01T00:00:00.000Z' })).status).toBe(400);
    expect((await mint(jwt, { name: 'stale', expiresAt: 'whenever' })).status).toBe(400);
  });

  it('refuses a token that has since expired, without anyone deleting it', async () => {
    const jwt = await signIn();
    const created = await mint(jwt, { name: 'short', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await request(app).get('/things').set('Authorization', `Bearer ${created.body.secret}`)).status).toBe(200);

    // Reach past the API to age it, which is the one thing a test cannot wait for.
    const owner = await repo.getUserByEmail('admin@local');
    const record = (await repo.listApiTokens(owner!.id))[0];
    await repo.deleteApiToken(record.id);
    await repo.createApiToken({
      userId: record.userId,
      name: record.name,
      tokenHash: record.tokenHash,
      scopes: record.scopes,
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    expect((await request(app).get('/things').set('Authorization', `Bearer ${created.body.secret}`)).status).toBe(401);
  });

  it('records that it was used, so a list can show what is still in service', async () => {
    const jwt = await signIn();
    const created = await mint(jwt);
    await request(app).get('/things').set('Authorization', `Bearer ${created.body.secret}`);

    const list = await request(app).get('/me/tokens').set('Authorization', `Bearer ${jwt}`);
    expect(list.body[0].lastUsedAt).not.toBeNull();
  });

  it('needs a name, and refuses a scope it does not recognise', async () => {
    const jwt = await signIn();
    expect((await mint(jwt, { name: '  ' })).status).toBe(400);
    expect((await mint(jwt, { name: 'ci', scopes: ['root'] })).status).toBe(400);
    expect((await mint(jwt, { name: 'ci', scopes: 'write' })).status).toBe(400);
  });

  it('refuses a secret that was never issued', async () => {
    expect((await request(app).get('/things').set('Authorization', 'Bearer nxi_madeup')).status).toBe(401);
  });
});

// ── Two-factor authentication (#229) ─────────────────────────────────────────
//
// The panel hands out root shells inside containers. These exercise the whole
// path a person walks: enrol, prove a code, sign in with one, and get back in
// with a recovery code when the phone is gone.

describe('two-factor authentication', () => {
  let repo: InMemoryRepository;
  let users: UserService;
  let app: express.Express;

  function buildTotpApp() {
    const a = express();
    a.use(express.json());
    a.use(createAuthRouter({ users, repo, allowSelfRegistration: false }));
    a.use(createRequireAuth({ repo }));
    a.use(requireTotpEnrolment);
    a.use(createAccountRouter({ users, repo }));
    a.get('/things', (_req, res) => res.json({ ok: true }));
    return a;
  }

  const login = (body: Record<string, unknown>) => request(app).post('/auth/login').send(body);
  const signIn = async (extra: Record<string, unknown> = {}) =>
    (await login({ email: 'admin@local', password: 'admin123!', ...extra })).body.token as string;

  /** Walk the real enrolment: start, read the secret, prove a code from it. */
  async function enrol(jwt: string) {
    const started = await request(app).post('/me/totp').set('Authorization', `Bearer ${jwt}`).send({});
    const secret = started.body.secret as string;
    const verified = await request(app)
      .post('/me/totp/verify')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ code: totpCode(secret, counterFor(Date.now())) });
    return { secret, verified };
  }

  beforeEach(async () => {
    delete process.env.REQUIRE_TOTP;
    repo = new InMemoryRepository();
    users = createUserService({ repo });
    await users.bootstrapOwner({ email: 'admin@local', password: 'admin123!' });
    app = buildTotpApp();
  });

  afterEach(() => {
    delete process.env.REQUIRE_TOTP;
  });

  it('is off until someone turns it on', async () => {
    const jwt = await signIn();
    const status = await request(app).get('/me/totp').set('Authorization', `Bearer ${jwt}`);
    expect(status.body).toMatchObject({ enabled: false, recoveryCodesRemaining: 0 });
  });

  it('hands out a secret and an otpauth URL an authenticator app can read', async () => {
    const jwt = await signIn();
    const started = await request(app).post('/me/totp').set('Authorization', `Bearer ${jwt}`).send({});
    expect(started.status).toBe(201);
    expect(started.body.otpauthUrl).toContain('otpauth://totp/NexusInfra:admin%40local');
    expect(started.body.otpauthUrl).toContain(`secret=${started.body.secret}`);
  });

  it('changes nothing until a code proves the secret was actually scanned', async () => {
    // An abandoned enrolment must leave the account exactly as it was, rather
    // than behind a code nobody ever saw.
    const jwt = await signIn();
    await request(app).post('/me/totp').set('Authorization', `Bearer ${jwt}`).send({});

    expect((await request(app).get('/me/totp').set('Authorization', `Bearer ${jwt}`)).body.enabled).toBe(false);
    expect((await login({ email: 'admin@local', password: 'admin123!' })).status).toBe(200);
  });

  it('refuses a wrong code and turns it on for a right one, with recovery codes', async () => {
    const jwt = await signIn();
    await request(app).post('/me/totp').set('Authorization', `Bearer ${jwt}`).send({});
    const wrong = await request(app).post('/me/totp/verify').set('Authorization', `Bearer ${jwt}`).send({ code: '000000' });
    expect(wrong.status).toBe(400);

    const user = await repo.getUserByEmail('admin@local');
    const right = await request(app)
      .post('/me/totp/verify')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ code: totpCode(user!.totpSecret!, counterFor(Date.now())) });

    expect(right.status).toBe(201);
    expect(right.body.recoveryCodes).toHaveLength(10);
    // A fresh token, since the one that made the request predates the factor.
    expect(right.body.token).toBeTruthy();
    expect((await request(app).get('/me/totp').set('Authorization', `Bearer ${jwt}`)).body).toMatchObject({
      enabled: true,
      recoveryCodesRemaining: 10,
    });
  });

  it('then asks for a code at every login', async () => {
    const jwt = await signIn();
    const { secret } = await enrol(jwt);

    const withoutCode = await login({ email: 'admin@local', password: 'admin123!' });
    expect(withoutCode.status).toBe(401);
    expect(withoutCode.body.totpRequired).toBe(true);
    // Only ever said to someone who already has the password.
    expect((await login({ email: 'admin@local', password: 'wrong' })).body.totpRequired).toBeUndefined();

    expect((await login({ email: 'admin@local', password: 'admin123!', code: '000000' })).status).toBe(401);
    const ok = await login({ email: 'admin@local', password: 'admin123!', code: totpCode(secret, counterFor(Date.now())) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });

  it('lets a recovery code in exactly once', async () => {
    // The lost-phone case. On a self-hosted panel there is no support desk, so
    // this is the difference between a setback and losing your own machines.
    const jwt = await signIn();
    const { verified } = await enrol(jwt);
    const [code] = verified.body.recoveryCodes as string[];

    expect((await login({ email: 'admin@local', password: 'admin123!', code })).status).toBe(200);
    expect((await login({ email: 'admin@local', password: 'admin123!', code })).status).toBe(401);

    const user = await repo.getUserByEmail('admin@local');
    expect(await repo.countRecoveryCodes(user!.id)).toBe(9);
  });

  it('needs the password to turn off, not just the session', async () => {
    // A session is a thing somebody else may be holding; the password says it is
    // you. Otherwise a stolen session removes the factor and the factor is décor.
    const jwt = await signIn();
    await enrol(jwt);

    expect((await request(app).delete('/me/totp').set('Authorization', `Bearer ${jwt}`).send({})).status).toBe(401);
    expect((await request(app).delete('/me/totp').set('Authorization', `Bearer ${jwt}`).send({ password: 'nope' })).status).toBe(401);

    const off = await request(app).delete('/me/totp').set('Authorization', `Bearer ${jwt}`).send({ password: 'admin123!' });
    expect(off.status).toBe(204);
    expect((await login({ email: 'admin@local', password: 'admin123!' })).status).toBe(200);

    const user = await repo.getUserByEmail('admin@local');
    expect(await repo.countRecoveryCodes(user!.id)).toBe(0);
  });

  describe('when the installation requires it', () => {
    beforeEach(() => {
      process.env.REQUIRE_TOTP = 'true';
    });

    it('still lets an un-enrolled account sign in, but only to enrol', async () => {
      // Refusing the login would lock out everyone the moment the flag flips,
      // including the only administrator, on a panel with no support desk.
      const res = await login({ email: 'admin@local', password: 'admin123!' });
      expect(res.status).toBe(200);
      expect(res.body.mustEnrolTotp).toBe(true);

      const jwt = res.body.token as string;
      const blocked = await request(app).get('/things').set('Authorization', `Bearer ${jwt}`);
      expect(blocked.status).toBe(403);
      expect(blocked.body.enrolmentRequired).toBe(true);

      // The doors that fix it stay open.
      expect((await request(app).get('/me').set('Authorization', `Bearer ${jwt}`)).status).toBe(200);
      expect((await request(app).post('/me/totp').set('Authorization', `Bearer ${jwt}`).send({})).status).toBe(201);
    });

    it('opens everything once enrolment finishes, on the token it hands back', async () => {
      const jwt = (await login({ email: 'admin@local', password: 'admin123!' })).body.token as string;
      const { verified } = await enrol(jwt);
      const fresh = verified.body.token as string;

      // The old token predates the factor and must not be blessed retroactively.
      expect((await request(app).get('/things').set('Authorization', `Bearer ${jwt}`)).status).toBe(403);
      expect((await request(app).get('/things').set('Authorization', `Bearer ${fresh}`)).status).toBe(200);
    });

    it('will not let it be turned off again', async () => {
      const jwt = (await login({ email: 'admin@local', password: 'admin123!' })).body.token as string;
      const { verified } = await enrol(jwt);
      const fresh = verified.body.token as string;

      const res = await request(app).delete('/me/totp').set('Authorization', `Bearer ${fresh}`).send({ password: 'admin123!' });
      expect(res.status).toBe(409);
    });
  });
});
