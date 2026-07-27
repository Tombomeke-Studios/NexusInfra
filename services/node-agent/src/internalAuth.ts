import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { getInternalToken, INTERNAL_TOKEN_HEADER, tokensMatch } from 'shared';

// Guards the Node Agent's internal surface (#169). These endpoints drive Docker
// directly — exec, file writes, an interactive shell — so they must only be
// callable by the Orchestrator over the private network. Without this, anyone who
// can reach the agent's port has unauthenticated command execution in every
// container, bypassing the Orchestrator's JWT entirely.
//
// Mount AFTER /health so probes stay open.

/** Express middleware requiring the shared internal token. */
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

/**
 * Same check for a WebSocket upgrade, which can't run Express middleware.
 * Browsers can't set headers on a WS handshake, but this hop is Orchestrator →
 * Agent (a server-side client), so the header is available here.
 */
export function upgradeAuthorized(req: IncomingMessage, expected: string = getInternalToken()): boolean {
  const provided = req.headers[INTERNAL_TOKEN_HEADER];
  return tokensMatch(typeof provided === 'string' ? provided : undefined, expected);
}
