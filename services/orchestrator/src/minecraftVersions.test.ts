import { describe, it, expect, beforeEach } from 'vitest';
import {
  CACHE_TTL_MS,
  FALLBACK_VERSIONS,
  clearVersionCache,
  getMinecraftVersions,
  LATEST,
  offeredVersions,
  parseVersionManifest,
  releaseVersions,
  SNAPSHOT,
  VERSION_MANIFEST_URL,
} from './minecraftVersions.js';

// The versions the panel offers (#311). The list is a suggestion, never a gate —
// it can be stale, cold, or served from the offline fallback — so these tests are
// mostly about it degrading rather than failing.

const MANIFEST = {
  latest: { release: '26.2', snapshot: '26.3-snapshot-10' },
  versions: [
    { id: '26.3-snapshot-10', type: 'snapshot', url: 'x' },
    { id: '26.2', type: 'release', url: 'x' },
    { id: '26.1.2', type: 'release', url: 'x' },
    { id: '25w35a', type: 'snapshot', url: 'x' },
    { id: '1.21.11', type: 'release', url: 'x' },
    { id: 'b1.7.3', type: 'old_beta', url: 'x' },
  ],
};

const respond = (body: unknown, ok = true, status = 200) =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

describe('parseVersionManifest', () => {
  it('reads the ids and types it needs', () => {
    const parsed = parseVersionManifest(MANIFEST);
    expect(parsed.latestRelease).toBe('26.2');
    expect(parsed.versions).toHaveLength(6);
  });

  it('drops an entry it cannot read rather than the whole list', () => {
    // Third-party JSON rendered into a form: one malformed row should cost one
    // version, not the field.
    const parsed = parseVersionManifest({
      latest: { release: 42 },
      versions: [{ id: '26.2', type: 'release' }, { id: 7, type: 'release' }, null, { type: 'release' }],
    });
    expect(parsed.versions).toEqual([{ id: '26.2', type: 'release' }]);
    expect(parsed.latestRelease).toBeNull();
  });

  it('survives nonsense without throwing', () => {
    for (const input of [null, undefined, 'not json', 42, {}, { versions: 'no' }]) {
      expect(parseVersionManifest(input).versions).toEqual([]);
    }
  });
});

describe('releaseVersions', () => {
  it('keeps releases only', () => {
    // Mojang's manifest is mostly snapshots — thousands of them — and a list
    // where every third entry is 25w35a is one nobody finds 1.21.4 in.
    expect(releaseVersions(parseVersionManifest(MANIFEST))).toEqual(['26.2', '26.1.2', '1.21.11']);
  });

  it("keeps Mojang's order rather than sorting", () => {
    // Minecraft versions do not sort as text: "1.9" would come after "1.10".
    const manifest = parseVersionManifest({
      versions: [
        { id: '1.10', type: 'release' },
        { id: '1.9', type: 'release' },
      ],
    });
    expect(releaseVersions(manifest)).toEqual(['1.10', '1.9']);
  });
});

describe('offeredVersions', () => {
  it('puts the two words the image understands first', () => {
    expect(offeredVersions(['26.2'])).toEqual([LATEST, SNAPSHOT, '26.2']);
  });
});

describe('getMinecraftVersions', () => {
  beforeEach(() => clearVersionCache());

  it('offers what Mojang lists', async () => {
    const versions = await getMinecraftVersions({ fetchImpl: respond(MANIFEST) });
    expect(versions).toEqual([LATEST, SNAPSHOT, '26.2', '26.1.2', '1.21.11']);
  });

  it('asks Mojang once and then answers from cache', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => MANIFEST };
    }) as unknown as typeof fetch;

    await getMinecraftVersions({ fetchImpl: counting });
    await getMinecraftVersions({ fetchImpl: counting });
    expect(calls).toBe(1);
  });

  it('asks again once the cache has aged out', async () => {
    let calls = 0;
    const counting = (async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => MANIFEST };
    }) as unknown as typeof fetch;

    let clock = 1_000_000;
    await getMinecraftVersions({ fetchImpl: counting, now: () => clock });
    clock += CACHE_TTL_MS + 1;
    await getMinecraftVersions({ fetchImpl: counting, now: () => clock });
    expect(calls).toBe(2);
  });

  it('falls back to the baked list with no internet', async () => {
    // A community install is somebody's own machine and may have no route out.
    // An empty dropdown there would be worse than a slightly old one.
    const offline = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof fetch;

    const versions = await getMinecraftVersions({ fetchImpl: offline });
    expect(versions).toEqual(offeredVersions(FALLBACK_VERSIONS));
    expect(versions).toContain(LATEST);
  });

  it('falls back when Mojang answers something unusable', async () => {
    for (const bad of [respond({}, false, 503), respond({ versions: [] }), respond('not json')]) {
      clearVersionCache();
      expect(await getMinecraftVersions({ fetchImpl: bad })).toEqual(offeredVersions(FALLBACK_VERSIONS));
    }
  });

  it('does not retry a doomed request on every call', async () => {
    let calls = 0;
    const offline = (async () => {
      calls += 1;
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await getMinecraftVersions({ fetchImpl: offline });
    await getMinecraftVersions({ fetchImpl: offline });
    expect(calls).toBe(1);
  });

  it('asks the public manifest and nothing else', async () => {
    const urls: string[] = [];
    const recording = (async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => MANIFEST };
    }) as unknown as typeof fetch;

    await getMinecraftVersions({ fetchImpl: recording });
    expect(urls).toEqual([VERSION_MANIFEST_URL]);
  });
});
