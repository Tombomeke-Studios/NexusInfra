import { describe, it, expect } from 'vitest';
import { diskUsageFrom, collectDisk, diskPath } from './disk.js';

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

describe('diskPath', () => {
  it('defaults to the container root and is overridable', () => {
    expect(diskPath({})).toBe('/');
    expect(diskPath({ DISK_PATH: '  ' })).toBe('/');
    expect(diskPath({ DISK_PATH: '/var/lib/docker' })).toBe('/var/lib/docker');
  });
});
