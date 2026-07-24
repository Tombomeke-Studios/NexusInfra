// Per-container resource stats. The Node Agent derives these from Docker's raw
// stats stream and emits one `ContainerStats` per sample over SSE (see
// index.ts) — the dashboard renders them live (#67/#72).

export interface ContainerStats {
  cpuPercent: number; // 0–100 across all the container's online CPUs
  memUsedMb: number; // resident memory (usage minus page cache)
  memLimitMb: number; // the container's memory limit (host total if unbounded)
  memPercent: number; // memUsed / memLimit, 0–100
  rxKb: number; // cumulative bytes received across all interfaces, in KB
  txKb: number; // cumulative bytes transmitted across all interfaces, in KB
}

// The subset of Docker's stats JSON we read. Every field is optional because a
// container that just started (or is on cgroup v1 vs v2) may omit some.
interface CpuStats {
  cpu_usage?: { total_usage?: number };
  system_cpu_usage?: number;
  online_cpus?: number;
}
export interface DockerStatsSample {
  cpu_stats?: CpuStats;
  precpu_stats?: CpuStats;
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Derive `ContainerStats` from a single Docker stats sample. CPU% is the usual
 * delta-over-delta formula (container CPU time / system CPU time × online CPUs);
 * memory subtracts page cache so it reflects the working set. Missing or
 * out-of-order counters yield 0 rather than NaN/negatives.
 */
export function parseDockerStats(s: DockerStatsSample): ContainerStats {
  const cpu = s.cpu_stats;
  const pre = s.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage ?? 0) - (pre?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (cpu?.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const cpus = cpu?.online_cpus || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? round1((cpuDelta / sysDelta) * cpus * 100) : 0;

  const cache = s.memory_stats?.stats?.cache ?? 0;
  const memUsed = Math.max(0, (s.memory_stats?.usage ?? 0) - cache);
  const memLimit = s.memory_stats?.limit ?? 0;
  const memPercent = memLimit > 0 ? round1((memUsed / memLimit) * 100) : 0;

  let rx = 0;
  let tx = 0;
  for (const n of Object.values(s.networks ?? {})) {
    rx += n.rx_bytes ?? 0;
    tx += n.tx_bytes ?? 0;
  }

  return {
    cpuPercent,
    memUsedMb: round1(memUsed / 1024 / 1024),
    memLimitMb: round1(memLimit / 1024 / 1024),
    memPercent,
    rxKb: round1(rx / 1024),
    txKb: round1(tx / 1024),
  };
}
