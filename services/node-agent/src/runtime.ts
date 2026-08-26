import os from 'os';
import Docker from 'dockerode';
import { Writable } from 'stream';
import type { NodeResources, ResourceLimits } from 'shared';
import { lineSplitter } from './logs.js';
import { parseDockerStats, type ContainerStats } from './stats.js';
import { resourceLimitsToHostConfig } from './limits.js';
import { buildTarball, normalizeContainerPath, parseLsOutput, type FileEntry } from './files.js';
import type { TerminalSession } from './terminal.js';

// NodeResources is the shared event-payload type (shared/src/events.ts) — the
// host snapshot reported to the Control Room via the node heartbeat.
export type { NodeResources };

export interface StartSpec {
  dockerImage: string;
  containerName?: string;
  env?: Record<string, string>;
  // hostPort -> containerPort (both as strings, e.g. { "8080": "80" })
  ports?: Record<string, string>;
  // Resource caps / runtime behaviour enforced on the container (#107).
  resourceLimits?: ResourceLimits;
}

/**
 * The container runtime the Node Agent drives. The agent depends only on this
 * interface so its command-handling logic is unit-testable with a fake, while
 * production uses DockerodeRuntime against the real Docker daemon.
 */
export interface ContainerRuntime {
  start(spec: StartSpec): Promise<string>; // resolves to the container id
  stop(containerId: string): Promise<void>;
  /** Force-terminate (SIGKILL) a container that will not stop gracefully (#253). */
  kill(containerId: string): Promise<void>;
  restart(containerId: string): Promise<void>;
  collectResources(): Promise<NodeResources>;
  /** Follow a container's logs, invoking `onLine` per line. Returns an unsubscribe. */
  logs(containerId: string, onLine: (line: string) => void): () => void;
  /** Follow a container's resource stats, invoking `onStats` per sample. Returns an unsubscribe. */
  stats(containerId: string, onStats: (stats: ContainerStats) => void): () => void;

  // ── File management (#108) — CRUD over a container's filesystem ──────────────
  /** List a directory's immediate entries (dirs first, then files). */
  listFiles(containerId: string, path: string): Promise<FileEntry[]>;
  /** Read a text file's contents. */
  readFile(containerId: string, path: string): Promise<string>;
  /** Create or overwrite a text file. */
  writeFile(containerId: string, path: string, content: string): Promise<void>;
  /** Create or overwrite a file from raw bytes — the binary-safe upload path (#263). */
  writeFileBytes(containerId: string, path: string, data: Buffer): Promise<void>;
  /** Create a directory (and any missing parents). */
  makeDir(containerId: string, path: string): Promise<void>;
  /** Move/rename a file or directory. */
  renamePath(containerId: string, from: string, to: string): Promise<void>;
  /** Delete a file or directory (recursively). */
  deletePath(containerId: string, path: string): Promise<void>;

  // ── Backups (#110) — tar snapshot/restore of a container path ────────────────
  /** Snapshot a container path to a tar buffer. */
  snapshotPath(containerId: string, path: string): Promise<Buffer>;
  /** Restore a tar buffer into a container path. */
  restoreArchive(containerId: string, path: string, tar: Buffer): Promise<void>;

  // ── Console (#68) — run a one-shot command in the container ───────────────────
  /** Run a command (argv) in the container, returning its output + exit code. */
  execCommand(containerId: string, cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;

  // ── Interactive terminal (#71) — a TTY shell in the container ─────────────────
  /** Open an interactive shell (TTY) in the container; returns a bidirectional session. */
  execInteractive(containerId: string, opts: { cols?: number; rows?: number }): TerminalSession;
}

/**
 * Real Docker runtime via dockerode. On Windows this talks to Docker Desktop's
 * named pipe; on Linux/macOS the default unix socket — dockerode auto-detects.
 */
export class DockerodeRuntime implements ContainerRuntime {
  private docker: Docker;

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  async start(spec: StartSpec): Promise<string> {
    await this.ensureImage(spec.dockerImage);

    // Remove any leftover container with the same name so start is idempotent and
    // resilient to earlier containers that outlived their deployment.
    if (spec.containerName) await this.removeByName(spec.containerName);

    const env = spec.env ? Object.entries(spec.env).map(([k, v]) => `${k}=${v}`) : undefined;

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, object> = {};
    if (spec.ports) {
      for (const [hostPort, containerPort] of Object.entries(spec.ports)) {
        const key = `${containerPort}/tcp`;
        exposedPorts[key] = {};
        portBindings[key] = [{ HostPort: hostPort }];
      }
    }

    // Enforce the server's resource caps / restart policy at start (#107),
    // converting the host-relative percentages against this node's capacity.
    const limits = resourceLimitsToHostConfig(spec.resourceLimits, {
      totalMemBytes: os.totalmem(),
      cpuCount: os.cpus().length,
    });

    const container = await this.docker.createContainer({
      Image: spec.dockerImage,
      name: spec.containerName,
      Env: env,
      ExposedPorts: exposedPorts,
      HostConfig: { PortBindings: portBindings, ...limits },
    });

    await container.start();
    return container.id;
  }

  async stop(containerId: string): Promise<void> {
    // Stop and remove the container so its name and host ports are freed — this
    // lets the same deployment be started again without a name/port conflict.
    const container = this.docker.getContainer(containerId);
    try {
      await container.stop();
    } catch {
      // Already stopped — fall through to removal.
    }
    await container.remove({ force: true });
  }

  async kill(containerId: string): Promise<void> {
    // SIGKILL, then remove — same cleanup as stop() so the name and host ports
    // are freed and the deployment can be started again.
    const container = this.docker.getContainer(containerId);
    try {
      await container.kill();
    } catch {
      // Already dead — fall through to removal.
    }
    await container.remove({ force: true });
  }

  async restart(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).restart();
  }

  logs(containerId: string, onLine: (line: string) => void): () => void {
    const container = this.docker.getContainer(containerId);
    let stopped = false;
    let stream: NodeJS.ReadableStream | null = null;
    const out = lineSplitter(onLine);
    const err = lineSplitter(onLine);
    container
      .logs({ follow: true, stdout: true, stderr: true, tail: 200 })
      .then((s) => {
        if (stopped) {
          (s as unknown as { destroy?: () => void }).destroy?.();
          return;
        }
        stream = s as unknown as NodeJS.ReadableStream;
        // Non-TTY containers multiplex stdout/stderr; demux into the splitters.
        this.docker.modem.demuxStream(stream, out, err);
        stream.on('error', () => {});
      })
      .catch(() => {});
    return () => {
      stopped = true;
      (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    };
  }

  stats(containerId: string, onStats: (stats: ContainerStats) => void): () => void {
    const container = this.docker.getContainer(containerId);
    let stopped = false;
    let stream: NodeJS.ReadableStream | null = null;
    // Docker's stats stream is newline-delimited JSON, one sample ~every second.
    const splitter = lineSplitter((line) => {
      try {
        onStats(parseDockerStats(JSON.parse(line)));
      } catch {
        // Ignore a partial or non-JSON line — the next complete sample follows.
      }
    });
    container
      .stats({ stream: true })
      .then((s) => {
        if (stopped) {
          (s as unknown as { destroy?: () => void }).destroy?.();
          return;
        }
        stream = s as unknown as NodeJS.ReadableStream;
        stream.pipe(splitter);
        stream.on('error', () => {});
      })
      .catch(() => {});
    return () => {
      stopped = true;
      (stream as unknown as { destroy?: () => void } | null)?.destroy?.();
    };
  }

  // ── File management (#108) ───────────────────────────────────────────────────
  // All paths are normalised to a traversal-safe absolute form first, then handed
  // to commands as argv arrays (no shell), so a container path can't inject.

  async listFiles(containerId: string, path: string): Promise<FileEntry[]> {
    const dir = normalizeContainerPath(path);
    const { stdout, stderr, exitCode } = await this.exec(containerId, ['ls', '-lAp', dir]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `cannot list ${dir}`);
    return parseLsOutput(stdout);
  }

  async readFile(containerId: string, path: string): Promise<string> {
    const file = normalizeContainerPath(path);
    const { stdout, stderr, exitCode } = await this.exec(containerId, ['cat', file]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `cannot read ${file}`);
    return stdout;
  }

  async writeFile(containerId: string, path: string, content: string): Promise<void> {
    return this.putFile(containerId, path, content);
  }

  async writeFileBytes(containerId: string, path: string, data: Buffer): Promise<void> {
    return this.putFile(containerId, path, data);
  }

  private async putFile(containerId: string, path: string, content: string | Buffer): Promise<void> {
    const file = normalizeContainerPath(path);
    const slash = file.lastIndexOf('/');
    const dir = slash > 0 ? file.slice(0, slash) : '/';
    const base = file.slice(slash + 1);
    if (!base) throw new Error('a file name is required');
    await this.docker.getContainer(containerId).putArchive(buildTarball(base, content), { path: dir });
  }

  async makeDir(containerId: string, path: string): Promise<void> {
    const dir = normalizeContainerPath(path);
    const { stderr, exitCode } = await this.exec(containerId, ['mkdir', '-p', dir]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `cannot create ${dir}`);
  }

  async renamePath(containerId: string, from: string, to: string): Promise<void> {
    const src = normalizeContainerPath(from);
    const dst = normalizeContainerPath(to);
    const { stderr, exitCode } = await this.exec(containerId, ['mv', src, dst]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `cannot move ${src}`);
  }

  async deletePath(containerId: string, path: string): Promise<void> {
    const target = normalizeContainerPath(path);
    if (target === '/') throw new Error('refusing to delete the container root');
    const { stderr, exitCode } = await this.exec(containerId, ['rm', '-rf', target]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `cannot delete ${target}`);
  }

  async snapshotPath(containerId: string, path: string): Promise<Buffer> {
    const stream = await this.docker.getContainer(containerId).getArchive({ path: normalizeContainerPath(path) });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    return Buffer.concat(chunks);
  }

  async restoreArchive(containerId: string, path: string, tar: Buffer): Promise<void> {
    await this.docker.getContainer(containerId).putArchive(tar, { path: normalizeContainerPath(path) });
  }

  // Run a command in the container, collecting demuxed stdout/stderr and the exit
  // code. Cmd is an argv array — never a shell string — so paths can't inject.
  // Public wrapper for the console (#68): the user runs commands in their own
  // container, so a shell string (sh -c) is the intent — no injection concern here.
  execCommand(containerId: string, cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.exec(containerId, cmd);
  }

  // Interactive shell (#71). With Tty:true the hijacked duplex stream is the raw
  // terminal — no stdout/stderr demuxing. Docker exec is set up asynchronously; a
  // small outbound queue holds keystrokes typed before the stream is ready.
  execInteractive(containerId: string, opts: { cols?: number; rows?: number }): TerminalSession {
    const dataCbs: ((data: string) => void)[] = [];
    const exitCbs: (() => void)[] = [];
    let stream: NodeJS.ReadWriteStream | null = null;
    let execRef: Docker.Exec | null = null;
    const pending: string[] = [];
    let closed = false;

    const exit = () => { if (!exitCbs.length) return; exitCbs.forEach((cb) => cb()); };

    void (async () => {
      try {
        const exec = await this.docker.getContainer(containerId).exec({
          Cmd: ['sh'],
          Tty: true,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
        });
        execRef = exec;
        const s = (await exec.start({ hijack: true, stdin: true, Tty: true } as Docker.ExecStartOptions)) as unknown as NodeJS.ReadWriteStream;
        stream = s;
        if (opts.cols && opts.rows) void exec.resize({ w: opts.cols, h: opts.rows }).catch(() => {});
        for (const chunk of pending) s.write(chunk);
        pending.length = 0;
        s.on('data', (chunk: Buffer) => dataCbs.forEach((cb) => cb(chunk.toString('utf8'))));
        s.on('end', exit);
        s.on('error', exit);
      } catch {
        exit();
      }
    })();

    return {
      write(data: string) {
        if (stream) stream.write(data);
        else pending.push(data);
      },
      resize(cols: number, rows: number) {
        void execRef?.resize({ w: cols, h: rows }).catch(() => {});
      },
      onData(cb) { dataCbs.push(cb); },
      onExit(cb) { exitCbs.push(cb); },
      close() {
        if (closed) return;
        closed = true;
        try { stream?.end(); } catch { /* already closed */ }
      },
    };
  }

  private async exec(containerId: string, cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const exec = await this.docker.getContainer(containerId).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({});
    let stdout = '';
    let stderr = '';
    const out = new Writable({ write: (c, _e, cb) => { stdout += c.toString('utf8'); cb(); } });
    const err = new Writable({ write: (c, _e, cb) => { stderr += c.toString('utf8'); cb(); } });
    this.docker.modem.demuxStream(stream as unknown as NodeJS.ReadableStream, out, err);
    await new Promise<void>((resolve) => (stream as unknown as NodeJS.ReadableStream).on('end', resolve));
    const info = await exec.inspect();
    return { stdout, stderr, exitCode: info.ExitCode ?? 0 };
  }

  async collectResources(): Promise<NodeResources> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      cpuPercent: cpuPercent(),
      // The real core count, so the panel stops inferring one from RAM (#261).
      cpuCores: os.cpus().length,
      ramUsedMb: Math.round((totalMem - freeMem) / 1024 / 1024),
      ramTotalMb: Math.round(totalMem / 1024 / 1024),
      // Disk metrics need a platform-specific probe; deferred to a later phase.
      diskUsedGb: 0,
      diskTotalGb: 0,
    };
  }

  // Remove any container whose name exactly matches (Docker prefixes names with
  // "/"). Used before create so a leftover doesn't cause a 409 name conflict.
  private async removeByName(name: string): Promise<void> {
    const existing = await this.docker.listContainers({ all: true, filters: { name: [name] } });
    for (const c of existing) {
      if (c.Names?.some((n) => n === `/${name}`)) {
        await this.docker.getContainer(c.Id).remove({ force: true });
      }
    }
  }

  // Pull the image if it isn't present locally, so start() doesn't fail on a
  // fresh host. No-op when the image already exists.
  private async ensureImage(image: string): Promise<void> {
    const images = await this.docker.listImages({ filters: { reference: [image] } });
    if (images.length > 0) return;

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err as Error);
        this.docker.modem.followProgress(stream, (doneErr: unknown) =>
          doneErr ? reject(doneErr as Error) : resolve()
        );
      });
    });
  }
}

// Instantaneous CPU utilisation across all cores from os.cpus() time counters.
function cpuPercent(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  if (total === 0) return 0;
  return Math.round((1 - idle / total) * 1000) / 10;
}
