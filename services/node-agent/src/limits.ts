import type { ResourceLimits } from 'shared';

// Translate a server's ResourceLimits (#106, percentages of the host node) into
// the Docker HostConfig fields that actually enforce them at container start
// (#107). Kept pure and host-injected so the mapping is unit-testable without a
// Docker daemon; DockerodeRuntime.start feeds it the live host capacity.

export interface HostCapacity {
  totalMemBytes: number;
  cpuCount: number;
}

/** The subset of Docker's HostConfig we set. Shapes match dockerode's fields. */
export interface HostConfigLimits {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  BlkioWeight?: number;
  OomKillDisable?: boolean;
  RestartPolicy?: { Name: string; MaximumRetryCount: number };
}

// Docker BlkioWeight is 10–1000; map the three UI priorities onto sensible points.
const IO_WEIGHT = { low: 250, normal: 500, high: 750 } as const;
// Bounded retries for 'on-failure' so a crash-looping container eventually stops.
const ON_FAILURE_RETRIES = 5;

export function resourceLimitsToHostConfig(limits: ResourceLimits | undefined, host: HostCapacity): HostConfigLimits {
  const out: HostConfigLimits = {};
  if (!limits) return out;

  // An absolute value is used as given; a percentage is resolved against this
  // host (#275). Absolute wins, because it is the more specific instruction and
  // it keeps meaning the same if the server is ever moved to a different node.
  const mem =
    limits.ramMb && limits.ramMb > 0
      ? Math.round(limits.ramMb * 1024 * 1024)
      : limits.ramPercent && limits.ramPercent > 0 && host.totalMemBytes > 0
        ? Math.round((limits.ramPercent / 100) * host.totalMemBytes)
        : 0;

  if (mem > 0) {
    out.Memory = mem;
    // Swap is a share of the RAM limit; MemorySwap is the combined total, so
    // swapPercent 0 pins MemorySwap to Memory (no swap for the container).
    const swap = limits.swapPercent && limits.swapPercent > 0 ? Math.round((limits.swapPercent / 100) * mem) : 0;
    out.MemorySwap = mem + swap;
    // Disabling the OOM killer is only valid alongside a memory limit.
    if (limits.oomKill === false) out.OomKillDisable = true;
  }

  // 1e9 NanoCpus == 1 core.
  if (limits.cpuCores && limits.cpuCores > 0) {
    out.NanoCpus = Math.round(limits.cpuCores * 1e9);
  } else if (limits.cpuPercent && limits.cpuPercent > 0 && host.cpuCount > 0) {
    out.NanoCpus = Math.round((limits.cpuPercent / 100) * host.cpuCount * 1e9);
  }

  if (limits.ioPriority) out.BlkioWeight = IO_WEIGHT[limits.ioPriority];

  if (limits.restartPolicy) {
    out.RestartPolicy = {
      Name: limits.restartPolicy,
      MaximumRetryCount: limits.restartPolicy === 'on-failure' ? ON_FAILURE_RETRIES : 0,
    };
  }

  return out;
}
