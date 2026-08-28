// Publishing a container's ports (#313).
//
// Every mapping used to be published as TCP, because the protocol was hardcoded:
//
//     const key = `${containerPort}/tcp`;
//
// Docker also *defaults* to TCP when no protocol is given, so this was not a
// cosmetic default — the UDP port was never published at all. Three of the four
// eggs in the catalogue are UDP games (Valheim, Rust, CS2), and neither Valheim
// nor Rust needs TCP for gameplay, so those servers were simply unreachable.
//
// The failure was the quiet kind: the container starts, the panel shows it
// running with real CPU and memory, and the only symptom is that nobody can join
// and it never appears in a server browser.
//
// Pure: a mapping in, Docker's `ExposedPorts`/`PortBindings` out.

/** What Docker will publish, in the shape its API expects. */
export interface PublishedPorts {
  exposedPorts: Record<string, object>;
  portBindings: Record<string, Array<{ HostPort: string }>>;
}

const PROTOCOLS = ['tcp', 'udp'] as const;
export type PortProtocol = (typeof PROTOCOLS)[number];

export const DEFAULT_PROTOCOL: PortProtocol = 'tcp';

export interface ParsedPort {
  port: string;
  protocols: PortProtocol[];
}

/**
 * Read the container side of a mapping: `"2456"`, `"2456/udp"`, `"7777/tcp+udp"`.
 *
 * Docker's own notation, so nothing about the stored shape changes — the value
 * was already a string, and one without a suffix still means TCP, exactly as
 * before. `tcp+udp` is the one addition: a game like CS2 or Satisfactory needs
 * the same number on both, and expressing that as two entries would collide on
 * the host-port key the mapping is stored under.
 */
export function parseContainerPort(value: string): ParsedPort | null {
  const [port, suffix] = String(value).trim().split('/', 2);
  if (!/^\d+$/.test(port)) return null;

  if (suffix === undefined || suffix === '') return { port, protocols: [DEFAULT_PROTOCOL] };

  const protocols = suffix
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter((p): p is PortProtocol => (PROTOCOLS as readonly string[]).includes(p));

  // An unreadable suffix falls back to TCP rather than dropping the mapping:
  // publishing the wrong protocol is recoverable, publishing nothing is a server
  // nobody can reach for a reason nothing reports.
  return { port, protocols: protocols.length > 0 ? [...new Set(protocols)] : [DEFAULT_PROTOCOL] };
}

/** The host side. Also accepts a protocol suffix, which is ignored — it is the
 *  container side that decides, and rejecting it would be pedantry. */
function hostPortOf(value: string): string | null {
  const port = String(value).trim().split('/', 1)[0];
  return /^\d+$/.test(port) ? port : null;
}

/**
 * Translate a host→container mapping into what `createContainer` wants.
 *
 * A mapping that cannot be read is skipped rather than guessed at: a port is
 * either a number or it is a mistake, and inventing one would publish something
 * nobody asked for.
 */
export function publishPorts(ports: Record<string, string> | undefined): PublishedPorts {
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  if (!ports) return { exposedPorts, portBindings };

  for (const [rawHost, rawContainer] of Object.entries(ports)) {
    const host = hostPortOf(rawHost);
    const parsed = parseContainerPort(rawContainer);
    if (!host || !parsed) continue;

    for (const protocol of parsed.protocols) {
      const key = `${parsed.port}/${protocol}`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostPort: host }];
    }
  }

  return { exposedPorts, portBindings };
}
