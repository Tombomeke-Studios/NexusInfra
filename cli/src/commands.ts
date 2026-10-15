import { parseArgs } from 'util';
import { ApiError, Client } from './client.js';
import { resolveConfig, type CliConfig } from './config.js';
import { ago, bytes, table } from './format.js';

// nexusctl (#240) — every command, dependency-injected so the whole CLI is
// testable with a fake fetch and no filesystem.

export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  configFile: string;
  readConfig(): Promise<Partial<CliConfig>>;
  writeConfig(config: CliConfig): Promise<void>;
  makeClient(url: string, token: string): Client;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** Stops `logs --follow`; Ctrl-C in the real binary. */
  signal?: AbortSignal;
}

export const USAGE = `nexusctl — the NexusInfra panel from a terminal

Usage:
  nexusctl login --url <panel URL> --token <API token>
  nexusctl whoami

  nexusctl servers list [--status running|stopped|crashed|pending] [--search <text>]
  nexusctl servers show <server>
  nexusctl servers create --name <name> (--image <image> | --egg <egg> [--var KEY=VALUE]...)
                          [--port HOST:CONTAINER]... [--env KEY=VALUE]... [--persist /path]... [--node <node>]
  nexusctl servers start|stop|restart|kill <server>...
  nexusctl servers delete <server> --yes
  nexusctl servers logs <server> [--follow]
  nexusctl servers update-image <server>

  nexusctl backups list <server>
  nexusctl backups create <server>
  nexusctl backups restore <server> <backup id> --yes
  nexusctl backups download <server> <backup id> [--output <file>]

  nexusctl nodes list

<server> is a server's id or its exact name. Add --json to any listing for machine-readable output.
Configuration: NEXUSCTL_URL and NEXUSCTL_TOKEN, or the file written by \`login\`.
Create a token in the panel under Account → API tokens; "write" scope is needed to change anything.
`;

class UsageError extends Error {}

const OPTIONS = {
  json: { type: 'boolean' },
  yes: { type: 'boolean' },
  follow: { type: 'boolean', short: 'f' },
  help: { type: 'boolean', short: 'h' },
  status: { type: 'string' },
  search: { type: 'string' },
  name: { type: 'string' },
  image: { type: 'string' },
  egg: { type: 'string' },
  node: { type: 'string' },
  output: { type: 'string', short: 'o' },
  url: { type: 'string' },
  token: { type: 'string' },
  port: { type: 'string', multiple: true },
  env: { type: 'string', multiple: true },
  var: { type: 'string', multiple: true },
  persist: { type: 'string', multiple: true },
} as const;

interface Server {
  id: string;
  name: string;
  status: string;
  dockerImage: string;
  nodeId: string | null;
  createdAt: string;
  role?: string;
  ports?: Record<string, string>;
  events?: Array<{ event: string; message: string; timestamp: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `KEY=VALUE` pairs into a record; a pair without `=` is a usage error, not an empty value. */
function pairs(list: string[] | undefined, sep: string, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const at = item.indexOf(sep);
    if (at <= 0) throw new UsageError(`${what} must look like ${sep === '=' ? 'KEY=VALUE' : 'HOST:CONTAINER'}, got "${item}"`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

/**
 * A server by id, or by exact name. A name that matches more than one server
 * is refused with the ids, rather than acting on whichever came first.
 */
async function resolveServer(client: Client, ref: string): Promise<Server> {
  if (UUID.test(ref)) return client.request<Server>('GET', `/deployments/${ref}`);
  const page = await client.request<{ items: Server[] }>('GET', `/deployments?q=${encodeURIComponent(ref)}&limit=200`);
  const exact = page.items.filter((s) => s.name === ref);
  const matches = exact.length ? exact : page.items.filter((s) => s.name.toLowerCase() === ref.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new ApiError(404, `no server named "${ref}"`);
  throw new ApiError(409, `several servers are named "${ref}" — use an id: ${matches.map((s) => s.id).join(', ')}`);
}

export async function run(argv: string[], deps: CliDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    deps.err(`${err instanceof Error ? err.message : err}\n\n${USAGE}`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const [group, verb, ...rest] = positionals;
  if (!group || opts.help || group === 'help') {
    deps.out(USAGE);
    return group || opts.help ? 0 : 2;
  }

  try {
    if (group === 'login') {
      if (!opts.url || !opts.token) throw new UsageError('login needs --url and --token');
      const client = deps.makeClient(opts.url.replace(/\/+$/, ''), opts.token);
      // Checked before it is saved: a typo should fail here, not on the next command.
      const me = await client.request<{ email: string }>('GET', '/me');
      await deps.writeConfig({ url: opts.url.replace(/\/+$/, ''), token: opts.token });
      deps.out(`Signed in to ${opts.url} as ${me.email}. Saved to ${deps.configFile}.\n`);
      return 0;
    }

    const config = resolveConfig(deps.env, await deps.readConfig());
    if (!config.url || !config.token) {
      throw new UsageError('not signed in — run `nexusctl login --url <panel> --token <token>`, or set NEXUSCTL_URL and NEXUSCTL_TOKEN');
    }
    const client = deps.makeClient(config.url, config.token);
    const print = (value: unknown, human: () => string) => deps.out(opts.json ? JSON.stringify(value, null, 2) + '\n' : human());

    if (group === 'whoami') {
      const me = await client.request<{ email: string; displayName: string; platformRole: string }>('GET', '/me');
      print(me, () => `${me.displayName} <${me.email}> — ${me.platformRole}\n`);
      return 0;
    }

    if (group === 'nodes' && verb === 'list') {
      const nodes = await client.request<Array<{ id: string; name: string; health: string; location: string | null; cpuPercent: number | null; ramUsedMb: number | null; ramTotalMb: number | null; maintenance?: boolean }>>('GET', '/nodes');
      print(nodes, () =>
        table(
          nodes.map((n) => ({
            id: n.id,
            name: n.name,
            health: n.maintenance ? `${n.health} (draining)` : n.health,
            cpu: n.cpuPercent == null ? '-' : `${Math.round(n.cpuPercent)}%`,
            ram: n.ramUsedMb == null || !n.ramTotalMb ? '-' : `${Math.round((n.ramUsedMb / n.ramTotalMb) * 100)}%`,
            location: n.location ?? '',
          })),
          [{ key: 'id', title: 'id' }, { key: 'name', title: 'name' }, { key: 'health', title: 'health' }, { key: 'cpu', title: 'cpu' }, { key: 'ram', title: 'ram' }, { key: 'location', title: 'location' }],
        ) || 'No nodes.\n',
      );
      return 0;
    }

    if (group === 'servers') {
      if (verb === 'list') {
        const query = new URLSearchParams({ limit: '200' });
        if (opts.status) query.set('status', opts.status);
        if (opts.search) query.set('q', opts.search);
        const page = await client.request<{ items: Server[]; total: number }>('GET', `/deployments?${query}`);
        print(page.items, () => {
          const rows = table(
            page.items.map((s) => ({ id: s.id, name: s.name, status: s.status, node: s.nodeId ?? '-', image: s.dockerImage, created: ago(s.createdAt) })),
            [{ key: 'id', title: 'id' }, { key: 'name', title: 'name' }, { key: 'status', title: 'status' }, { key: 'node', title: 'node' }, { key: 'image', title: 'image' }, { key: 'created', title: 'created' }],
          );
          const more = page.total > page.items.length ? `…and ${page.total - page.items.length} more; narrow it with --search or --status.\n` : '';
          return (rows || 'No servers.\n') + more;
        });
        return 0;
      }

      if (verb === 'show') {
        if (!rest[0]) throw new UsageError('servers show <server>');
        const s = await client.request<Server>('GET', `/deployments/${(await resolveServer(client, rest[0])).id}`);
        print(s, () => {
          const ports = Object.entries(s.ports ?? {}).map(([h, c]) => `${h}→${c}`).join(', ') || '-';
          const recent = (s.events ?? []).slice(-5).reverse().map((e) => `  ${ago(e.timestamp).padEnd(8)} ${e.event}: ${e.message}`).join('\n');
          return `${s.name} (${s.id})\n  status  ${s.status}\n  image   ${s.dockerImage}\n  node    ${s.nodeId ?? '-'}\n  ports   ${ports}\n  role    ${s.role ?? '-'}\nRecent activity:\n${recent || '  none'}\n`;
        });
        return 0;
      }

      if (verb === 'create') {
        if (!opts.name) throw new UsageError('servers create needs --name');
        if (!opts.image === !opts.egg) throw new UsageError('servers create needs exactly one of --image or --egg');
        const body: Record<string, unknown> = {
          name: opts.name,
          ports: pairs(opts.port, ':', '--port'),
          ...(opts.node ? { nodeId: opts.node } : {}),
          ...(opts.persist?.length ? { persistPaths: opts.persist } : {}),
          ...(opts.egg ? { eggId: opts.egg, eggValues: pairs(opts.var, '=', '--var') } : { dockerImage: opts.image, env: pairs(opts.env, '=', '--env'), type: 'app' }),
        };
        const created = await client.request<Server>('POST', '/deployments', body);
        print(created, () => `Created ${created.name} (${created.id}) on ${created.nodeId ?? 'a node'} — starting.\n`);
        return 0;
      }

      if (verb === 'start' || verb === 'stop' || verb === 'restart' || verb === 'kill') {
        if (!rest.length) throw new UsageError(`servers ${verb} <server>...`);
        const ids = [];
        for (const ref of rest) ids.push((await resolveServer(client, ref)).id);
        // One request for any number, authorized per server (#238); it answers
        // for each, so a partial failure is reported server by server.
        const outcome = await client.request<{ succeeded: number; failed: number; results: Array<{ id: string; name?: string; ok: boolean; error?: string }> }>('POST', '/deployments/bulk', { action: verb, ids });
        print(outcome, () =>
          outcome.results.map((r) => `${r.ok ? 'ok    ' : 'failed'} ${r.name ?? r.id}${r.ok ? '' : ` — ${r.error}`}`).join('\n') + '\n',
        );
        return outcome.failed ? 1 : 0;
      }

      if (verb === 'delete') {
        if (!rest[0]) throw new UsageError('servers delete <server> --yes');
        const server = await resolveServer(client, rest[0]);
        if (!opts.yes) throw new UsageError(`deleting ${server.name} removes its data and backups for good — add --yes to confirm`);
        await client.request('DELETE', `/deployments/${server.id}`);
        deps.out(`Deleted ${server.name}.\n`);
        return 0;
      }

      if (verb === 'logs') {
        if (!rest[0]) throw new UsageError('servers logs <server> [--follow]');
        const server = await resolveServer(client, rest[0]);
        // Without --follow, stop once the backlog the agent sends first has gone quiet.
        const controller = new AbortController();
        deps.signal?.addEventListener('abort', () => controller.abort());
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const armQuiet = () => {
          if (opts.follow) return;
          clearTimeout(quiet);
          quiet = setTimeout(() => controller.abort(), 1500);
        };
        armQuiet();
        try {
          await client.stream(`/deployments/${server.id}/logs`, (line) => {
            deps.out(line + '\n');
            armQuiet();
          }, controller.signal);
        } catch (err) {
          if (!controller.signal.aborted) throw err;
        } finally {
          clearTimeout(quiet);
        }
        return 0;
      }

      if (verb === 'update-image') {
        if (!rest[0]) throw new UsageError('servers update-image <server>');
        const server = await resolveServer(client, rest[0]);
        const r = await client.request<{ recreate: boolean }>('POST', `/deployments/${server.id}/update`);
        deps.out(r.recreate ? `Pulling ${server.dockerImage}; ${server.name} is recreated from it once the pull succeeds.\n` : `Pulling ${server.dockerImage}; ${server.name} uses it on its next start.\n`);
        return 0;
      }
    }

    if (group === 'backups') {
      if (!rest[0]) throw new UsageError(`backups ${verb ?? '<command>'} <server>`);
      const server = await resolveServer(client, rest[0]);
      const base = `/deployments/${server.id}/backups`;

      if (verb === 'list') {
        const list = await client.request<Array<{ id: string; name: string; sizeBytes: number; createdAt: string; offsite?: string | null }>>('GET', base);
        print(list, () =>
          table(
            list.map((b) => ({ id: b.id, name: b.name, size: bytes(b.sizeBytes), offsite: b.offsite ?? '-', created: ago(b.createdAt) })),
            [{ key: 'id', title: 'id' }, { key: 'name', title: 'name' }, { key: 'size', title: 'size' }, { key: 'offsite', title: 'off-site' }, { key: 'created', title: 'created' }],
          ) || 'No backups.\n',
        );
        return 0;
      }
      if (verb === 'create') {
        const b = await client.request<{ id: string; name: string; sizeBytes: number; expired?: number }>('POST', base, {});
        print(b, () => `Created ${b.name} (${bytes(b.sizeBytes)})${b.expired ? `; retention removed ${b.expired} older` : ''}.\n`);
        return 0;
      }
      if (verb === 'restore') {
        if (!rest[1]) throw new UsageError('backups restore <server> <backup id> --yes');
        if (!opts.yes) throw new UsageError(`restoring replaces files in ${server.name} with the backup's — add --yes to confirm`);
        await client.request('POST', `${base}/${rest[1]}/restore`);
        deps.out(`Restored ${rest[1]} into ${server.name}.\n`);
        return 0;
      }
      if (verb === 'download') {
        if (!rest[1]) throw new UsageError('backups download <server> <backup id> [--output <file>]');
        const { bytes: data, filename } = await client.download(`${base}/${rest[1]}/download`);
        const target = opts.output ?? filename ?? `${rest[1]}.tar`;
        await deps.writeFile(target, data);
        deps.out(`Saved ${bytes(data.length)} to ${target}.\n`);
        return 0;
      }
    }

    throw new UsageError(`unknown command: ${[group, verb].filter(Boolean).join(' ')}`);
  } catch (err) {
    if (err instanceof UsageError) {
      deps.err(`${err.message}\n`);
      return 2;
    }
    if (err instanceof ApiError) {
      deps.err(`error: ${err.message}${err.status === 401 ? ' — sign in again with `nexusctl login`' : ''}\n`);
      return 1;
    }
    throw err;
  }
}
