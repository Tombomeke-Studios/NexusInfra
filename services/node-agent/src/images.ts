import { Router, type Request, type Response } from 'express';
import type { ContainerRuntime } from './runtime.js';

// Is there a newer image for a server's tag (#239)?
//
// Three things can disagree: what the registry says the tag is now, what this
// node last pulled for it, and what the server's container was actually created
// from. Each disagreement means something different, and "unknown" is kept
// apart from "current" — a registry that could not be asked has not said there
// is nothing new.

export type ImageUpdateStatus = 'current' | 'update-available' | 'pulled-not-applied' | 'unknown';

export interface ImageFacts {
  image: string;
  /** The tag's digest at the registry now; null when the registry could not be asked. */
  remoteDigest: string | null;
  /** `repo@sha256:…` for every digest this node has pulled the tag as. */
  localRepoDigests: string[];
  /** The local image the tag points to; null when it has never been pulled here. */
  localImageId: string | null;
  /** What the server's container was created from; null when it is not running. */
  containerImageId: string | null;
}

export function digestOf(repoDigest: string): string | null {
  const at = repoDigest.lastIndexOf('@');
  return at >= 0 && repoDigest.slice(at + 1).startsWith('sha256:') ? repoDigest.slice(at + 1) : null;
}

export function imageUpdateStatus(facts: Omit<ImageFacts, 'image'>): ImageUpdateStatus {
  // A pulled image the container is not running is news whatever the registry says.
  if (facts.containerImageId && facts.localImageId && facts.containerImageId !== facts.localImageId) return 'pulled-not-applied';
  if (!facts.localImageId) return facts.remoteDigest ? 'update-available' : 'unknown';
  if (!facts.remoteDigest) return 'unknown';
  const local = facts.localRepoDigests.map(digestOf);
  return local.includes(facts.remoteDigest) ? 'current' : 'update-available';
}

/** Internal HTTP: `GET /images/status?image=&containerId=` — the orchestrator asks, the panel shows. */
export function createImageRouter(runtime: ContainerRuntime): Router {
  const router = Router();
  router.get('/images/status', async (req: Request, res: Response) => {
    const image = typeof req.query.image === 'string' ? req.query.image.trim() : '';
    if (!image) return res.status(400).json({ error: 'image is required' });
    const containerId = typeof req.query.containerId === 'string' && req.query.containerId ? req.query.containerId : undefined;
    try {
      const facts = await runtime.imageFacts(image, containerId);
      const localDigest = facts.localRepoDigests.map(digestOf).find(Boolean) ?? null;
      return res.json({ image, status: imageUpdateStatus(facts), remoteDigest: facts.remoteDigest, localDigest, checkedAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ error: err instanceof Error ? err.message : 'could not inspect the image' });
    }
  });
  return router;
}
