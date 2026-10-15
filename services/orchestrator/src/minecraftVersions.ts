// Which Minecraft versions the panel offers (#311).
//
// The version used to be typed by hand, with "e.g. 1.21.1" as the example. That
// example was already wrong: Minecraft moved to a new numbering scheme and the
// current release is 26.2. A hand-written list rots exactly that way, which is
// why this asks Mojang rather than carrying an answer.
//
// Three rules follow from where this list comes from:
//
//   1. **It is a suggestion, never a gate.** The list can be stale, or cold, or
//      unreachable. Refusing a version the image would happily install, because
//      our copy of the list has not caught up, would be worse than the free-text
//      field it replaced. Validation lives in eggs.ts and stays permissive.
//   2. **It must work offline.** A community install is somebody's own machine
//      and may have no route to the internet at all. The baked fallback below is
//      not a nicety; without it the field would be empty on exactly those hosts.
//   3. **It is cached.** The manifest is ~200 KB and changes a few times a year;
//      fetching it per page load would be rude to Mojang and slow for us.

/** Mojang's authoritative list. Public, unauthenticated, CDN-served. */
export const VERSION_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

/** How long a fetched list is trusted. Minecraft releases are not a fast-moving feed. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** What the image accepts in place of a number, and what they mean. */
export const LATEST = 'LATEST';
export const SNAPSHOT = 'SNAPSHOT';

/**
 * Offered when Mojang cannot be reached.
 *
 * Deliberately short and deliberately not "every version" — this is the list for
 * a machine that cannot check, so it should carry the versions someone is
 * plausibly running and get out of the way. `LATEST` still works on the image
 * regardless of what is listed here, because the *image* resolves it, not us.
 *
 * Correct as of 2026-08: 26.2 is the current release.
 */
export const FALLBACK_VERSIONS: readonly string[] = [
  '26.2',
  '26.1.2',
  '26.1.1',
  '26.1',
  '1.21.11',
  '1.21.10',
  '1.21.9',
  '1.21.8',
  '1.21.6',
  '1.21.4',
  '1.21.1',
  '1.20.6',
  '1.20.4',
  '1.20.2',
  '1.20.1',
  '1.19.4',
  '1.18.2',
  '1.16.5',
  '1.12.2',
  '1.8.9',
];

/** One entry of Mojang's manifest, narrowed to what we use. */
export interface ManifestVersion {
  id: string;
  type: string;
}

export interface VersionManifest {
  latestRelease: string | null;
  versions: ManifestVersion[];
}

/**
 * Read Mojang's manifest defensively.
 *
 * Anything that is not shaped as expected is dropped rather than trusted: this
 * is parsing a third party's JSON into a list the panel shows, and a malformed
 * entry should cost one version, not the whole field.
 */
export function parseVersionManifest(raw: unknown): VersionManifest {
  const doc = raw as { latest?: { release?: unknown }; versions?: unknown } | null;
  const entries = Array.isArray(doc?.versions) ? doc.versions : [];

  const versions: ManifestVersion[] = [];
  for (const entry of entries) {
    const row = entry as { id?: unknown; type?: unknown };
    if (typeof row?.id === 'string' && row.id && typeof row.type === 'string') {
      versions.push({ id: row.id, type: row.type });
    }
  }

  const latestRelease = typeof doc?.latest?.release === 'string' ? doc.latest.release : null;
  return { latestRelease, versions };
}

/**
 * The releases to offer, newest first.
 *
 * Releases only. Mojang's manifest is mostly snapshots — several thousand of
 * them — and a list where every third entry is `25w35a` is a list nobody can
 * find `1.21.4` in. `SNAPSHOT` is offered separately as a word, which is how the
 * image takes it anyway.
 *
 * The manifest is already newest-first; this keeps its order rather than sorting,
 * because Minecraft version strings do not sort correctly as text ("1.9" after
 * "1.10") and Mojang knows the real order.
 */
export function releaseVersions(manifest: VersionManifest): string[] {
  return manifest.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

/** The full set the panel offers: the two words, then every release. */
export function offeredVersions(releases: readonly string[]): string[] {
  return [LATEST, SNAPSHOT, ...releases];
}

interface Cache {
  versions: string[];
  fetchedAt: number;
}

let cache: Cache | null = null;

/** Drops the cache. For tests, and for a future "refresh now" if one is ever wanted. */
export function clearVersionCache(): void {
  cache = null;
}

export interface VersionSourceDeps {
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * The versions to offer, from cache, from Mojang, or from the baked list.
 *
 * Never throws and never returns nothing: an empty dropdown is a worse answer
 * than a slightly old one. A failed fetch is not even logged loudly — a panel
 * running without internet is a supported way to run this, not an error.
 */
export async function getMinecraftVersions(deps: VersionSourceDeps = {}): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetchImpl ?? fetch;

  if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) return cache.versions;

  try {
    const res = await doFetch(VERSION_MANIFEST_URL);
    if (!res.ok) throw new Error(`manifest responded ${res.status}`);

    const releases = releaseVersions(parseVersionManifest(await res.json()));
    if (releases.length === 0) throw new Error('manifest carried no releases');

    const versions = offeredVersions(releases);
    cache = { versions, fetchedAt: now() };
    return versions;
  } catch {
    // Cache the fallback too, briefly, so a host with no route out does not
    // attempt a doomed request on every page load.
    const versions = offeredVersions(FALLBACK_VERSIONS);
    cache = { versions, fetchedAt: now() };
    return versions;
  }
}
