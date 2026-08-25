// Build identity — what version of NexusInfra a running process is, and which
// edition it resolved (#173). Both are surfaced on every service's /health so an
// operator can tell at a glance what a container actually is; that matters most
// for the hosted edition, where a mis-set NEXUS_EDITION silently disables billing.
//
// The version is baked into the image at build time (ARG APP_VERSION -> ENV) by
// the release workflow. Outside a released image it falls back to the version npm
// exports when running through a script, and finally to a dev placeholder — so
// this never throws and never has to read package.json from disk.

import { getEdition, type Edition } from './edition.js';

export const DEV_VERSION = '0.0.0-dev';

/** The version this process reports: APP_VERSION, else npm's, else a dev placeholder. */
export function getVersion(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.APP_VERSION?.trim();
  if (explicit) return explicit;
  const fromNpm = env.npm_package_version?.trim();
  if (fromNpm) return fromNpm;
  return DEV_VERSION;
}

export interface BuildInfo {
  version: string;
  edition: Edition;
}

/** Version + edition, spread into a service's /health response. */
export function buildInfo(): BuildInfo {
  return { version: getVersion(), edition: getEdition() };
}
