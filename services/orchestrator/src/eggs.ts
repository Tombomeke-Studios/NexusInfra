// Egg catalogue (#231) — the recipes a server can be created from.
//
// An "egg" describes how to run one kind of server: which image, which ports, and
// which variables a person may set, with their defaults, meaning and validation.
// It replaces the dashboard's `gameSpec.ts`, which hardcoded four games in the
// browser. That put the mapping on the wrong side of the wire: a caller who did
// not use the form could deploy the Minecraft image without EULA=TRUE, or pass
// arbitrary environment straight through to the container.
//
// Pure and dependency-free — the catalogue is data and `buildEggDeployment` is
// the only behaviour, both unit-tested. The API serves the catalogue so the panel
// renders its form from it rather than carrying a second copy.

export type EggVariableKind = 'string' | 'integer' | 'boolean' | 'choice' | 'version';

/**
 * When a variable applies at all (#311).
 *
 * `NEOFORGE_VERSION` means nothing to a Paper server. Without this the form
 * would ask everyone for it and the container would receive it regardless —
 * environment that does not apply is noise at best and, when two loaders read
 * near-identical names, a way to install the wrong thing.
 */
export interface EggVariableCondition {
  /** Another variable's key. */
  key: string;
  /** The values of that variable for which this one applies. */
  equals: string[];
}

export interface EggVariable {
  /** The environment variable set on the container. */
  key: string;
  label: string;
  /** Shown next to the field — say what it does, not what it is called. */
  description: string;
  kind: EggVariableKind;
  default: string;
  /** Allowed values for `choice`; ignored otherwise. */
  options?: string[];
  /** Inclusive bounds for `integer`; ignored otherwise. */
  min?: number;
  max?: number;
  /**
   * Where a `version` variable's suggestions come from. Resolved when the
   * catalogue is served, not here — this file stays pure data (#311).
   */
  optionsSource?: 'minecraft-versions';
  /** When this variable applies; always, when absent. */
  showWhen?: EggVariableCondition;
}

/** Whether `variable` applies, given the answers chosen so far (#311). */
export function variableApplies(variable: EggVariable, values: Record<string, string>): boolean {
  const condition = variable.showWhen;
  if (!condition) return true;
  return condition.equals.includes(values[condition.key] ?? '');
}

export interface Egg {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  /** Default host→container port mapping; the creator may override the host side. */
  ports: Record<string, string>;
  /**
   * Where this server keeps its own files inside the container. Backups target it,
   * and importing an existing directory mounts over it (#268).
   */
  dataPath: string;
  variables: EggVariable[];
  /**
   * Which variable is the JVM heap, when the server has one (#271).
   *
   * Named rather than inferred, because the heap is the one setting that must be
   * reconciled with the container's memory cap: the JVM commits it, so a heap
   * that does not fit is a container the kernel kills rather than a server that
   * runs slowly.
   */
  memoryVariable?: string;
  /**
   * Environment the egg always sets and the creator cannot change. Kept apart from
   * `variables` so something like a licence acceptance cannot be dropped by a
   * caller that skips the form.
   */
  fixedEnv?: Record<string, string>;
}

const MINECRAFT: Egg = {
  id: 'minecraft-java',
  name: 'Minecraft (Java Edition)',
  description:
    'A Java Edition server built on itzg/minecraft-server. Vanilla, the plugin servers and every mod loader come from the same image — pick the server software below.',
  dockerImage: 'itzg/minecraft-server',
  ports: { '25565': '25565' },
  dataPath: '/data',
  memoryVariable: 'MEMORY',
  // Accepting the EULA is a condition of running the server at all, so it is not a
  // question the form asks — creating a Minecraft server is the acceptance.
  fixedEnv: { EULA: 'TRUE' },
  variables: [
    {
      key: 'TYPE',
      label: 'Server software',
      description:
        'Vanilla is Mojang’s own server. Paper is a faster drop-in replacement that runs plugins, and Purpur and Spigot are variations on it. Fabric, Forge, NeoForge and Quilt run mods — NeoForge is where the Forge ecosystem moved from Minecraft 1.20.2 onwards, so a modern modpack usually wants that one.',
      kind: 'choice',
      default: 'VANILLA',
      options: ['VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'],
    },
    {
      key: 'VERSION',
      label: 'Game version',
      description:
        'Which Minecraft version to run. LATEST always takes the newest release, so a restart moves the server forward; pick a number to stay put — which is what a modpack needs.',
      kind: 'version',
      optionsSource: 'minecraft-versions',
      default: 'LATEST',
    },
    {
      key: 'NEOFORGE_VERSION',
      label: 'NeoForge build',
      description:
        'Which NeoForge build to install for that Minecraft version. “latest” takes the newest stable one, “beta” allows pre-release builds, or name a build such as 21.1.208. Leave it on latest unless a modpack asks for a specific one.',
      kind: 'string',
      default: 'latest',
      // Only NeoForge reads this, and it is deliberately not FORGE_VERSION:
      // setting the wrong one of those installs the wrong loader build.
      showWhen: { key: 'TYPE', equals: ['NEOFORGE'] },
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      description: 'How many people may be connected at once.',
      kind: 'integer',
      default: '20',
      min: 1,
      max: 200,
    },
    {
      key: 'MOTD',
      label: 'Server description',
      description: 'The line shown under the server name in the client’s multiplayer list.',
      kind: 'string',
      default: 'A NexusInfra server',
    },
    {
      key: 'DIFFICULTY',
      label: 'Difficulty',
      description: 'Peaceful spawns no hostile mobs; hard makes them tougher and lets hunger kill you.',
      kind: 'choice',
      default: 'normal',
      options: ['peaceful', 'easy', 'normal', 'hard'],
    },
    {
      key: 'ONLINE_MODE',
      label: 'Verify accounts with Mojang',
      description:
        'On means only people with a paid, logged-in account can join, and skins work. Turn it off only on a server nobody outside your network can reach.',
      kind: 'boolean',
      default: 'true',
    },
    {
      key: 'MEMORY',
      label: 'Java heap size',
      description:
        'How much memory the server may actually use, e.g. 2G. Java claims all of this up front, so it is taken whether the server needs it or not — and it has to fit inside the memory limit set below, with room to spare for Java itself.',
      kind: 'string',
      default: '2G',
    },
  ],
};

const VALHEIM: Egg = {
  id: 'valheim',
  name: 'Valheim',
  description: 'A dedicated Valheim server (lloesche/valheim-server).',
  dockerImage: 'lloesche/valheim-server',
  ports: { '2456': '2456' },
  dataPath: '/config',
  variables: [
    { key: 'SERVER_NAME', label: 'Server name', description: 'Shown in the server browser.', kind: 'string', default: 'A NexusInfra server' },
    { key: 'WORLD_NAME', label: 'World name', description: 'The save this server loads and writes.', kind: 'string', default: 'NexusInfra' },
    {
      key: 'SERVER_PASS',
      label: 'Password',
      description: 'Required to join. Valheim refuses to start a public server without one of at least 5 characters.',
      kind: 'string',
      default: 'changeme',
    },
    { key: 'SERVER_PUBLIC', label: 'List publicly', description: 'Whether the server appears in the public browser.', kind: 'boolean', default: 'true' },
  ],
};

const RUST: Egg = {
  id: 'rust',
  name: 'Rust',
  description: 'A dedicated Rust server (didstopia/rust-server).',
  dockerImage: 'didstopia/rust-server',
  ports: { '28015': '28015' },
  dataPath: '/steamcmd/rust',
  variables: [
    { key: 'RUST_SERVER_NAME', label: 'Server name', description: 'Shown in the server browser.', kind: 'string', default: 'A NexusInfra server' },
    { key: 'RUST_SERVER_MAXPLAYERS', label: 'Player slots', description: 'How many people may be connected at once.', kind: 'integer', default: '50', min: 1, max: 500 },
  ],
};

const CS2: Egg = {
  id: 'cs2',
  name: 'Counter-Strike 2',
  description: 'A dedicated CS2 server (joedwards32/cs2).',
  dockerImage: 'joedwards32/cs2',
  ports: { '27015': '27015' },
  dataPath: '/home/steam/cs2-dedicated',
  variables: [
    { key: 'CS2_SERVERNAME', label: 'Server name', description: 'Shown in the server browser.', kind: 'string', default: 'A NexusInfra server' },
    { key: 'CS2_MAXPLAYERS', label: 'Player slots', description: 'How many people may be connected at once.', kind: 'integer', default: '10', min: 1, max: 64 },
  ],
};

/** Every egg the panel can create a server from, in the order it offers them. */
export const EGGS: readonly Egg[] = [MINECRAFT, VALHEIM, RUST, CS2];

export function getEgg(id: string): Egg | null {
  return EGGS.find((e) => e.id === id) ?? null;
}

/** Thrown when a submitted value is not one the egg accepts. */
export class EggValidationError extends Error {}

function coerce(variable: EggVariable, raw: string): string {
  const value = String(raw).trim();

  switch (variable.kind) {
    case 'choice':
      if (!variable.options?.includes(value)) {
        throw new EggValidationError(`${variable.label} must be one of: ${variable.options?.join(', ')}`);
      }
      return value;

    case 'integer': {
      // Reject '12abc' and '1.5', which Number() and parseInt() disagree about.
      if (!/^-?\d+$/.test(value)) throw new EggValidationError(`${variable.label} must be a whole number`);
      const n = Number(value);
      if (variable.min != null && n < variable.min) throw new EggValidationError(`${variable.label} must be at least ${variable.min}`);
      if (variable.max != null && n > variable.max) throw new EggValidationError(`${variable.label} must be at most ${variable.max}`);
      return String(n);
    }

    case 'boolean':
      if (!['true', 'false'].includes(value.toLowerCase())) throw new EggValidationError(`${variable.label} must be true or false`);
      return value.toLowerCase();

    case 'version': {
      // Deliberately a shape check, not a membership check (#311). The offered
      // list comes from Mojang and can be stale, cold or unreachable; refusing a
      // version the image would install, because our copy has not caught up,
      // would be worse than the free-text field this replaced. What is rejected
      // here is what could not be a version at all.
      if (!value) throw new EggValidationError(`${variable.label} cannot be empty`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new EggValidationError(`${variable.label} is not a valid version`);
      }
      return value;
    }

    case 'string':
      if (!value) throw new EggValidationError(`${variable.label} cannot be empty`);
      return value;
  }
}

export interface EggDeployment {
  dockerImage: string;
  ports: Record<string, string>;
  env: Record<string, string>;
  dataPath: string;
}

/**
 * Turn an egg plus the creator's answers into the image, ports and environment a
 * deployment needs.
 *
 * Runs on the server rather than in the form, so the egg's rules hold for every
 * caller: a missing answer takes the default, an unknown key is dropped rather
 * than passed through as arbitrary container environment, and `fixedEnv` is
 * applied last so nothing can override it.
 */
export function buildEggDeployment(
  egg: Egg,
  values: Record<string, string> = {},
  portOverrides?: Record<string, string>
): EggDeployment {
  // Resolve in two passes: a condition may name a variable declared later, and
  // "which type did they choose" has to be settled before asking what depends on
  // it. The first pass answers every variable; the second drops the ones that do
  // not apply, so the container never receives environment for a loader it is
  // not running (#311).
  const answered: Record<string, string> = {};
  for (const variable of egg.variables) {
    const raw = values[variable.key];
    answered[variable.key] = raw === undefined || String(raw).trim() === '' ? variable.default : coerce(variable, String(raw));
  }

  const env: Record<string, string> = {};
  for (const variable of egg.variables) {
    if (variableApplies(variable, answered)) env[variable.key] = answered[variable.key];
  }
  const ports = portOverrides && Object.keys(portOverrides).length > 0 ? portOverrides : { ...egg.ports };
  return {
    dockerImage: egg.dockerImage,
    ports,
    env: { ...env, ...(egg.fixedEnv ?? {}) },
    dataPath: egg.dataPath,
  };
}
