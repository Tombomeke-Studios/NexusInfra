// Host ports per node (#233) — which ones a server may take, and which are
// already someone else's. Pure: the repository holds the allocations (with a
// unique constraint as the last word), this decides what to ask it for.
//
// Before this, two servers on one node could be given the same host port and
// the second simply failed to start — "crashed", with the reason buried in a
// Docker error about a bind.

export interface PortRange {
  start: number;
  end: number;
}

/** Host port → the server holding it on one node. */
export type TakenPorts = Map<number, { deploymentId: string; name: string }>;

/** A host port written as `auto` is taken from the node's pool. */
export const AUTO_PORT = 'auto';

export class PortConflictError extends Error {
  constructor(
    public readonly port: number,
    public readonly nodeId: string,
  ) {
    super(`port ${port} is already allocated on node ${nodeId}`);
    this.name = 'PortConflictError';
  }
}

function asPort(key: string): number | null {
  if (!/^\d+$/.test(key)) return null;
  const n = Number(key);
  return n >= 1 && n <= 65535 ? n : null;
}

/** 400 for a request that could never work, 409 for one that collides with what is there. */
export type PortPlan = { ok: true; ports: Record<string, string>; hostPorts: number[] } | { ok: false; status: 400 | 409; error: string };

/**
 * Resolve a server's port map on one node: `auto` becomes a free port from the
 * pool, explicit ports are checked against the pool and against every other
 * server there. The server's own current ports never count against it.
 */
export function planPorts(input: { ports: Record<string, string>; range: PortRange | null; taken: TakenPorts; self?: string }): PortPlan {
  const { range, taken, self } = input;
  const isFree = (port: number, chosen: Set<number>) => {
    const holder = taken.get(port);
    return !chosen.has(port) && (!holder || holder.deploymentId === self);
  };

  const chosen = new Set<number>();
  const resolved: Record<string, string> = {};

  // Explicit ports first, so an `auto` never takes a number the same request names.
  const entries = Object.entries(input.ports ?? {});
  for (const [key, containerPort] of entries) {
    if (key.toLowerCase() === AUTO_PORT) continue;
    const port = asPort(key);
    if (port === null) return { ok: false, status: 400, error: `${key} is not a port — use a number from 1 to 65535, or "auto"` };
    if (range && (port < range.start || port > range.end)) {
      return { ok: false, status: 400, error: `port ${port} is outside this node's port range ${range.start}–${range.end}` };
    }
    const holder = taken.get(port);
    if (holder && holder.deploymentId !== self) return { ok: false, status: 409, error: `port ${port} is already used by ${holder.name} on this node` };
    chosen.add(port);
    resolved[String(port)] = containerPort;
  }

  for (const [key, containerPort] of entries) {
    if (key.toLowerCase() !== AUTO_PORT) continue;
    if (!range) return { ok: false, status: 400, error: 'this node has no port range to choose from — name a port, or give the node a range' };
    let found: number | null = null;
    for (let p = range.start; p <= range.end; p++) {
      if (isFree(p, chosen)) {
        found = p;
        break;
      }
    }
    if (found === null) return { ok: false, status: 409, error: `no free port left in this node's range ${range.start}–${range.end}` };
    chosen.add(found);
    resolved[String(found)] = containerPort;
  }

  return { ok: true, ports: resolved, hostPorts: [...chosen] };
}

export function parsePortRange(value: unknown): { ok: true; range: PortRange | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, range: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'the range must be { start, end }, or null to remove it' };
  const { start, end } = value as { start?: unknown; end?: unknown };
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 65535;
  if (!valid(start) || !valid(end)) return { ok: false, error: 'start and end must be whole numbers from 1 to 65535' };
  if (start > end) return { ok: false, error: 'the range starts after it ends' };
  return { ok: true, range: { start, end } };
}

/** A node's pool, or null when it has none. */
export function rangeOf(node: { portRangeStart: number | null; portRangeEnd: number | null }): PortRange | null {
  return node.portRangeStart != null && node.portRangeEnd != null ? { start: node.portRangeStart, end: node.portRangeEnd } : null;
}
