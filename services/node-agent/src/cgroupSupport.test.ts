import { describe, it, expect } from 'vitest';
import { detectCgroupSupport, withCgroupSupport, IO_WEIGHT_PATH } from './cgroupSupport.js';
import type { HostConfigLimits } from './limits.js';

const FULL: HostConfigLimits = {
  Memory: 512 * 1024 * 1024,
  MemorySwap: 512 * 1024 * 1024,
  NanoCpus: 1e9,
  BlkioWeight: 500,
  RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 5 },
};

describe('withCgroupSupport', () => {
  it('keeps BlkioWeight when the host supports io.weight', () => {
    expect(withCgroupSupport(FULL, { ioWeight: true })).toEqual(FULL);
  });

  it('drops BlkioWeight when the host does not support io.weight (#288)', () => {
    const out = withCgroupSupport(FULL, { ioWeight: false });
    expect(out.BlkioWeight).toBeUndefined();
  });

  it('leaves every other limit untouched when dropping BlkioWeight', () => {
    const out = withCgroupSupport(FULL, { ioWeight: false });
    expect(out.Memory).toBe(FULL.Memory);
    expect(out.MemorySwap).toBe(FULL.MemorySwap);
    expect(out.NanoCpus).toBe(FULL.NanoCpus);
    expect(out.RestartPolicy).toEqual(FULL.RestartPolicy);
  });

  it('does not mutate its input', () => {
    const input = { ...FULL };
    withCgroupSupport(input, { ioWeight: false });
    expect(input.BlkioWeight).toBe(500);
  });

  it('is a no-op for limits that never set BlkioWeight', () => {
    expect(withCgroupSupport({ NanoCpus: 1e9 }, { ioWeight: false })).toEqual({ NanoCpus: 1e9 });
  });
});

describe('detectCgroupSupport', () => {
  it('reports support when io.weight is present', async () => {
    const seen: string[] = [];
    const caps = await detectCgroupSupport(async (p) => {
      seen.push(p);
      return true;
    });
    expect(caps.ioWeight).toBe(true);
    expect(seen).toEqual([IO_WEIGHT_PATH]);
  });

  it('reports no support when io.weight is absent', async () => {
    const caps = await detectCgroupSupport(async () => false);
    expect(caps.ioWeight).toBe(false);
  });

  // The controller list is not the signal — `io` is listed on hosts that still
  // have no io.weight file, which is exactly how #288 slipped through.
  it('treats a probe failure as no support rather than throwing', async () => {
    const caps = await detectCgroupSupport(async () => {
      throw new Error('permission denied');
    });
    expect(caps.ioWeight).toBe(false);
  });
});
