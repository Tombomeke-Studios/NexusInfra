// Edition flag — the open-core split (see docs/billing.md). NexusInfra ships as
// one codebase with two editions:
//
//   community (default) — the standalone self-hosted manager; no billing/FinVault.
//   hosted              — the multi-tenant hosting-provider scenario; billing on.
//
// **Which one a process runs as is decided by the image it was built from** (#189).
// The release build stamps the edition into a file inside the image, and that file
// wins over the environment: pulling the `-hosted` image is enough, with nothing
// to declare afterwards. An environment variable cannot quietly turn a community
// build into a hosted one, because the hosted code is not in that image to run.
//
// Outside a released image — running from source, in development, in tests —
// there is no stamp, and NEXUS_EDITION decides as it always has.
//
// Anything unrecognised (or unset) falls back to community, so the standalone
// manager stays the safe default.

import { readFileSync } from 'fs';

export type Edition = 'community' | 'hosted';

export const EDITIONS: readonly Edition[] = ['community', 'hosted'];

export const DEFAULT_EDITION: Edition = 'community';

/**
 * Where the release build records the edition it produced.
 *
 * A file rather than an environment variable precisely because the environment
 * is the thing it needs to outrank.
 */
export const BUILD_EDITION_FILE = '/etc/nexusinfra/edition';

/** Normalise an arbitrary value (env var, query, JSON, file) into a valid Edition. */
export function resolveEdition(value?: string | null): Edition {
  const normalised = value?.trim().toLowerCase();
  return normalised === 'hosted' ? 'hosted' : DEFAULT_EDITION;
}

/** True for a value that names an edition at all, as opposed to being absent or noise. */
function namesAnEdition(value?: string | null): boolean {
  const normalised = value?.trim().toLowerCase();
  return normalised === 'hosted' || normalised === 'community';
}

/**
 * The edition stamped into this image at build time, or null when running
 * outside a released image (from source, in tests).
 */
export function getBuildEdition(path: string = BUILD_EDITION_FILE): Edition | null {
  try {
    const stamped = readFileSync(path, 'utf8');
    return namesAnEdition(stamped) ? resolveEdition(stamped) : null;
  } catch {
    return null; // not a released image
  }
}

export interface EditionResolution {
  edition: Edition;
  /** Where the answer came from — reported on /health, and useful in support. */
  source: 'image' | 'environment' | 'default';
  /** Set when the environment asks for something the image cannot provide. */
  conflict?: { requested: Edition; built: Edition };
}

/**
 * Work out the edition and say why.
 *
 * The image wins. When the environment disagrees with it that is a real
 * misconfiguration, not a preference, so it is reported rather than smoothed
 * over — see `assertEditionIsRunnable`.
 */
export function resolveRuntimeEdition(
  env: NodeJS.ProcessEnv = process.env,
  buildEdition: Edition | null = getBuildEdition()
): EditionResolution {
  const requested = env.NEXUS_EDITION;

  if (buildEdition) {
    if (namesAnEdition(requested) && resolveEdition(requested) !== buildEdition) {
      return { edition: buildEdition, source: 'image', conflict: { requested: resolveEdition(requested), built: buildEdition } };
    }
    return { edition: buildEdition, source: 'image' };
  }

  if (namesAnEdition(requested)) return { edition: resolveEdition(requested), source: 'environment' };
  return { edition: DEFAULT_EDITION, source: 'default' };
}

/** The edition this service process runs as. */
export function getEdition(): Edition {
  return resolveRuntimeEdition().edition;
}

/**
 * Refuse to run an image as an edition it was not built for.
 *
 * The community images do not contain the hosted code, so "starting anyway"
 * would mean a half-enabled billing system with no interface — strictly worse
 * than a container that stops and says why. Called once at startup by every
 * service; throws rather than exiting so the caller controls the exit path.
 */
export function assertEditionIsRunnable(resolution: EditionResolution = resolveRuntimeEdition()): void {
  if (!resolution.conflict) return;
  const { requested, built } = resolution.conflict;
  throw new Error(
    `This image was built for the ${built} edition, but NEXUS_EDITION asks for ${requested}. ` +
      `The ${built} image does not contain the ${requested} code, so it cannot run as ${requested}. ` +
      `Use the :${requested} image instead, or remove NEXUS_EDITION and let the image decide.`
  );
}

/** True when billing/FinVault features should be active. */
export function isHosted(edition: Edition = getEdition()): boolean {
  return edition === 'hosted';
}
