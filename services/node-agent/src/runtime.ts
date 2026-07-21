import os from 'os';
import Docker from 'dockerode';
import type { NodeResources } from 'shared';

// NodeResources is the shared event-payload type (shared/src/events.ts) — the
// host snapshot reported to the Control Room via the node heartbeat.
export type { NodeResources };

export interface StartSpec {
  dockerImage: string;
  containerName?: string;
  env?: Record<string, string>;
  // hostPort -> containerPort (both as strings, e.g. { "8080": "80" })
  ports?: Record<string, string>;
}

/**
 * The container runtime the Node Agent drives. The agent depends only on this
 * interface so its command-handling logic is unit-testable with a fake, while
 * production uses DockerodeRuntime against the real Docker daemon.
 */
export interface ContainerRuntime {
  start(spec: StartSpec): Promise<string>; // resolves to the container id
  stop(containerId: string): Promise<void>;
  restart(containerId: string): Promise<void>;
  collectResources(): Promise<NodeResources>;
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

    const container = await this.docker.createContainer({
      Image: spec.dockerImage,
      name: spec.containerName,
      Env: env,
      ExposedPorts: exposedPorts,
      HostConfig: { PortBindings: portBindings },
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

  async restart(containerId: string): Promise<void> {
    await this.docker.getContainer(containerId).restart();
  }

  async collectResources(): Promise<NodeResources> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      cpuPercent: cpuPercent(),
      ramUsedMb: Math.round((totalMem - freeMem) / 1024 / 1024),
      ramTotalMb: Math.round(totalMem / 1024 / 1024),
      // Disk metrics need a platform-specific probe; deferred to a later phase.
      diskUsedGb: 0,
      diskTotalGb: 0,
    };
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
