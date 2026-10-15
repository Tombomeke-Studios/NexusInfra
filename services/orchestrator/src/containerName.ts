// Deriving the Docker container name for a deployment (#286).
//
// The display name is whatever the person typed — "test minecraft server",
// "wereld café". Docker's name grammar is far narrower, and it rejects the
// create outright rather than sanitising for us, so passing the display name
// through unchanged turns a space into a crashed deployment with no container.
//
// Two properties matter beyond validity, and they pull against each other:
//
//   deterministic — `DockerodeRuntime.start` removes any container holding the
//     name before creating one, and a reconciled restart re-derives the name
//     from the stored config. Both only work if the same deployment always
//     maps to the same name.
//   unique per deployment — which is why the deployment id is in the name and
//     the display name alone is not. Two servers both called "survival" would
//     otherwise resolve to one name, and starting the second would force-remove
//     the first one's container.
//
// Pure: no Docker, no repository.

/** Docker's own grammar for a container name. */
export const DOCKER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

/** Kept well inside Docker's limit so `docker ps` output stays readable. */
const MAX_SLUG = 40;

const PREFIX = 'nexus';

/**
 * Reduce a display name to lowercase alphanumeric words joined by dashes.
 *
 * Everything outside `[a-z0-9]` becomes a separator — including the `_` and `.`
 * Docker would accept — because one separator is easier to predict than three.
 * Returns `''` when nothing usable survives (an all-emoji name, say).
 */
export function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

/**
 * The container name for a deployment: `nexus-<slug>-<short id>`.
 *
 * Always valid per `DOCKER_NAME_PATTERN` — the constant prefix guarantees the
 * required leading alphanumeric even when the display name contributes nothing.
 */
export function containerNameFor(displayName: string, deploymentId: string): string {
  const slug = slugify(displayName) || 'server';
  const shortId = deploymentId.replace(/-/g, '').slice(0, 8) || 'unknown';
  return `${PREFIX}-${slug}-${shortId}`;
}
