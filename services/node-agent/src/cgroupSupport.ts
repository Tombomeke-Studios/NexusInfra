import type { HostConfigLimits } from './limits.js';

// What this host's cgroup hierarchy actually supports (#288).
//
// `resourceLimitsToHostConfig` translates a server's limits into HostConfig
// fields; this decides which of them the kernel underneath will accept. The two
// are separate because the translation is a property of the *server* and the
// support is a property of the *node* — the same server may be startable on one
// node and not another.
//
// The case that forced this: on cgroup v2 hosts without an `io.weight` file
// (Docker Desktop's WSL2 kernel, among others) runc fails container init when
// BlkioWeight is set. The New Deployment form sends `ioPriority: normal` by
// default, so the default submission produced a server that could not start at
// all. A relative IO weight is a preference; losing it is a far better outcome
// than losing the server.
//
// Note that `io` being listed in `cgroup.controllers` proves nothing — it is
// listed on exactly the hosts that fail. The file's existence is the signal.

/** The cgroup v2 knob Docker's BlkioWeight is written to. */
export const IO_WEIGHT_PATH = '/sys/fs/cgroup/io.weight';

export interface CgroupSupport {
  /** Whether BlkioWeight can be set without failing container init. */
  ioWeight: boolean;
}

/** Probes whether a path exists. Injected so tests need no real cgroupfs. */
export type PathProbe = (path: string) => Promise<boolean>;

/**
 * Ask this host what it supports.
 *
 * A probe that throws (an unreadable `/sys`, a stripped container) is treated as
 * "not supported": the cost of wrongly skipping the setting is a lost IO
 * preference, and the cost of wrongly keeping it is a server that never starts.
 */
export async function detectCgroupSupport(exists: PathProbe): Promise<CgroupSupport> {
  try {
    return { ioWeight: await exists(IO_WEIGHT_PATH) };
  } catch {
    return { ioWeight: false };
  }
}

/** Drop the HostConfig fields this host cannot honour. Returns a new object. */
export function withCgroupSupport(limits: HostConfigLimits, support: CgroupSupport): HostConfigLimits {
  if (support.ioWeight) return limits;
  const rest = { ...limits };
  delete rest.BlkioWeight;
  return rest;
}
