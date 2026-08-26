// Node disk reporting (#276).
//
// The agent used to return `diskUsedGb: 0, diskTotalGb: 0` with a comment saying
// a real probe was deferred. Every disk meter in the panel therefore read 0%,
// rendered identically to the CPU and RAM meters beside it, which are real — so a
// node with a full disk looked exactly like an empty one.
//
// Zero is not "unknown". Reporting a measurement nobody took is the same fault as
// the fabricated telemetry in #250, and the honest options are a real figure or
// nothing at all. This measures the filesystem the Docker data lives on; when it
// cannot, it reports nothing and the panel says so.

/** The statfs fields we need, so the probe can be faked in tests. */
export interface StatFsResult {
  /** Filesystem block size, in bytes. */
  bsize: number;
  /** Total blocks. */
  blocks: number;
  /** Blocks free to unprivileged users. */
  bavail: number;
}

export interface DiskUsage {
  diskUsedGb: number;
  diskTotalGb: number;
}

const GB = 1024 * 1024 * 1024;

/**
 * Total and used space, in GB, from a statfs result.
 *
 * Used is total minus what is *available*, not minus what is free: filesystems
 * reserve a slice for root, and counting that as usable overstates what a server
 * can actually write by a few percent of the whole disk.
 */
export function diskUsageFrom(stat: StatFsResult): DiskUsage | null {
  if (!stat || stat.bsize <= 0 || stat.blocks <= 0) return null;

  const totalBytes = stat.bsize * stat.blocks;
  const availableBytes = stat.bsize * Math.max(0, stat.bavail);
  const usedBytes = Math.max(0, totalBytes - availableBytes);

  return {
    diskTotalGb: Math.round((totalBytes / GB) * 10) / 10,
    diskUsedGb: Math.round((usedBytes / GB) * 10) / 10,
  };
}

/** An explicit override, when the automatic choice is wrong for a setup. */
export function configuredDiskPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.DISK_PATH?.trim() || undefined;
}

export interface DiskPathChoice {
  path: string;
  /** Why this path, so the agent can say it once at startup instead of guessing silently. */
  reason: 'configured' | 'docker-root' | 'container-root';
}

export interface ResolveDiskPathDeps {
  /** Docker's own data root, from `docker info`. Undefined when it cannot be asked. */
  dockerRootDir?: string;
  /** Probe used to test whether a path is measurable from here. */
  statfs: (path: string) => Promise<StatFsResult>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide which filesystem to measure, without anybody having to configure it.
 *
 * Three steps, most specific first:
 *
 * 1. `DISK_PATH`, when someone has deliberately said which disk they mean.
 * 2. Docker's own data root, if it happens to be readable from here. That is the
 *    exact filesystem images and volumes grow on. It is usually *not* visible,
 *    because the agent container mounts only the Docker socket — hence step 3.
 * 3. The agent's own root. Under overlay2 this is not a dead end: statfs on an
 *    overlay mount reports the filesystem holding the upper layer, and the upper
 *    layer lives inside the Docker data root. So `/` measures the disk that
 *    actually fills up, which is why this needs no configuration in the normal
 *    case.
 */
export async function resolveDiskPath(deps: ResolveDiskPathDeps): Promise<DiskPathChoice> {
  const configured = configuredDiskPath(deps.env ?? process.env);
  if (configured) return { path: configured, reason: 'configured' };

  if (deps.dockerRootDir) {
    try {
      await deps.statfs(deps.dockerRootDir);
      return { path: deps.dockerRootDir, reason: 'docker-root' };
    } catch {
      // Not mounted into this container, which is the default. Fall through.
    }
  }

  return { path: '/', reason: 'container-root' };
}

/**
 * Measure the node's disk, or report nothing.
 *
 * `statfs` is injected: it lands on the host filesystem, and a unit test must not
 * depend on how full the machine running it happens to be.
 */
export async function collectDisk(
  statfs: (path: string) => Promise<StatFsResult>,
  path = '/'
): Promise<DiskUsage | null> {
  try {
    return diskUsageFrom(await statfs(path));
  } catch {
    // Unreadable, unsupported platform, or a path that is not there. Saying
    // nothing is the only honest answer; zero would read as an empty disk.
    return null;
  }
}
