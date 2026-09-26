import { Router, type Request, type Response } from 'express';
import { getEdition, type Edition } from 'shared';

// Public runtime config the dashboard reads before/without auth. Right now it
// exposes only the edition (community|hosted) so the panel knows whether to
// render billing UI; keep this endpoint free of anything sensitive.

export function createConfigRouter(edition: Edition = getEdition(), options: { passwordResetByEmail?: boolean; sftpPort?: number | null } = {}): Router {
  const router = Router();
  router.get('/config', (_req: Request, res: Response) => {
    // Whether "Forgot your password?" leads anywhere (#344) — a yes/no, never
    // the mail setup behind it.
    // The SFTP port (#235), or null when SFTP is off — so the Files tab can say
    // how to connect, or say nothing.
    res.json({ edition, passwordResetByEmail: options.passwordResetByEmail === true, sftpPort: options.sftpPort ?? null });
  });
  return router;
}
