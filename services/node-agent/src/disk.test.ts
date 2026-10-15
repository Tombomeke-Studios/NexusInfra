import { describe, it, expect } from 'vitest';
import { diskUsageFrom, collectDisk, resolveDiskPath, configuredDiskPath } from './disk.js';

// The agent reported diskUsedGb: 0, diskTotalGb: 0 and the panel rendered that as
// 0% beside real CPU and RAM meters, so a full disk looked like an empty one
// (#276). Zero is not "unknown".

describe('diskUsageFrom', () => {
  // 4 KB blocks: 26214400 blocks = 100 GB total, 13107200 available = 50 GB.
  const stat = { bsize: 4096, blocks: 26214400, bavail: 13107200 };

  it('converts blocks to GB', () => {
    expect(diskUsageFrom(stat)).toEqual({ diskTotalGb: 100, diskUsedGb: 50 });
  });

  it('counts the root reserve as used, not as free', () => {
    // Filesystems hold back a slice for root. Counting it as usable overstates
    // what a server can actually write.
    const reserved = { bsize: 4096, blocks: 26214400, bavail: 0 };
    expect(diskUsageFrom(reserved)).toEqual({ diskTotalGb: 100, diskUsedGb: 100 });
  });

  it('returns nothing for a nonsensical result rather than zero', () => {
    expect(diskUsageFrom({ bsize: 0, blocks: 100, bavail: 10 })).toBeNull();
    expect(diskUsageFrom({ bsize: 4096, blocks: 0, bavail: 0 })).toBeNull();
  });

  it('never reports negative use when available exceeds total', () => {
    const odd = { bsize: 4096, blocks: 100, bavail: 1000 };
    expect(diskUsageFrom(odd)!.diskUsedGb).toBe(0);
  });
});

describe('collectDisk', () => {
  it('measures the requested path', async () => {
    const seen: string[] = [];
    const result = await collectDisk(async (p) => {
      seen.push(p);
      return { bsize: 4096, blocks: 26214400, bavail: 13107200 };
    }, '/var/lib/docker');

    expect(seen).toEqual(['/var/lib/docker']);
    expect(result).toEqual({ diskTotalGb: 100, diskUsedGb: 50 });
  });

  it('reports nothing when the probe fails', async () => {
    // Unsupported platform, missing path, no permission — all the same answer,
    // and none of them is "the disk is empty".
    const result = await collectDisk(async () => {
      throw new Error('ENOTSUP');
    });
    expect(result).toBeNull();
  });
});

// Nobody should have to configure which disk to measure. The agent works it out,
// and DISK_PATH is an override for the setups where the guess is wrong.
describe('resolveDiskPath', () => {
  const ok = async () => ({ bsize: 4096, blocks: 100, bavail: 50 });
  const missing = async () => {
    throw new Error('ENOENT');
  };

  it('honours an explicit DISK_PATH above everything else', async () => {
    const choice = await resolveDiskPath({ dockerRootDir: '/var/lib/docker', statfs: ok, env: { DISK_PATH: '/mnt/big' } });
    expect(choice).toEqual({ path: '/mnt/big', reason: 'configured' });
  });

  it("prefers Docker's data root when it is readable from here", async () => {
    // True when the agent runs natively, or when someone mounted it in.
    const choice = await resolveDiskPath({ dockerRootDir: '/var/lib/docker', statfs: ok, env: {} });
    expect(choice).toEqual({ path: '/var/lib/docker', reason: 'docker-root' });
  });

  it('falls back to the container root when the data root is not mounted in', async () => {
    // The default: the agent mounts only the Docker socket. Under overlay2 the
    // container root reports the filesystem holding the upper layer, which lives
    // inside the Docker data root — so this measures the disk that fills up.
    const choice = await resolveDiskPath({ dockerRootDir: '/var/lib/docker', statfs: missing, env: {} });
    expect(choice).toEqual({ path: '/', reason: 'container-root' });
  });

  it('falls back when Docker cannot be asked at all', async () => {
    const choice = await resolveDiskPath({ statfs: ok, env: {} });
    expect(choice).toEqual({ path: '/', reason: 'container-root' });
  });

  it('treats a blank DISK_PATH as unset rather than as the empty path', async () => {
    const choice = await resolveDiskPath({ statfs: missing, env: { DISK_PATH: '   ' } });
    expect(choice.path).toBe('/');
  });
});

describe('configuredDiskPath', () => {
  it('is undefined unless deliberately set', () => {
    expect(configuredDiskPath({})).toBeUndefined();
    expect(configuredDiskPath({ DISK_PATH: '  ' })).toBeUndefined();
    expect(configuredDiskPath({ DISK_PATH: '/mnt/big' })).toBe('/mnt/big');
  });
});
