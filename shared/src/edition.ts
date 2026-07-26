// Edition flag — the open-core split (see docs/billing.md). NexusInfra ships as
// one codebase with two editions:
//
//   community (default) — the standalone self-hosted manager; no billing/FinVault.
//   hosted              — the multi-tenant hosting-provider scenario; billing on.
//
// Services resolve their edition from NEXUS_EDITION; the dashboard reads it from
// the Orchestrator's public GET /config. Anything unrecognised (or unset) falls
// back to community so the standalone manager stays the safe default.

export type Edition = 'community' | 'hosted';

export const EDITIONS: readonly Edition[] = ['community', 'hosted'];

export const DEFAULT_EDITION: Edition = 'community';

/** Normalise an arbitrary value (env var, query, JSON) into a valid Edition. */
export function resolveEdition(value?: string | null): Edition {
  const normalised = value?.trim().toLowerCase();
  return normalised === 'hosted' ? 'hosted' : DEFAULT_EDITION;
}

/** The edition this service process runs as, read from NEXUS_EDITION. */
export function getEdition(): Edition {
  return resolveEdition(process.env.NEXUS_EDITION);
}

/** True when billing/FinVault features should be active. */
export function isHosted(edition: Edition = getEdition()): boolean {
  return edition === 'hosted';
}
