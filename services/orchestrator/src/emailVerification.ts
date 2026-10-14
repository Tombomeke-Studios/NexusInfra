import { Router, type Request, type Response } from 'express';
import { principalOf } from './auth.js';
import { createLoginLimiter, type LoginLimiter } from './loginLimiter.js';
import { hashResetToken, mintResetToken } from './passwordReset.js';
import type { Repository, UserRecord } from './types.js';

// Confirming that an account's email address reaches its owner (#367).
//
// A hosted account is self-registered, and since #351 its address decides whose
// FinVault account receives a top-up's payment request. Unconfirmed, anybody
// could register with somebody else's address and send them requests. So in the
// hosted edition a top-up needs a confirmed address — wherever confirming is
// possible at all.
//
// Built like the password reset (#344), for the same reasons:
//
// - **Only with mail and a known public address.** The link is built from
//   `PANEL_URL`, never the request's Host header. Without both, confirming is
//   not offered and nothing is gated on it: a rule nobody can satisfy would only
//   lock every customer out of paying.
// - **The token is a secret**: 256 random bits, stored as a digest, single-use,
//   gone after VERIFY_TTL_MS. Asking again supersedes the previous link.
// - **Accounts an administrator makes are confirmed from the start** — the
//   administrator vouches for the address, and in the community edition there is
//   often no mail to confirm with.

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

export function verifyLink(panelUrl: string, secret: string): string {
  return `${panelUrl}/verify-email?token=${encodeURIComponent(secret)}`;
}

export function verifyEmail(link: string): { subject: string; text: string } {
  return {
    subject: 'Confirm your email address for NexusInfra',
    text: [
      'An account on NexusInfra was created with this email address.',
      '',
      'To confirm it is yours, open this link within 24 hours:',
      link,
      '',
      'Payment requests for topping up credit are sent to the FinVault account with this address, which is why it has to be confirmed first.',
      'If you did not create this account, ignore this mail — nothing can be charged without it.',
    ].join('\n'),
  };
}

export interface EmailVerificationDeps {
  repo: Repository;
  /** Null when confirming is not possible here (no mail, or no public address). */
  panelUrl: string | null;
  sendMail: ((to: string, subject: string, text: string) => Promise<void>) | null;
  limiter?: LoginLimiter;
  now?: () => number;
  /** Runs the mail after the response; tests await it, production does not. */
  defer?: (task: () => Promise<void>) => void;
}

/** Whether this installation can confirm addresses — shown by `GET /config`. */
export function verificationAvailable(deps: Pick<EmailVerificationDeps, 'panelUrl' | 'sendMail'>): boolean {
  return Boolean(deps.panelUrl && deps.sendMail);
}

/**
 * Why this account may not top up, or null (pure). Unconfirmed only matters
 * where confirming is possible.
 */
export function topUpProblem(user: Pick<UserRecord, 'emailVerifiedAt'> | null, available: boolean): string | null {
  if (!user) return 'this account has no email address for FinVault to ask for payment';
  if (available && !user.emailVerifiedAt) {
    return 'confirm your email address first — the payment request goes to the FinVault account with that address. Open the link we mailed you, or ask for a new one on the Billing page';
  }
  return null;
}

const INVALID = 'this confirmation link is invalid, has expired, or has already been used';

export function createEmailVerification(deps: EmailVerificationDeps) {
  const { repo } = deps;
  const now = deps.now ?? Date.now;
  // Its own budget: asking for a mail is neither a failed password nor a reset.
  const limiter = deps.limiter ?? createLoginLimiter({ maxAttempts: 5, windowMs: 60 * 60 * 1000, lockoutMs: 60 * 60 * 1000 });
  const defer =
    deps.defer ??
    ((task: () => Promise<void>) => {
      setImmediate(() => void task().catch((err) => console.error('[Orchestrator] confirmation mail failed:', err instanceof Error ? err.message : err)));
    });

  /** Mail a fresh confirmation link. Does nothing when confirming is off or already done. */
  async function send(user: UserRecord): Promise<boolean> {
    if (!verificationAvailable(deps) || user.emailVerifiedAt) return false;
    const { secret, hash } = mintResetToken();
    await repo.createEmailVerification({ userId: user.id, tokenHash: hash, expiresAt: new Date(now() + VERIFY_TTL_MS).toISOString() });
    const mail = verifyEmail(verifyLink(deps.panelUrl!, secret));
    await deps.sendMail!(user.email, mail.subject, mail.text);
    return true;
  }

  /** Public: the link in the mail lands here, signed in or not. */
  function publicRouter(): Router {
    const router = Router();
    router.post('/auth/verify-email/confirm', async (req: Request, res: Response) => {
      const { token } = req.body ?? {};
      if (typeof token !== 'string' || !token) return res.status(400).json({ error: INVALID });
      const at = new Date(now()).toISOString();
      const userId = await repo.consumeEmailVerification(hashResetToken(token), at);
      if (!userId) return res.status(400).json({ error: INVALID });
      await repo.setUserEmailVerified(userId, at);
      return res.json({ status: 'verified' });
    });
    return router;
  }

  /** Authenticated: an account asking for its own link again. */
  function accountRouter(): Router {
    const router = Router();
    router.post('/me/verify-email', async (req: Request, res: Response) => {
      if (!verificationAvailable(deps)) {
        return res.status(404).json({ error: 'this installation does not confirm email addresses' });
      }
      const user = await repo.getUser(principalOf(req).id);
      if (!user) return res.status(404).json({ error: 'account not found' });
      if (user.emailVerifiedAt) return res.json({ status: 'verified' });

      const keys = [`verify:${user.id}`];
      const verdict = limiter.check(keys);
      if (!verdict.allowed) {
        res.setHeader('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)));
        return res.status(429).json({ error: 'too many confirmation mails requested; try again later' });
      }
      limiter.fail(keys);
      defer(async () => void (await send(user)));
      return res.status(202).json({ status: 'sent', email: user.email });
    });
    return router;
  }

  return {
    available: verificationAvailable(deps),
    /** After a self-registration: mail the link without holding up the response. */
    sendAfterSignup(user: UserRecord): void {
      if (verificationAvailable(deps)) defer(async () => void (await send(user)));
    },
    send,
    publicRouter,
    accountRouter,
  };
}

export type EmailVerification = ReturnType<typeof createEmailVerification>;
