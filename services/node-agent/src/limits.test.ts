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

// Allocating in real units (#275): a percentage means nothing without knowing the
// node, and stops meaning the same thing the moment a server is moved.
describe('absolute limits', () => {
  const host = { totalMemBytes: 8 * 1024 * 1024 * 1024, cpuCount: 8 };

  it('uses an absolute memory value as given', () => {
    expect(resourceLimitsToHostConfig({ ramMb: 2048 }, host).Memory).toBe(2048 * 1024 * 1024);
  });

  it('uses an absolute core count as given', () => {
    expect(resourceLimitsToHostConfig({ cpuCores: 2 }, host).NanoCpus).toBe(2e9);
    expect(resourceLimitsToHostConfig({ cpuCores: 1.5 }, host).NanoCpus).toBe(1.5e9);
  });

  it('prefers the absolute value when both are given', () => {
    // The more specific instruction wins rather than the two fighting.
    const out = resourceLimitsToHostConfig({ ramMb: 1024, ramPercent: 50, cpuCores: 1, cpuPercent: 100 }, host);
    expect(out.Memory).toBe(1024 * 1024 * 1024);
    expect(out.NanoCpus).toBe(1e9);
  });

  it('still resolves a percentage when no absolute value is set', () => {
    const out = resourceLimitsToHostConfig({ ramPercent: 25, cpuPercent: 50 }, host);
    expect(out.Memory).toBe(2 * 1024 * 1024 * 1024);
    expect(out.NanoCpus).toBe(4e9);
  });

  it('applies swap and the OOM policy to an absolute memory cap too', () => {
    const out = resourceLimitsToHostConfig({ ramMb: 1024, swapPercent: 50, oomKill: false }, host);
    expect(out.MemorySwap).toBe(1024 * 1024 * 1024 * 1.5);
    expect(out.OomKillDisable).toBe(true);
  });

  it('sets no cap at all when neither form is given', () => {
    const out = resourceLimitsToHostConfig({ ioPriority: 'high' }, host);
    expect(out.Memory).toBeUndefined();
    expect(out.NanoCpus).toBeUndefined();
  });
});
