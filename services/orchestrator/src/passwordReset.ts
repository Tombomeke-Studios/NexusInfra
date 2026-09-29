import { createHash, randomBytes } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { createLoginLimiter, type LoginLimiter } from './loginLimiter.js';
import { normalizeEmail, passwordProblem, type UserService } from './users.js';
import type { Repository } from './types.js';

// Self-service password reset by email (#344) — the half of #226 that had to
// wait for a way to send mail.
//
// The rules, and why:
//
// - **Only with a known public address.** The link in the mail is built from
//   `PANEL_URL`, never from the request's Host header: a reset link built from
//   Host is the classic way to have a victim's reset token delivered to a site
//   the attacker chose. No PANEL_URL, no self-service reset.
// - **The same answer for every address.** Whether the account exists is not
//   the requester's business, so the response is identical and the mail goes out
//   after it — the time taken does not tell either.
// - **The token is a secret like an API token**: 256 random bits, stored only as
//   its SHA-256 digest (bcrypt would only slow down checking a value nobody can
//   guess), single-use, and gone after RESET_TTL_MS. Asking again supersedes it.
// - **A reset ends every session.** It is what you do when you think somebody
//   else has been in the account.
// - **Two-factor stays on.** A mailbox is one factor; the next login still asks
//   for the code.

export const RESET_TTL_MS = 30 * 60 * 1000;

/** A fresh reset secret and the digest that is stored in its place. */
export function mintResetToken(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: hashResetToken(secret) };
}

export function hashResetToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * The installation's public address, or null when it is not a usable one.
 * An http(s) origin plus optional path; anything else would put a link in a
 * mail that goes nowhere, or somewhere unintended.
 */
export function parsePanelUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export function resetLink(panelUrl: string, secret: string): string {
  return `${panelUrl}/reset-password?token=${encodeURIComponent(secret)}`;
}

export function resetEmail(link: string): { subject: string; text: string } {
  return {
    subject: 'Reset your NexusInfra password',
    text: [
      'Somebody asked to reset the password of the NexusInfra account for this address.',
      '',
      `To choose a new password, open this link within ${RESET_TTL_MS / 60000} minutes:`,
      link,
      '',
      'The link works once. If you did not ask for this, ignore this mail — your password stays as it is.',
    ].join('\n'),
  };
}

export interface PasswordResetDeps {
  repo: Repository;
  users: Pick<UserService, 'resetPassword'>;
  /** Null when self-service reset is off (no mail, or no public address). */
  panelUrl: string | null;
  sendMail: ((to: string, subject: string, text: string) => Promise<void>) | null;
  limiter?: LoginLimiter;
  now?: () => number;
  /** Runs the mail after the response; tests await it, production does not. */
  defer?: (task: () => Promise<void>) => void;
}

/** Whether the installation can offer a self-service reset — shown by `GET /config`. */
export function resetAvailable(deps: Pick<PasswordResetDeps, 'panelUrl' | 'sendMail'>): boolean {
  return Boolean(deps.panelUrl && deps.sendMail);
}

/** The one answer to every reset request, whatever the address. */
const REQUESTED = { status: 'requested', message: 'If an account uses that address, a link to reset its password is on its way.' };
const INVALID = 'this reset link is invalid, has expired, or has already been used';

export function createPasswordResetRouter(deps: PasswordResetDeps): Router {
  const { repo, users } = deps;
  const now = deps.now ?? Date.now;
  // Separate from the login limiter: asking for mail is not a failed password,
  // and someone locked out of signing in must still be able to ask for a reset.
  const limiter = deps.limiter ?? createLoginLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 });
  const defer =
    deps.defer ??
    ((task: () => Promise<void>) => {
      setImmediate(() => void task().catch((err) => console.error('[Orchestrator] password reset mail failed:', err instanceof Error ? err.message : err)));
    });
  const router = Router();

  router.post('/auth/password-reset', async (req: Request, res: Response) => {
    if (!resetAvailable(deps)) {
      return res.status(404).json({ error: 'password reset by email is not available on this installation; ask an administrator' });
    }
    const email = normalizeEmail(String((req.body ?? {}).email ?? ''));
    if (!email.includes('@')) return res.status(400).json({ error: 'enter the email address of the account' });

    // Both keys count every request: a request is itself the thing to limit, and
    // counting per address stops one mailbox from being flooded.
    const keys = [`ip:${req.ip ?? 'unknown'}`, `email:${email}`];
    const verdict = limiter.check(keys);
    if (!verdict.allowed) {
      res.setHeader('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'too many reset requests; try again later' });
    }
    limiter.fail(keys);

    defer(async () => {
      const user = await repo.getUserByEmail(email);
      if (!user) return;
      const { secret, hash } = mintResetToken();
      await repo.createPasswordReset({ userId: user.id, tokenHash: hash, expiresAt: new Date(now() + RESET_TTL_MS).toISOString() });
      const mail = resetEmail(resetLink(deps.panelUrl!, secret));
      await deps.sendMail!(user.email, mail.subject, mail.text);
    });
    return res.status(202).json(REQUESTED);
  });

  router.post('/auth/password-reset/confirm', async (req: Request, res: Response) => {
    const { token, newPassword } = req.body ?? {};
    if (typeof token !== 'string' || !token) return res.status(400).json({ error: INVALID });

    // The password is checked before the link is spent: the rules are no secret,
    // and a typo should not cost somebody their link.
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });

    const userId = await repo.consumePasswordReset(hashResetToken(token), new Date(now()).toISOString());
    if (!userId) return res.status(400).json({ error: INVALID });

    const result = await users.resetPassword(userId, String(newPassword ?? ''));
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    await repo.deleteSessionsForUser(userId);
    return res.status(204).end();
  });

  return router;
}
