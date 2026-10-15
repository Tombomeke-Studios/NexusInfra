import type { Request, Response, NextFunction } from 'express';
import { getInternalToken, INTERNAL_TOKEN_HEADER, tokensMatch } from 'shared';

// Guards the Billing Bridge's API (#372). Its routes name the account in the
// path and believe it: the Orchestrator is supposed to be the only caller, and
// puts the signed-in user's id there. Nothing enforced "only caller", so anyone
// who could reach the port could read any wallet or start a top-up for anyone.
//
// Same shared token as the Node Agent's internal API (#169). Mount after
// /health and /metrics so probes and scrapes stay open.

export function requireInternalToken(expected: string = getInternalToken()) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.headers[INTERNAL_TOKEN_HEADER];
    if (tokensMatch(typeof provided === 'string' ? provided : undefined, expected)) {
      next();
      return;
    }
    res.status(401).json({ error: 'invalid or missing internal token' });
  };
}
