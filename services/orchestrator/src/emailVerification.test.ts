import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createEmailVerification, topUpProblem, VERIFY_TTL_MS, verifyLink } from './emailVerification.js';
import { createUserService, toPublicUser } from './users.js';
import { createPasswordResetRouter, hashResetToken, mintResetToken } from './passwordReset.js';
import { createBillingProxyRouter } from './billingProxy.js';
import type { UserRecord } from './types.js';

const PANEL = 'https://panel.example';

describe('email confirmation (#367)', () => {
  let repo: InMemoryRepository;
  let mails: Array<{ to: string; subject: string; text: string }>;
  let pending: Array<() => Promise<void>>;
  let clock: number;
  let user: UserRecord;

  const build = (over: Partial<Parameters<typeof createEmailVerification>[0]> = {}) =>
    createEmailVerification({
      repo,
      panelUrl: PANEL,
      sendMail: async (to, subject, text) => void mails.push({ to, subject, text }),
      now: () => clock,
      defer: (task) => void pending.push(task),
      ...over,
    });
  const flush = async () => {
    for (const task of pending.splice(0)) await task();
  };
  const tokenIn = (text: string) => decodeURIComponent(text.match(/token=([^\s]+)/)![1]);

  function appAs(verification: ReturnType<typeof build>, userId?: string) {
    const app = express();
    app.use(express.json());
    app.use(verification.publicRouter());
    app.use((req, _res, next) => {
      (req as express.Request & { principal?: unknown }).principal = { id: userId, platformRole: 'user' };
      next();
    });
    app.use(verification.accountRouter());
    return app;
  }

  beforeEach(async () => {
    repo = new InMemoryRepository();
    mails = [];
    pending = [];
    clock = Date.parse('2026-10-14T10:00:00.000Z');
    user = await repo.createUser({ id: 'u1', email: 'ada@example.com', displayName: 'Ada', passwordHash: '!', platformRole: 'user' });
  });

  it('mails a link built from the panel’s address, and confirms the account when it is opened', async () => {
    const verification = build();
    verification.sendAfterSignup(user);
    await flush();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('ada@example.com');
    expect(mails[0].text).toContain(`${PANEL}/verify-email?token=`);

    const res = await request(appAs(verification)).post('/auth/verify-email/confirm').send({ token: tokenIn(mails[0].text) });
    expect(res.status).toBe(200);
    expect((await repo.getUser('u1'))?.emailVerifiedAt).toBe('2026-10-14T10:00:00.000Z');
  });

  it('accepts a link once, and not after it has expired', async () => {
    const verification = build();
    const app = appAs(verification);
    await verification.send(user);
    const token = tokenIn(mails[0].text);
    expect((await request(app).post('/auth/verify-email/confirm').send({ token })).status).toBe(200);
    expect((await request(app).post('/auth/verify-email/confirm').send({ token })).status).toBe(400);

    const other = await repo.createUser({ id: 'u2', email: 'bob@example.com', displayName: 'Bob', passwordHash: '!', platformRole: 'user' });
    await verification.send(other);
    clock += VERIFY_TTL_MS + 1;
    expect((await request(app).post('/auth/verify-email/confirm').send({ token: tokenIn(mails[1].text) })).status).toBe(400);
    expect((await repo.getUser('u2'))?.emailVerifiedAt).toBeNull();
  });

  it('lets only the newest link work', async () => {
    const verification = build();
    const app = appAs(verification);
    await verification.send(user);
    await verification.send(user);
    expect((await request(app).post('/auth/verify-email/confirm').send({ token: tokenIn(mails[0].text) })).status).toBe(400);
    expect((await request(app).post('/auth/verify-email/confirm').send({ token: tokenIn(mails[1].text) })).status).toBe(200);
  });

  it('refuses a made-up token without saying why', async () => {
    const res = await request(appAs(build())).post('/auth/verify-email/confirm').send({ token: 'guess' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid, has expired, or has already been used/);
  });

  it('sends the signed-in account its own link again, a limited number of times', async () => {
    const verification = build();
    const app = appAs(verification, 'u1');
    const res = await request(app).post('/me/verify-email');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'sent', email: 'ada@example.com' });
    await flush();
    expect(mails).toHaveLength(1);

    for (let i = 0; i < 4; i++) await request(app).post('/me/verify-email');
    expect((await request(app).post('/me/verify-email')).status).toBe(429);
  });

  it('has nothing to send an account that is already confirmed', async () => {
    await repo.setUserEmailVerified('u1', new Date(clock).toISOString());
    const verification = build();
    const res = await request(appAs(verification, 'u1')).post('/me/verify-email');
    expect(res.body).toEqual({ status: 'verified' });
    await flush();
    expect(mails).toEqual([]);
  });

  it('is not offered without mail or without a public address', async () => {
    for (const off of [build({ sendMail: null }), build({ panelUrl: null })]) {
      expect(off.available).toBe(false);
      off.sendAfterSignup(user);
      await flush();
      expect((await request(appAs(off, 'u1')).post('/me/verify-email')).status).toBe(404);
    }
    expect(mails).toEqual([]);
  });

  it('never builds the link from anything but the configured address', () => {
    expect(verifyLink(PANEL, 'a b')).toBe('https://panel.example/verify-email?token=a%20b');
  });
});

describe('who starts out confirmed (#367)', () => {
  it('a self-registration does not; an account an administrator makes does', async () => {
    const repo = new InMemoryRepository();
    const users = createUserService({ repo });
    const self = await users.register({ email: 'self@example.com', password: 'a-long-enough-password' });
    const made = await users.register({ email: 'made@example.com', password: 'a-long-enough-password', verified: true });
    expect(self.ok && toPublicUser(self.user).emailVerified).toBe(false);
    expect(made.ok && toPublicUser(made.user).emailVerified).toBe(true);
  });

  it('the first administrator does', async () => {
    const repo = new InMemoryRepository();
    await createUserService({ repo }).bootstrapOwner({ email: 'owner@host.example', password: 'a-long-enough-password' });
    expect((await repo.getUserByEmail('owner@host.example'))?.emailVerifiedAt).toBeTruthy();
  });

  // A reset link reaching the mailbox proves the same thing a confirmation link does.
  it('a password reset by mail confirms the address too', async () => {
    const repo = new InMemoryRepository();
    const users = createUserService({ repo });
    const created = await users.register({ email: 'ada@example.com', password: 'a-long-enough-password' });
    if (!created.ok) throw new Error('setup');
    const { secret, hash } = mintResetToken();
    await repo.createPasswordReset({ userId: created.user.id, tokenHash: hash, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(hashResetToken(secret)).toBe(hash);

    const app = express();
    app.use(express.json());
    app.use(createPasswordResetRouter({ repo, users, panelUrl: PANEL, sendMail: async () => undefined }));
    expect((await request(app).post('/auth/password-reset/confirm').send({ token: secret, newPassword: 'another-long-password' })).status).toBe(204);
    expect((await repo.getUser(created.user.id))?.emailVerifiedAt).toBeTruthy();
  });
});

describe('topping up needs a confirmed address (#367)', () => {
  it('only where confirming is possible', () => {
    expect(topUpProblem({ emailVerifiedAt: null }, true)).toMatch(/confirm your email address first/);
    expect(topUpProblem({ emailVerifiedAt: '2026-10-14T10:00:00.000Z' }, true)).toBeNull();
    // No mail configured: a rule nobody can satisfy would lock everyone out of paying.
    expect(topUpProblem({ emailVerifiedAt: null }, false)).toBeNull();
    expect(topUpProblem(null, true)).toMatch(/no email address/);
  });

  it('is refused by the billing proxy before the bridge is asked', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { userId?: string }).userId = 'u1';
      next();
    });
    app.use(createBillingProxyRouter({ emailOf: async () => 'ada@example.com', topUpProblem: async () => 'confirm your email address first' }));
    const res = await request(app).post('/billing/topup').send({ amount: 20 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/confirm your email/);
  });
});
