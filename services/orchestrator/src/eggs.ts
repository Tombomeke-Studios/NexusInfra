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
   * Length bounds for `string`, in characters (#384) — for the games that refuse
   * a value at startup rather than at the form: Valheim will not start with a
   * password under five characters.
   */
  minLength?: number;
  maxLength?: number;
  /**
   * The shape a `string` must have, as a regular expression source, matched
   * against the **whole** value (#384). Project Zomboid uses the server name as
   * a file name and breaks its admin account on a space.
   */
  pattern?: string;
  /** What `pattern` means in words — the message when it does not match. */
  patternHint?: string;
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

/**
 * How to ask a running server of this kind how it is doing (#382) — players,
 * version, MOTD. `port` is the **container** side of one of the egg's ports;
 * the host port it is published on is looked up per server, since the creator
 * may have chosen another.
 */
export interface EggQuery {
  protocol: 'minecraft' | 'bedrock' | 'a2s';
  port: string;
}

export interface Egg {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  /**
   * Default host→container port mapping; the creator may override the host side.
   *
   * The container side may name a protocol in Docker's notation — `2456/udp`,
   * `7777/tcp+udp` — because most game servers are UDP and publishing them as
   * TCP publishes nothing usable (#313). No suffix means TCP.
   */
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
  /** How to ask the game for its status (#382); absent when there is no way to. */
  query?: EggQuery;
}

const MINECRAFT: Egg = {
  id: 'minecraft-java',
  name: 'Minecraft (Java Edition)',
  description:
    'A Java Edition server built on itzg/minecraft-server. Vanilla, the plugin servers and every mod loader come from the same image — pick the server software below.',
  dockerImage: 'itzg/minecraft-server',
  ports: { '25565': '25565' },
  dataPath: '/data',
  query: { protocol: 'minecraft', port: '25565' },
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
  description: 'A dedicated Valheim server (community-valheim-tools/valheim-server).',
  // Where the project publishes now (#317): lloesche/valheim-server-docker moved
  // to community-valheim-tools, and the Docker Hub name stopped being updated.
  // Same image, same variables. Servers created before keep the name they were
  // created with — the recipe decides a *new* server's image.
  dockerImage: 'ghcr.io/community-valheim-tools/valheim-server',
  // UDP: 2456 carries the game, 2457 the Steam query that puts the server in the
  // browser. Valheim needs no TCP at all for play.
  ports: { '2456': '2456/udp', '2457': '2457/udp' },
  dataPath: '/config',
  query: { protocol: 'a2s', port: '2457' },
  variables: [
    { key: 'SERVER_NAME', label: 'Server name', description: 'Shown in the server browser.', kind: 'string', default: 'A NexusInfra server' },
    { key: 'WORLD_NAME', label: 'World name', description: 'The save this server loads and writes.', kind: 'string', default: 'NexusInfra' },
    {
      key: 'SERVER_PASS',
      label: 'Password',
      description: 'Required to join. Valheim refuses to start a public server without one of at least 5 characters.',
      kind: 'string',
      default: 'changeme',
      minLength: 5,
    },
    { key: 'SERVER_PUBLIC', label: 'List publicly', description: 'Whether the server appears in the public browser.', kind: 'boolean', default: 'true' },
  ],
};

const RUST: Egg = {
  id: 'rust',
  name: 'Rust',
  description: 'A dedicated Rust server (didstopia/rust-server).',
  dockerImage: 'didstopia/rust-server',
  // UDP 28015 is the game and the Steam query; TCP 28016 is RCON, which is the
  // only part of Rust that wants TCP.
  ports: { '28015': '28015/udp', '28016': '28016/tcp' },
  dataPath: '/steamcmd/rust',
  query: { protocol: 'a2s', port: '28015' },
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
  // Source servers use the same number for gameplay (UDP) and RCON (TCP).
  ports: { '27015': '27015/tcp+udp' },
  dataPath: '/home/steam/cs2-dedicated',
  query: { protocol: 'a2s', port: '27015' },
  variables: [
    { key: 'CS2_SERVERNAME', label: 'Server name', description: 'Shown in the server browser.', kind: 'string', default: 'A NexusInfra server' },
    { key: 'CS2_MAXPLAYERS', label: 'Player slots', description: 'How many people may be connected at once.', kind: 'integer', default: '10', min: 1, max: 64 },
  ],
};

const MINECRAFT_BEDROCK: Egg = {
  id: 'minecraft-bedrock',
  name: 'Minecraft (Bedrock Edition)',
  description:
    'A Bedrock Edition server (itzg/minecraft-bedrock-server) — the edition phones, consoles and the Windows app play. Bedrock and Java players cannot share a server, so pick the one your players use.',
  dockerImage: 'itzg/minecraft-bedrock-server',
  // UDP, like every Bedrock client. Published as TCP it answers nothing (#313).
  ports: { '19132': '19132/udp' },
  dataPath: '/data',
  query: { protocol: 'bedrock', port: '19132' },
  // Accepting the EULA is a condition of running the server at all, so it is not
  // a question the form asks — creating the server is the acceptance.
  fixedEnv: { EULA: 'TRUE' },
  variables: [
    {
      key: 'VERSION',
      label: 'Server version',
      description:
        'LATEST follows the newest release, so a restart moves the server forward. PREVIEW runs the preview build, which only preview clients can join.',
      // Deliberately its own short list rather than the Java one (#315): Bedrock
      // has separate numbering, and offering Java's releases here would be a
      // plausible list that is wrong for this server.
      kind: 'version',
      default: 'LATEST',
      options: ['LATEST', 'PREVIEW'],
    },
    {
      key: 'SERVER_NAME',
      label: 'Server name',
      description: 'Shown on the play screen when players find this server on the local network.',
      kind: 'string',
      default: 'A NexusInfra server',
    },
    {
      key: 'GAMEMODE',
      label: 'Game mode',
      description: 'What new players start in. Survival has health and hunger; creative gives unlimited blocks and flight.',
      kind: 'choice',
      default: 'survival',
      options: ['survival', 'creative', 'adventure'],
    },
    {
      key: 'DIFFICULTY',
      label: 'Difficulty',
      description: 'Peaceful spawns no hostile mobs; hard makes them tougher and lets hunger kill you.',
      kind: 'choice',
      default: 'easy',
      options: ['peaceful', 'easy', 'normal', 'hard'],
    },
    {
      key: 'MAX_PLAYERS',
      label: 'Player slots',
      description: 'How many people may be connected at once.',
      kind: 'integer',
      default: '10',
      min: 1,
      max: 100,
    },
    {
      key: 'LEVEL_NAME',
      label: 'World name',
      description: 'The save this server loads and writes. Changing it starts a new world rather than renaming the old one.',
      kind: 'string',
      default: 'Bedrock level',
    },
    {
      key: 'ALLOW_CHEATS',
      label: 'Allow cheats',
      description: 'Lets operators use commands such as /gamemode and /give. Off is the default for a survival world.',
      kind: 'boolean',
      default: 'false',
    },
    {
      key: 'ONLINE_MODE',
      label: 'Verify accounts with Xbox Live',
      description:
        'On means only signed-in accounts can join. Turn it off only on a server nobody outside your network can reach.',
      kind: 'boolean',
      default: 'true',
    },
  ],
};

const PALWORLD: Egg = {
  id: 'palworld',
  name: 'Palworld',
  description: 'A dedicated Palworld server (thijsvanloef/palworld-server-docker).',
  dockerImage: 'thijsvanloef/palworld-server-docker',
  // 8211 carries the game and 27015 the Steam query that lists the server. Both
  // UDP — as TCP they publish nothing usable (#313).
  ports: { '8211': '8211/udp', '27015': '27015/udp' },
  dataPath: '/palworld',
  // No `query` (#382): Palworld's dedicated server does not report its players
  // over A2S, so asking would show a confident and wrong count.
  variables: [
    {
      key: 'SERVER_NAME',
      label: 'Server name',
      description: 'Shown in the server browser.',
      kind: 'string',
      default: 'A NexusInfra server',
    },
    {
      key: 'SERVER_DESCRIPTION',
      label: 'Server description',
      description: 'The line shown under the name in the browser.',
      kind: 'string',
      default: 'Hosted on NexusInfra',
    },
    {
      key: 'SERVER_PASSWORD',
      label: 'Password',
      description: 'Required to join. Leave it as the default only on a server nobody outside your network can reach.',
      kind: 'string',
      default: 'changeme',
    },
    {
      key: 'ADMIN_PASSWORD',
      label: 'Admin password',
      description: 'Separate from the join password: it grants server commands, so it should not be the same one you hand to players.',
      kind: 'string',
      default: 'changeme-admin',
    },
    {
      key: 'PLAYERS',
      label: 'Player slots',
      description: 'How many people may be connected at once. Palworld is heavy per player — the RAM limit matters more here than the number.',
      kind: 'integer',
      default: '16',
      min: 1,
      max: 32,
    },
    {
      key: 'DEATH_PENALTY',
      label: 'On death you lose',
      description: 'What a player drops when they die. “All” includes their Pals, which is the harshest setting in the game.',
      kind: 'choice',
      default: 'Item',
      options: ['None', 'Item', 'ItemAndEquipment', 'All'],
    },
    {
      key: 'IS_PVP',
      label: 'Player versus player',
      description: 'Whether players can damage each other.',
      // The image's documented values are capitalised, and this is written
      // straight into the game's settings file — so the casing is kept as given
      // rather than normalised to a boolean.
      kind: 'choice',
      default: 'False',
      options: ['True', 'False'],
    },
    {
      key: 'COMMUNITY',
      label: 'List publicly',
      description: 'Whether the server appears in the community server browser. A public server wants a password.',
      kind: 'choice',
      default: 'false',
      options: ['true', 'false'],
    },
  ],
};

// ── Added in #384 ─────────────────────────────────────────────────────────────
// Each checked against the image's own README *and* entrypoint, because the two
// disagree more often than they should: names below are the ones the scripts read.

const TERRARIA: Egg = {
  id: 'terraria',
  name: 'Terraria',
  description:
    'A vanilla Terraria server (passivelemon/terraria-docker). It makes a world on first start; to bring your own, put the .wld file in Worlds/ and give its name below.',
  dockerImage: 'passivelemon/terraria-docker:terraria-latest',
  // Terraria is TCP only — the one game in the catalogue besides Java Minecraft.
  ports: { '7777': '7777' },
  dataPath: '/opt/terraria/config',
  variables: [
    {
      key: 'WORLDNAME',
      label: 'World name',
      description: 'The world this server loads — the file Worlds/<name>.wld. If there is none yet, one is made with the settings below.',
      kind: 'string',
      default: 'NexusInfra',
      maxLength: 64,
      // It becomes a path: no slashes, no dots, so it stays inside Worlds/.
      pattern: '[A-Za-z0-9][A-Za-z0-9 _-]*',
      patternHint: 'use letters, digits, spaces, - and _ only',
    },
    {
      key: 'AUTOCREATE',
      label: 'New world size',
      description:
        'Only used when the world does not exist yet: 1 is small, 2 medium, 3 large. Keep it on the size the world was made with — a smaller value on an existing world shows it corrupted until it is set back.',
      kind: 'choice',
      default: '2',
      options: ['1', '2', '3'],
    },
    {
      key: 'DIFFICULTY',
      label: 'New world difficulty',
      description: 'Only used when the world is created: 0 is classic, 1 expert, 2 master, 3 journey.',
      kind: 'choice',
      default: '0',
      options: ['0', '1', '2', '3'],
    },
    {
      key: 'MAXPLAYERS',
      label: 'Player slots',
      description: 'How many people may be connected at once.',
      kind: 'integer',
      default: '8',
      min: 1,
      max: 255,
    },
    {
      key: 'PASSWORD',
      label: 'Password',
      description: 'Asked of everyone who joins. Leave it empty for an open server — only on one nobody outside your network can reach.',
      kind: 'string',
      default: '',
    },
    {
      key: 'MOTD',
      label: 'Message of the day',
      description: 'Shown to players when they join. Empty shows nothing.',
      kind: 'string',
      default: '',
    },
  ],
};

const FACTORIO: Egg = {
  id: 'factorio',
  name: 'Factorio',
  description:
    'A Factorio headless server (factoriotools/factorio, stable releases). A map is generated on first start. The server name, password and public listing live in config/server-settings.json — edit it in the Files tab and restart.',
  // `latest` follows experimental releases; a save made there may not load on
  // stable again, so the recipe takes the build factorio.com calls stable.
  dockerImage: 'factoriotools/factorio:stable',
  // UDP. RCON (27015/tcp) is left unpublished: its password is generated into
  // config/rconpw, and an admin console nobody asked for is not a default.
  ports: { '34197': '34197/udp' },
  dataPath: '/factorio',
  variables: [
    {
      key: 'DLC_SPACE_AGE',
      label: 'Space Age expansion',
      description:
        'Turns on the Space Age, Quality and Elevated Rails mods. Everyone who joins then needs the expansion, and a save made with it will not load without it — decide before the first start.',
      kind: 'boolean',
      default: 'false',
    },
  ],
};

const SATISFACTORY: Egg = {
  id: 'satisfactory',
  name: 'Satisfactory',
  description:
    'A dedicated Satisfactory server (robtme/satisfactory-server). The first person to connect claims it: they name it and set its admin password from the in-game Server Manager. Wants 8 GB of memory or more once a factory grows.',
  // The project's new name (#317 is what an old one turns into): wolveix renamed
  // to robtme, and says wolveix/… keeps updating — for now.
  dockerImage: 'robtme/satisfactory-server',
  // 7777 carries the game on UDP *and* the server API on TCP; 8888 is the
  // server's own messaging port, TCP.
  ports: { '7777': '7777/tcp+udp', '8888': '8888/tcp' },
  dataPath: '/config',
  variables: [
    {
      key: 'MAXPLAYERS',
      label: 'Player slots',
      description: 'How many people may be connected at once. The game is built around four; more works, at a cost in memory and CPU.',
      kind: 'integer',
      default: '4',
      min: 1,
      max: 64,
    },
    {
      key: 'AUTOSAVENUM',
      label: 'Autosaves kept',
      description: 'How many rotating autosaves the server keeps before overwriting the oldest.',
      kind: 'integer',
      default: '5',
      min: 1,
      max: 100,
    },
    {
      key: 'DISABLESEASONALEVENTS',
      label: 'Turn off seasonal events',
      description: 'Stops the FICSMAS winter event from appearing in this world.',
      kind: 'boolean',
      default: 'false',
    },
    {
      key: 'STEAMBETA',
      label: 'Experimental branch',
      description: 'Runs the experimental build instead of the release. Players need the same branch, and a save opened there may not go back.',
      kind: 'boolean',
      default: 'false',
    },
  ],
};

const PROJECT_ZOMBOID: Egg = {
  id: 'project-zomboid',
  name: 'Project Zomboid',
  description:
    'A Project Zomboid dedicated server (danixu86/project-zomboid-dedicated-server, Build 42). Player slots and most rules live in Server/<save name>.ini — edit it in the Files tab.',
  dockerImage: 'danixu86/project-zomboid-dedicated-server',
  // Both UDP: 16261 the game, 16262 direct connections. RCON stays off — the game
  // disables it without a password, and this recipe does not set one.
  ports: { '16261': '16261/udp', '16262': '16262/udp' },
  dataPath: '/home/steam/Zomboid',
  // A Steam server: the game port answers A2S (#382).
  query: { protocol: 'a2s', port: '16261' },
  // The image passes MEMORY to both -Xms and -Xmx, like itzg's — so the JVM
  // commits it, and it has to fit the memory limit (#271, #308).
  memoryVariable: 'MEMORY',
  variables: [
    {
      key: 'SERVERNAME',
      label: 'Save name',
      description: 'Which save this server runs, and the name of its settings files. Changing it starts a different save — the old one stays and comes back if you change it back.',
      kind: 'string',
      default: 'nexusinfra',
      maxLength: 64,
      // The image's own warning: a space or special character breaks the admin account.
      pattern: '[A-Za-z0-9_-]+',
      patternHint: 'use letters, digits, - and _ only — no spaces',
    },
    {
      key: 'DISPLAYNAME',
      label: 'Server name',
      description: 'Shown in the in-game server browser.',
      kind: 'string',
      default: 'A NexusInfra server',
    },
    {
      key: 'ADMINPASSWORD',
      label: 'Admin password',
      description:
        'For the in-game account called admin. The server will not start the first time without one. The game prints it in its log on every start, so do not reuse a password you care about.',
      kind: 'string',
      default: 'changeme-admin',
    },
    {
      key: 'PASSWORD',
      label: 'Join password',
      description: 'Asked of everyone who joins. Empty leaves whatever the settings file already has — open, on a new server.',
      kind: 'string',
      default: '',
    },
    {
      key: 'PUBLIC',
      label: 'List publicly',
      description: 'Whether the server appears in the in-game public list.',
      kind: 'boolean',
      default: 'false',
    },
    {
      key: 'SERVERPRESET',
      label: 'Sandbox preset',
      description:
        'The rules a new save starts with — Apocalypse is the standard game, Builder and Beginner are gentler, Survivor is harder. Applied only when the save has no rules yet; after that, edit Server/<save name>_SandboxVars.lua.',
      kind: 'choice',
      default: 'Apocalypse',
      options: ['Apocalypse', 'Beginner', 'Builder', 'FirstWeek', 'SixMonthsLater', 'Survival', 'Survivor'],
    },
    {
      key: 'MEMORY',
      label: 'Java heap size',
      description:
        'How much memory the server may actually use, e.g. 4G. Java claims all of this up front, and it has to fit inside the memory limit set below with room to spare for Java itself.',
      kind: 'string',
      default: '4G',
    },
  ],
};

const ENSHROUDED: Egg = {
  id: 'enshrouded',
  name: 'Enshrouded',
  description:
    'A dedicated Enshrouded server (mornedhels/enshrouded-server). Players join with one of two passwords: the admin one, or the friend one, which can build and open chests but not kick or ban. The game recommends 16 GB of memory.',
  dockerImage: 'mornedhels/enshrouded-server',
  // UDP. The game moved everything onto the query port; there is no separate
  // game port to publish any more.
  ports: { '15637': '15637/udp' },
  dataPath: '/opt/enshrouded',
  // The query port is the Steam one, so it answers A2S (#382).
  query: { protocol: 'a2s', port: '15637' },
  // Enshrouded dropped its server password for roles, and a role with an empty
  // password lets anyone in with its rights. The recipe fixes the two roles and
  // what each may do, so a caller cannot hand the friend role a ban hammer; only
  // the passwords are questions.
  fixedEnv: {
    SERVER_ROLE_0_NAME: 'Admin',
    SERVER_ROLE_0_CAN_KICK_BAN: 'true',
    SERVER_ROLE_0_CAN_ACCESS_INVENTORIES: 'true',
    SERVER_ROLE_0_CAN_EDIT_WORLD: 'true',
    SERVER_ROLE_0_CAN_EDIT_BASE: 'true',
    SERVER_ROLE_0_CAN_EXTEND_BASE: 'true',
    SERVER_ROLE_1_NAME: 'Friend',
    SERVER_ROLE_1_CAN_KICK_BAN: 'false',
    SERVER_ROLE_1_CAN_ACCESS_INVENTORIES: 'true',
    SERVER_ROLE_1_CAN_EDIT_WORLD: 'true',
    SERVER_ROLE_1_CAN_EDIT_BASE: 'true',
    SERVER_ROLE_1_CAN_EXTEND_BASE: 'true',
  },
  variables: [
    { key: 'SERVER_NAME', label: 'Server name', description: 'Shown in the server browser.', kind: 'string', default: 'A NexusInfra server' },
    {
      key: 'SERVER_ROLE_0_PASSWORD',
      label: 'Admin password',
      description: 'Joining with this one makes you an admin: kick, ban and change anything. Make it different from the friend password — the game cannot tell two roles apart by the same one.',
      kind: 'string',
      default: 'changeme-admin',
    },
    {
      key: 'SERVER_ROLE_1_PASSWORD',
      label: 'Friend password',
      description: 'The one to hand to players: they can build, extend bases and open chests, but not kick or ban.',
      kind: 'string',
      default: 'changeme',
    },
    {
      key: 'SERVER_SLOT_COUNT',
      label: 'Player slots',
      description: 'How many people may be connected at once. Enshrouded allows up to 16.',
      kind: 'integer',
      default: '16',
      min: 1,
      max: 16,
    },
    { key: 'SERVER_ENABLE_TEXT_CHAT', label: 'Text chat', description: 'Whether players can type to each other in game.', kind: 'boolean', default: 'false' },
    { key: 'SERVER_ENABLE_VOICE_CHAT', label: 'Voice chat', description: 'Whether players can talk to each other in game.', kind: 'boolean', default: 'false' },
    {
      key: 'SERVER_VOICE_CHAT_MODE',
      label: 'Voice chat range',
      description: 'Proximity lets you hear players near you; Global puts everyone on one channel.',
      kind: 'choice',
      default: 'Proximity',
      options: ['Proximity', 'Global'],
      showWhen: { key: 'SERVER_ENABLE_VOICE_CHAT', equals: ['true'] },
    },
  ],
};

/** Every egg the panel can create a server from, in the order it offers them. */
export const EGGS: readonly Egg[] = [
  MINECRAFT,
  MINECRAFT_BEDROCK,
  PALWORLD,
  VALHEIM,
  RUST,
  CS2,
  TERRARIA,
  FACTORIO,
  SATISFACTORY,
  PROJECT_ZOMBOID,
  ENSHROUDED,
];

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
      // Several images write the value straight into a config file (#384), where
      // a line break is a way to add lines of your own — a second `world=`, say.
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(value)) {
        throw new EggValidationError(`${variable.label} cannot contain line breaks or control characters`);
      }
      if (variable.minLength != null && value.length < variable.minLength) {
        throw new EggValidationError(`${variable.label} must be at least ${variable.minLength} characters`);
      }
      if (variable.maxLength != null && value.length > variable.maxLength) {
        throw new EggValidationError(`${variable.label} must be at most ${variable.maxLength} characters`);
      }
      // Anchored here rather than trusted to the pattern, so one written without
      // ^…$ cannot pass a value that merely contains a match.
      if (variable.pattern && !new RegExp(`^(?:${variable.pattern})$`).test(value)) {
        throw new EggValidationError(`${variable.label}: ${variable.patternHint ?? 'not in the expected format'}`);
      }
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
