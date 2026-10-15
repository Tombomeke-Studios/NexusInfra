import { describe, it, expect } from 'vitest';
import express, { Router, type Request, type Response } from 'express';
import request from 'supertest';
import { catchAsync, errorHandler } from './errorBoundary.js';

/** An app shaped like the Orchestrator's: routers mounted, error handler last. */
function appWith(router: Router) {
  const app = express();
  app.use(express.json());
  app.use(catchAsync(router));
  app.use(errorHandler);
  return app;
}

describe('catchAsync', () => {
  it('answers 500 instead of killing the process when an async handler rejects (#294)', async () => {
    const router = Router();
    router.delete('/boom', async () => {
      throw new Error('foreign key constraint violated');
    });

    const res = await request(appWith(router)).delete('/boom');
    expect(res.status).toBe(500);
  });

  it('keeps serving after a handler has rejected — one bad route is not the process', async () => {
    const router = Router();
    router.delete('/boom', async () => {
      throw new Error('boom');
    });
    router.get('/fine', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const app = appWith(router);
    await request(app).delete('/boom').expect(500);
    const after = await request(app).get('/fine');
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ ok: true });
  });

  it('does not leak the internal message to the caller', async () => {
    const router = Router();
    router.get('/boom', async () => {
      throw new Error('file:/data/orchestrator.db is locked');
    });

    const res = await request(appWith(router)).get('/boom');
    expect(JSON.stringify(res.body)).not.toContain('orchestrator.db');
  });

  it('leaves a synchronous throw to the same handler', async () => {
    const router = Router();
    router.get('/boom', () => {
      throw new Error('sync');
    });

    await request(appWith(router)).get('/boom').expect(500);
  });

  it('passes successful responses through untouched', async () => {
    const router = Router();
    router.post('/echo', async (req: Request, res: Response) => {
      res.status(201).json(req.body);
    });

    const res = await request(appWith(router)).post('/echo').send({ a: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ a: 1 });
  });

  it('preserves a handler that answers a 4xx itself', async () => {
    const router = Router();
    router.get('/missing', async (_req: Request, res: Response) => {
      res.status(404).json({ error: 'deployment not found' });
    });

    const res = await request(appWith(router)).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'deployment not found' });
  });

  it('wraps every handler in a chain, not only the first', async () => {
    const router = Router();
    const guard = (_req: Request, _res: Response, next: (e?: unknown) => void) => next();
    router.get('/guarded', guard, async () => {
      throw new Error('boom');
    });

    await request(appWith(router)).get('/guarded').expect(500);
  });
});
