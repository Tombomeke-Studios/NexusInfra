import { Router, type Request, type Response } from 'express';
import { getEdition, type Edition } from 'shared';

// Public runtime config the dashboard reads before/without auth. Right now it
// exposes only the edition (community|hosted) so the panel knows whether to
// render billing UI; keep this endpoint free of anything sensitive.

export const FEATURES = ['agent-link'] as const;

/**
 * Where a hosted customer pays a top-up (#435, #436): a link to FinVault, and the
 * payee an EPC QR names — FinVault's merchant account, the one
 * NEXUSINFRA_MERCHANT_EMAIL points at there. Both public on purpose: the QR prints
 * them for anyone who scans it. Copy the name and IBAN from that FinVault account.
 */
export interface FinvaultDetails {
  url: string | null;
  payee: { name: string; iban: string } | null;
}

/** FINVAULT_URL / FINVAULT_MERCHANT_NAME / FINVAULT_MERCHANT_IBAN, or null when none is usable. */
export function finvaultFromEnv(env: Record<string, string | undefined> = process.env): FinvaultDetails | null {
  const rawUrl = (env.FINVAULT_URL ?? '').trim().replace(/\/+$/, '');
  const url = /^https?:\/\/[^\s]+$/i.test(rawUrl) ? rawUrl : null;
  const name = (env.FINVAULT_MERCHANT_NAME ?? '').trim().slice(0, 70);
  const iban = (env.FINVAULT_MERCHANT_IBAN ?? '').replace(/\s+/g, '').toUpperCase();
  const payee = name && /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban) ? { name, iban } : null;
  return url || payee ? { url, payee } : null;
}

export function createConfigRouter(
  edition: Edition = getEdition(),
  options: { passwordResetByEmail?: boolean; sftpPort?: number | null; emailVerification?: boolean; finvault?: FinvaultDetails | null; billingTestTools?: boolean } = {},
): Router {
  const router = Router();
  router.get('/config', (_req: Request, res: Response) => {
    // Whether "Forgot your password?" leads anywhere (#344) — a yes/no, never
    // the mail setup behind it.
    // The SFTP port (#235), or null when SFTP is off — so the Files tab can say
    // how to connect, or say nothing.
    // Whether this installation confirms email addresses (#367) — when it does,
    // a hosted account has to confirm its own before topping up.
    res.json({
      edition,
      passwordResetByEmail: options.passwordResetByEmail === true,
      sftpPort: options.sftpPort ?? null,
      emailVerification: options.emailVerification === true,
      // What this control plane supports beyond the basics, so a client can ask
      // instead of guessing from a version. `agent-link` (#416): nodes behind NAT
      // may connect outbound.
      features: FEATURES,
      // Hosted only, and only when configured: a community panel has no billing.
      ...(edition === 'hosted' && options.finvault ? { finvault: options.finvault } : {}),
      // TEMPORARY (#439): whether the Customers page shows its test tools.
      ...(edition === 'hosted' && options.billingTestTools ? { billingTestTools: true } : {}),
    });
  });
  return router;
}
