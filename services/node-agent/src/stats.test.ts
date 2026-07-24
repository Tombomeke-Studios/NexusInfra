import { describe, it, expect } from 'vitest';
import { parseDockerStats } from './stats.js';

describe('parseDockerStats', () => {
  it('derives CPU% from the delta-over-delta formula across online CPUs', () => {
    const s = parseDockerStats({
      cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    });
    // (100/1000) * 4 * 100 = 40
    expect(s.cpuPercent).toBe(40);
  });

  it('subtracts page cache from memory usage and computes the percentage', () => {
    const s = parseDockerStats({
      memory_stats: { usage: 300 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { cache: 100 * 1024 * 1024 } },
    });
    expect(s.memUsedMb).toBe(200);
    expect(s.memLimitMb).toBe(1024);
    // 200 / 1024 ≈ 19.5%
    expect(s.memPercent).toBe(19.5);
  });

  it('sums received/transmitted bytes across all interfaces', () => {
    const s = parseDockerStats({
      networks: {
        eth0: { rx_bytes: 2048, tx_bytes: 1024 },
        eth1: { rx_bytes: 1024, tx_bytes: 0 },
      },
    });
    expect(s.rxKb).toBe(3);
    expect(s.txKb).toBe(1);
  });

  it('returns zeros rather than NaN when counters are missing or out of order', () => {
    const s = parseDockerStats({
      cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
      precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000 },
    });
    expect(s.cpuPercent).toBe(0);
    expect(s.memPercent).toBe(0);
    expect(s.memUsedMb).toBe(0);
    expect(s.rxKb).toBe(0);
  });
});
