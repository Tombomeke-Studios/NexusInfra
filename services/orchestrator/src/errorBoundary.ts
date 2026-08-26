import type { NextFunction, Request, Response, Router } from 'express';

// Keeping one failing request from taking the control plane with it (#294).
//
// Express 4 does not await route handlers. An `async` handler that rejects
// produces an unhandled rejection, and Node 18 ends the process on those — so a
// single failing DELETE took the whole Orchestrator down: no panel, no API, no
// lifecycle consumption, for every server on the platform, until someone started
// it by hand. The caller should have got a 500 and nobody else should have
// noticed.
//
// Wrapping happens after the routes are declared rather than at each call site,
// because ~60 handlers each needing to remember a wrapper is a rule that will be
// forgotten exactly once, in whichever route turns out to matter. The tests
// assert the behaviour, so if Express's internals move underneath this it fails
// loudly instead of quietly reverting to crashing.

/** An Express layer, as far as we need to know it. */
interface Layer {
  route?: { stack: { handle: (...args: unknown[]) => unknown }[] };
}

/**
 * Route a rejected promise to Express's error pipeline.
 *
 * Handlers that already answer, throw synchronously, or take `(err, …)` are left
 * exactly as they are.
 */
export function catchAsync(router: Router): Router {
  for (const layer of (router as unknown as { stack: Layer[] }).stack) {
    if (!layer.route) continue;
    for (const entry of layer.route.stack) {
      const original = entry.handle;
      // A 4-argument function is an error handler; wrapping it would change its
      // signature and Express would stop recognising it as one.
      if (original.length >= 4) continue;
      entry.handle = function wrapped(this: unknown, ...args: unknown[]) {
        const next = args[2] as NextFunction | undefined;
        try {
          const result = original.apply(this, args);
          if (result && typeof (result as Promise<unknown>).catch === 'function') {
            (result as Promise<unknown>).catch((err) => next?.(err));
          }
          return result;
        } catch (err) {
          next?.(err);
          return undefined;
        }
      };
    }
  }
  return router;
}

/**
 * Final middleware: answer 500 and log the cause.
 *
 * The message is logged, never returned — a database path or a constraint name
 * is a description of the inside of the system, and the caller asked for a
 * server, not a tour.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error('[Orchestrator] unhandled error in a route:', err instanceof Error ? err.stack ?? err.message : err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal server error' });
}

/**
 * Last resort for rejections that never reach a route (consumers, timers).
 *
 * Installing a handler is what stops Node from exiting on them. Staying up with
 * a loud log beats dying quietly: a degraded control plane can still be asked
 * what went wrong.
 */
export function installProcessGuards(log: Pick<Console, 'error'> = console): void {
  process.on('unhandledRejection', (reason) => {
    log.error('[Orchestrator] unhandled promise rejection (staying up):', reason);
  });
  process.on('uncaughtException', (err) => {
    log.error('[Orchestrator] uncaught exception (staying up):', err);
  });
}
