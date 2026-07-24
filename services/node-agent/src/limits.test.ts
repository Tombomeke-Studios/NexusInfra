import { describe, it, expect } from 'vitest';
import { resourceLimitsToHostConfig } from './limits.js';

// A host with 8 GiB RAM and 4 cores keeps the arithmetic easy to read.
const HOST = { totalMemBytes: 8 * 1024 * 1024 * 1024, cpuCount: 4 };

describe('resourceLimitsToHostConfig', () => {
  it('converts CPU/RAM percentages into Docker NanoCpus and Memory', () => {
    const hc = resourceLimitsToHostConfig({ cpuPercent: 50, ramPercent: 25 }, HOST);
    expect(hc.NanoCpus).toBe(2_000_000_000); // 50% of 4 cores = 2 cores
    expect(hc.Memory).toBe(2 * 1024 * 1024 * 1024); // 25% of 8 GiB = 2 GiB
    expect(hc.MemorySwap).toBe(hc.Memory); // no swap requested
  });

  it('adds swap as a share of the RAM limit on top of MemorySwap', () => {
    const hc = resourceLimitsToHostConfig({ ramPercent: 25, swapPercent: 50 }, HOST);
    const mem = 2 * 1024 * 1024 * 1024;
    expect(hc.Memory).toBe(mem);
    expect(hc.MemorySwap).toBe(mem + mem / 2); // +50% of the RAM limit
  });

  it('maps I/O priority and restart policy', () => {
    const hc = resourceLimitsToHostConfig({ ioPriority: 'high', restartPolicy: 'on-failure' }, HOST);
    expect(hc.BlkioWeight).toBe(750);
    expect(hc.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 5 });
  });

  it('disables the OOM killer only when opted out and a memory limit is set', () => {
    expect(resourceLimitsToHostConfig({ ramPercent: 25, oomKill: false }, HOST).OomKillDisable).toBe(true);
    // No memory limit → OomKillDisable must not be set (Docker would reject it).
    expect(resourceLimitsToHostConfig({ oomKill: false }, HOST).OomKillDisable).toBeUndefined();
    // Opted in (default) → leave the killer enabled.
    expect(resourceLimitsToHostConfig({ ramPercent: 25, oomKill: true }, HOST).OomKillDisable).toBeUndefined();
  });

  it('returns an empty config for undefined or empty limits', () => {
    expect(resourceLimitsToHostConfig(undefined, HOST)).toEqual({});
    expect(resourceLimitsToHostConfig({}, HOST)).toEqual({});
  });
});
