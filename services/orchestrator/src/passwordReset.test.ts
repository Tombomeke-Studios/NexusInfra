import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { InMemoryRepository } from './repository.js';
import { createUserService } from './users.js';
import { createLoginLimiter } from './loginLimiter.js';
import { createPasswordResetRouter, hashResetToken, mintResetToken, parsePanelUrl, resetAvailable, resetLink, RESET_TTL_MS } from './passwordReset.js';

// Self-service password reset by email (#344).

describe('reset tokens', () => {
  it('are 256 random bits, stored only as a digest', () => {
    const a = mintResetToken();
    const b = mintResetToken();
    expect(Buffer.from(a.secret, 'base64url')).toHaveLength(32);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toBe(hashResetToken(a.secret));
    expect(a.hash).not.toContain(a.secret);
  });
});

describe('parsePanelUrl', () => {
  it('accepts an http(s) address and drops a trailing slash', () => {
    expect(parsePanelUrl('https://panel.example.com/')).toBe('https://panel.example.com');
    expect(parsePanelUrl('http://10.0.0.5:8095/nexus/')).toBe('http://10.0.0.5:8095/nexus');
  });
  it('refuses anything that would put a strange link in a mail', () => {
    expect(parsePanelUrl(undefined)).toBeNull();
    expect(parsePanelUrl('panel.example.com')).toBeNull();
    expect(parsePanelUrl('javascript:alert(1)')).toBeNull();
    expect(parsePanelUrl('https://user:pw@panel.example.com')).toBeNull();
  });
  it('builds the link from it, with the secret encoded', () => {
    expect(resetLink('https://p.example', 'a-b_c')).toBe('https://p.example/reset-password?token=a-b_c');
  });
});

describe('resetAvailable', () => {
  it('needs both mail and a public address', () => {
    const send = async () => undefined;
    expect(resetAvailable({ panelUrl: 'https://p', sendMail: send })).toBe(true);
    expect(resetAvailable({ panelUrl: null, sendMail: send })).toBe(false);
    expect(resetAvailable({ panelUrl: 'https://p', sendMail: null })).toBe(false);
  });
});

describe('password reset routes', () => {
  let repo: InMemoryRepository;
  let mails: Array<{ to: string; subject: string; text: string }>;
  let deferred: Array<Promise<void>>;
  let clock: number;
  let app: express.Express;
  const users = () => createUserService({ repo });

  function build(overrides: Partial<Parameters<typeof createPasswordResetRouter>[0]> = {}) {
    const a = express();
    a.use(express.json());
    a.use(
      createPasswordResetRouter({
        repo,
        users: users(),
        panelUrl: 'https://panel.example',
        sendMail: async (to, subject, text) => void mails.push({ to, subject, text }),
        now: () => clock,
        defer: (task) => void deferred.push(task()),
        ...overrides,
      })
    );
    return a;
  }

  const settle = () => Promise.all(deferred);
  const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s]+)/.exec(text)![1]);

  beforeEach(async () => {
    repo = new InMemoryRepository();
    mails = [];
    deferred = [];
    clock = Date.UTC(2026, 8, 25, 12);
    await users().register({ email: 'Ada@Example.com', password: 'old-password-1', displayName: 'Ada' });
    app = build();
  });

  it('mails a single-use link, and the new password works', async () => {
    const asked = await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    expect(asked.status).toBe(202);
    await settle();

    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('ada@example.com');
    expect(mails[0].text).toContain('https://panel.example/reset-password?token=');
    const token = tokenFrom(mails[0].text);

    expect((await request(app).post('/auth/password-reset/confirm').send({ token, newPassword: 'new-password-2' })).status).toBe(204);
    expect(await users().authenticate('ada@example.com', 'new-password-2')).not.toBeNull();
    expect(await users().authenticate('ada@example.com', 'old-password-1')).toBeNull();

    // Single-use.
    const again = await request(app).post('/auth/password-reset/confirm').send({ token, newPassword: 'third-password-3' });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/invalid, has expired, or has already been used/);
  });

  it('answers an unknown address exactly like a known one, and mails nobody', async () => {
    const known = await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    const unknown = await request(app).post('/auth/password-reset').send({ email: 'nobody@example.com' });
    await settle();
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(mails.map((m) => m.to)).toEqual(['ada@example.com']);
  });

  it('expires a link after its time', async () => {
    await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    await settle();
    clock += RESET_TTL_MS + 1;
    const res = await request(app).post('/auth/password-reset/confirm').send({ token: tokenFrom(mails[0].text), newPassword: 'new-password-2' });
    expect(res.status).toBe(400);
  });

  it('only the newest link works', async () => {
    await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    await settle();
    const [first, second] = mails.map((m) => tokenFrom(m.text));
    expect((await request(app).post('/auth/password-reset/confirm').send({ token: first, newPassword: 'new-password-2' })).status).toBe(400);
    expect((await request(app).post('/auth/password-reset/confirm').send({ token: second, newPassword: 'new-password-2' })).status).toBe(204);
  });

  it('does not spend the link on a password the rules refuse', async () => {
    await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    await settle();
    const token = tokenFrom(mails[0].text);
    const weak = await request(app).post('/auth/password-reset/confirm').send({ token, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect((await request(app).post('/auth/password-reset/confirm').send({ token, newPassword: 'new-password-2' })).status).toBe(204);
  });

  it('ends every session of the account', async () => {
    const user = await repo.getUserByEmail('ada@example.com');
    await repo.createSession({ userId: user!.id, userAgent: 'x', ipAddress: '1.2.3.4' });
    await request(app).post('/auth/password-reset').send({ email: 'ada@example.com' });
    await settle();
    await request(app).post('/auth/password-reset/confirm').send({ token: tokenFrom(mails[0].text), newPassword: 'new-password-2' });
    expect(await repo.listSessions(user!.id)).toEqual([]);
  });

  it('refuses a made-up token', async () => {
    const res = await request(app).post('/auth/password-reset/confirm').send({ token: 'made-up', newPassword: 'new-password-2' });
    expect(res.status).toBe(400);
  });

  it('limits requests per address, so one mailbox cannot be flooded', async () => {
    const limited = build({ limiter: createLoginLimiter({ maxAttempts: 2, now: () => clock }) });
    expect((await request(limited).post('/auth/password-reset').send({ email: 'ada@example.com' })).status).toBe(202);
    expect((await request(limited).post('/auth/password-reset').send({ email: 'ada@example.com' })).status).toBe(202);
    const third = await request(limited).post('/auth/password-reset').send({ email: 'ada@example.com' });
    expect(third.status).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('says so plainly where the installation cannot send the mail', async () => {
    const off = build({ sendMail: null });
    const res = await request(off).post('/auth/password-reset').send({ email: 'ada@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/ask an administrator/);
  });
});
