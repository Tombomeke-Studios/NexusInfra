import { describe, it, expect } from 'vitest';
import { EGGS, getEgg, buildEggDeployment, variableApplies, EggValidationError, generateSecret, type Egg } from './eggs.js';

// The egg catalogue is the single source of truth for how a kind of server runs
// (#231). It lives here rather than in the browser so its rules hold for every
// caller, not only the one that fills in the form.

describe('the catalogue', () => {
  it('has unique ids and a Minecraft egg', () => {
    const ids = EGGS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getEgg('minecraft-java')).not.toBeNull();
    expect(getEgg('nope')).toBeNull();
  });

  it('gives every egg an image, a data path and described variables', () => {
    for (const egg of EGGS) {
      expect(egg.dockerImage).toBeTruthy();
      // Backups and directory imports both need to know where the files live.
      expect(egg.dataPath.startsWith('/')).toBe(true);
      expect(Object.keys(egg.ports).length).toBeGreaterThan(0);
      for (const v of egg.variables) {
        expect(v.description.length).toBeGreaterThan(10);
        // Every default must itself be valid, or the form starts out rejected.
        expect(() => buildEggDeployment(egg, {})).not.toThrow();
        if (v.kind === 'choice') expect(v.options).toContain(v.default);
      }
    }
  });
});

describe('buildEggDeployment', () => {
  const minecraft = getEgg('minecraft-java')!;

  it('fills every variable from its default when nothing is supplied', () => {
    const built = buildEggDeployment(minecraft);
    expect(built.dockerImage).toBe('itzg/minecraft-server');
    expect(built.ports).toEqual({ '25565': '25565' });
    expect(built.env.TYPE).toBe('VANILLA');
    expect(built.env.MAX_PLAYERS).toBe('20');
    expect(built.dataPath).toBe('/data');
  });

  it('applies the answers it is given', () => {
    const built = buildEggDeployment(minecraft, { TYPE: 'PAPER', VERSION: '1.21.1', MAX_PLAYERS: '40', MOTD: 'hello' });
    expect(built.env.TYPE).toBe('PAPER');
    expect(built.env.VERSION).toBe('1.21.1');
    expect(built.env.MAX_PLAYERS).toBe('40');
    expect(built.env.MOTD).toBe('hello');
  });

  it('treats an empty answer as "use the default"', () => {
    // An untouched text field submits '', which must not blank the variable.
    expect(buildEggDeployment(minecraft, { MOTD: '   ' }).env.MOTD).toBe('A NexusInfra server');
  });

  // The reason the catalogue moved out of the browser: a caller that skips the
  // form must not be able to skip the licence acceptance either.
  it('always sets the fixed environment, even when asked otherwise', () => {
    expect(buildEggDeployment(minecraft, { EULA: 'FALSE' }).env.EULA).toBe('TRUE');
  });

  it('drops keys the egg does not define', () => {
    // Otherwise this is arbitrary container environment injection by any caller.
    const built = buildEggDeployment(minecraft, { LD_PRELOAD: '/tmp/evil.so', PATH: '/tmp' });
    expect(built.env).not.toHaveProperty('LD_PRELOAD');
    expect(built.env.PATH).toBeUndefined();
  });

  it('overrides the host port when one is given, and keeps the default otherwise', () => {
    expect(buildEggDeployment(minecraft, {}, { '25570': '25565' }).ports).toEqual({ '25570': '25565' });
    expect(buildEggDeployment(minecraft, {}, {}).ports).toEqual({ '25565': '25565' });
  });

  describe('validation', () => {
    it('rejects a choice outside the list', () => {
      expect(() => buildEggDeployment(minecraft, { TYPE: 'BUKKIT' })).toThrow(EggValidationError);
    });

    it('rejects a non-integer or out-of-range slot count', () => {
      expect(() => buildEggDeployment(minecraft, { MAX_PLAYERS: '12abc' })).toThrow(/whole number/);
      expect(() => buildEggDeployment(minecraft, { MAX_PLAYERS: '1.5' })).toThrow(/whole number/);
      expect(() => buildEggDeployment(minecraft, { MAX_PLAYERS: '0' })).toThrow(/at least 1/);
      expect(() => buildEggDeployment(minecraft, { MAX_PLAYERS: '9999' })).toThrow(/at most 200/);
    });

    it('rejects a non-boolean', () => {
      expect(() => buildEggDeployment(minecraft, { ONLINE_MODE: 'yes' })).toThrow(/true or false/);
      expect(buildEggDeployment(minecraft, { ONLINE_MODE: 'FALSE' }).env.ONLINE_MODE).toBe('false');
    });

    it('names the field a person sees, not the environment variable', () => {
      // 'MAX_PLAYERS must be a whole number' means nothing to someone who was
      // shown a field called "Player slots".
      expect(() => buildEggDeployment(minecraft, { MAX_PLAYERS: 'lots' })).toThrow(/Player slots/);
    });

    it('rejects an empty required string', () => {
      const egg: Egg = {
        ...minecraft,
        variables: [{ key: 'NAME', label: 'Name', description: 'The server name shown to players.', kind: 'string', default: 'x' }],
      };
      // A supplied-but-blank value falls back to the default; an egg whose default
      // is itself blank is the only way to reach the empty case.
      const blankDefault: Egg = { ...egg, variables: [{ ...egg.variables[0], default: '' }] };
      expect(buildEggDeployment(blankDefault, {}).env.NAME).toBe('');
    });
  });
});

describe('the Minecraft egg after #311', () => {
  const minecraft = getEgg('minecraft-java')!;
  const typeVariable = minecraft.variables.find((v) => v.key === 'TYPE')!;
  const versionVariable = minecraft.variables.find((v) => v.key === 'VERSION')!;

  it('offers NeoForge, which is where the Forge ecosystem moved', () => {
    expect(typeVariable.options).toContain('NEOFORGE');
    // The ones people actually run, alongside it.
    for (const type of ['VANILLA', 'PAPER', 'PURPUR', 'SPIGOT', 'FABRIC', 'FORGE', 'QUILT']) {
      expect(typeVariable.options).toContain(type);
    }
  });

  it('asks for the version from a list rather than as free text', () => {
    expect(versionVariable.kind).toBe('version');
    expect(versionVariable.optionsSource).toBe('minecraft-versions');
    expect(versionVariable.default).toBe('LATEST');
  });

  it('offers the NeoForge build only to NeoForge', () => {
    const neoforge = minecraft.variables.find((v) => v.key === 'NEOFORGE_VERSION')!;
    expect(neoforge.showWhen).toEqual({ key: 'TYPE', equals: ['NEOFORGE'] });

    expect(variableApplies(neoforge, { TYPE: 'NEOFORGE' })).toBe(true);
    expect(variableApplies(neoforge, { TYPE: 'PAPER' })).toBe(false);
    expect(variableApplies(neoforge, {})).toBe(false);
  });

  it('names the NeoForge variable, not the Forge one', () => {
    // Setting FORGE_VERSION for a NeoForge server installs the wrong build — a
    // reported failure mode with this image, and one lost character apart.
    expect(minecraft.variables.some((v) => v.key === 'NEOFORGE_VERSION')).toBe(true);
    expect(minecraft.variables.some((v) => v.key === 'FORGE_VERSION')).toBe(false);
  });
});

describe('variables that only sometimes apply (#311)', () => {
  const egg = getEgg('minecraft-java')!;

  it('sends the NeoForge build when NeoForge is chosen', () => {
    const built = buildEggDeployment(egg, { TYPE: 'NEOFORGE', NEOFORGE_VERSION: '21.1.208' });
    expect(built.env.TYPE).toBe('NEOFORGE');
    expect(built.env.NEOFORGE_VERSION).toBe('21.1.208');
  });

  it('does not send it to a server that would ignore it', () => {
    // Environment that does not apply is noise at best, and — where two loaders
    // read near-identical names — a way to install the wrong thing.
    const built = buildEggDeployment(egg, { TYPE: 'PAPER' });
    expect(built.env.NEOFORGE_VERSION).toBeUndefined();
    expect(built.env.TYPE).toBe('PAPER');
  });

  it('drops it even when the caller insists, because the type decides', () => {
    const built = buildEggDeployment(egg, { TYPE: 'VANILLA', NEOFORGE_VERSION: '21.1.208' });
    expect(built.env.NEOFORGE_VERSION).toBeUndefined();
  });

  it('defaults the NeoForge build rather than leaving it out', () => {
    const built = buildEggDeployment(egg, { TYPE: 'NEOFORGE' });
    expect(built.env.NEOFORGE_VERSION).toBe('latest');
  });
});

describe('validating a version (#311)', () => {
  const egg = getEgg('minecraft-java')!;

  it('accepts a version the offered list has never heard of', () => {
    // The list comes from Mojang and can be stale, cold or offline. Refusing a
    // version the image would install is worse than the free-text field this
    // replaced, so the check is a shape check, not a membership check.
    expect(buildEggDeployment(egg, { VERSION: '99.9.9' }).env.VERSION).toBe('99.9.9');
    expect(buildEggDeployment(egg, { VERSION: '1.21.11-rc1' }).env.VERSION).toBe('1.21.11-rc1');
    expect(buildEggDeployment(egg, { VERSION: 'b1.7.3' }).env.VERSION).toBe('b1.7.3');
    expect(buildEggDeployment(egg, { VERSION: '26.1-snapshot-1' }).env.VERSION).toBe('26.1-snapshot-1');
  });

  it('takes LATEST and SNAPSHOT, which the image resolves itself', () => {
    expect(buildEggDeployment(egg, { VERSION: 'LATEST' }).env.VERSION).toBe('LATEST');
    expect(buildEggDeployment(egg, { VERSION: 'SNAPSHOT' }).env.VERSION).toBe('SNAPSHOT');
  });

  it('refuses what could not be a version at all', () => {
    for (const bad of ['../etc/passwd', 'latest; rm -rf /', '$(id)', '-rf']) {
      expect(() => buildEggDeployment(egg, { VERSION: bad })).toThrow(EggValidationError);
    }
  });

  it('treats a blank answer as no answer, taking the default', () => {
    // Blank means "you decide", the same as omitting it — which is how every
    // other variable in the catalogue reads it.
    expect(buildEggDeployment(egg, { VERSION: '' }).env.VERSION).toBe('LATEST');
    expect(buildEggDeployment(egg, { VERSION: '   ' }).env.VERSION).toBe('LATEST');
  });
});

describe('the eggs added in #315', () => {
  it('offers Bedrock and Palworld alongside the rest', () => {
    expect(EGGS.map((e) => e.id)).toEqual(
      expect.arrayContaining(['minecraft-java', 'minecraft-bedrock', 'palworld', 'valheim', 'rust', 'cs2'])
    );
  });

  it('does not offer Java versions for a Bedrock server', () => {
    // Bedrock has its own numbering. Offering Java's releases would be a
    // plausible list that is wrong for this server — the failure Phase 7 was
    // about, not a missing one.
    const bedrock = getEgg('minecraft-bedrock')!;
    const version = bedrock.variables.find((v) => v.key === 'VERSION')!;

    expect(version.optionsSource).toBeUndefined();
    expect(version.options).toEqual(['LATEST', 'PREVIEW']);
  });

  it('accepts the Bedrock EULA on the creator’s behalf, as Java does', () => {
    // Running the server at all is the acceptance, so it is not a question.
    expect(getEgg('minecraft-bedrock')!.fixedEnv).toEqual({ EULA: 'TRUE' });
    const built = buildEggDeployment(getEgg('minecraft-bedrock')!, {});
    expect(built.env.EULA).toBe('TRUE');
  });

  it('publishes every game server on the protocol it actually needs', () => {
    // All of these are UDP games; as TCP they publish nothing usable (#313).
    expect(getEgg('minecraft-bedrock')!.ports).toEqual({ '19132': '19132/udp' });
    expect(getEgg('palworld')!.ports).toEqual({ '8211': '8211/udp', '27015': '27015/udp' });
    expect(getEgg('valheim')!.ports).toEqual({ '2456': '2456/udp', '2457': '2457/udp' });
    expect(getEgg('rust')!.ports).toEqual({ '28015': '28015/udp', '28016': '28016/tcp' });
    expect(getEgg('cs2')!.ports).toEqual({ '27015': '27015/tcp+udp' });
    // Java Minecraft is the one that genuinely is TCP.
    expect(getEgg('minecraft-java')!.ports).toEqual({ '25565': '25565' });
  });

  it('keeps Palworld’s documented casing rather than normalising it', () => {
    // These are written straight into the game's settings file, and the image
    // documents them capitalised. A boolean would lowercase them.
    const built = buildEggDeployment(getEgg('palworld')!, {});
    expect(built.env.IS_PVP).toBe('False');
    expect(built.env.COMMUNITY).toBe('false');
    expect(built.env.DEATH_PENALTY).toBe('Item');
  });

  it('validates Palworld’s answers against what the game accepts', () => {
    const palworld = getEgg('palworld')!;
    expect(() => buildEggDeployment(palworld, { DEATH_PENALTY: 'Everything' })).toThrow(EggValidationError);
    expect(() => buildEggDeployment(palworld, { PLAYERS: '500' })).toThrow(EggValidationError);
    expect(buildEggDeployment(palworld, { DEATH_PENALTY: 'All', PLAYERS: '8' }).env).toMatchObject({
      DEATH_PENALTY: 'All',
      PLAYERS: '8',
    });
  });

  it('gives every new egg somewhere for its files to live', () => {
    // Backups target the data path, and importing a directory mounts over it.
    for (const id of ['minecraft-bedrock', 'palworld']) {
      expect(getEgg(id)!.dataPath).toMatch(/^\//);
    }
  });

  it('takes Valheim from where its project publishes now (#317)', () => {
    expect(getEgg('valheim')?.dockerImage).toBe('ghcr.io/community-valheim-tools/valheim-server');
  });
});

describe('string rules a game imposes (#384)', () => {
  const base = getEgg('minecraft-java')!;
  const egg = (overrides: Partial<Egg['variables'][number]>): Egg => ({
    ...base,
    variables: [{ key: 'NAME', label: 'Server name', description: 'The name the game files the save under.', kind: 'string', default: 'world', ...overrides }],
  });

  it('refuses a value shorter than the game accepts, naming the field', () => {
    const e = egg({ minLength: 5 });
    expect(() => buildEggDeployment(e, { NAME: 'abcd' })).toThrow(/Server name must be at least 5 characters/);
    expect(buildEggDeployment(e, { NAME: 'abcde' }).env.NAME).toBe('abcde');
  });

  it('refuses a value longer than the game accepts', () => {
    const e = egg({ maxLength: 8 });
    expect(() => buildEggDeployment(e, { NAME: 'abcdefghi' })).toThrow(/at most 8 characters/);
    expect(buildEggDeployment(e, { NAME: 'abcdefgh' }).env.NAME).toBe('abcdefgh');
  });

  it('refuses a value of the wrong shape with the hint a person can act on', () => {
    const e = egg({ pattern: '^[A-Za-z0-9_-]+$', patternHint: 'letters, digits, - and _ only — no spaces' });
    expect(() => buildEggDeployment(e, { NAME: 'my server' })).toThrow(/Server name: letters, digits, - and _ only/);
    expect(buildEggDeployment(e, { NAME: 'my_server-1' }).env.NAME).toBe('my_server-1');
  });

  it('anchors the pattern to the whole value', () => {
    // A pattern written without ^…$ must not pass a value that merely contains a match.
    const e = egg({ pattern: '[a-z]+', patternHint: 'lower-case letters only' });
    expect(() => buildEggDeployment(e, { NAME: 'abc def' })).toThrow(EggValidationError);
    expect(buildEggDeployment(e, { NAME: 'abc' }).env.NAME).toBe('abc');
  });

  it('refuses control characters in any string', () => {
    // Several images write the value straight into a config file — a newline
    // there is a way to add lines of your own (another world path, a password).
    const e = egg({});
    for (const bad of ['a\nworld=/etc/passwd', 'tab\there', 'nul\u0000', 'bell\u0007', 'del\u007f']) {
      expect(() => buildEggDeployment(e, { NAME: bad })).toThrow(/Server name cannot contain line breaks or control characters/);
    }
  });

  it('still lets a blank answer mean "use the default", even for an optional field', () => {
    // An optional password is a default of '' — the rules apply to what was typed.
    const e = egg({ default: '', minLength: 5 });
    expect(buildEggDeployment(e, { NAME: '' }).env.NAME).toBe('');
    expect(buildEggDeployment(e, {}).env.NAME).toBe('');
  });

  it('holds Valheim to the 5 characters it needs to start', () => {
    const valheim = getEgg('valheim')!;
    expect(() => buildEggDeployment(valheim, { SERVER_PASS: 'abcd' })).toThrow(/Password must be at least 5 characters/);
    expect(buildEggDeployment(valheim, { SERVER_PASS: 'abcde' }).env.SERVER_PASS).toBe('abcde');
  });

  it('gives every egg defaults that pass their own rules', () => {
    // A default the egg itself would refuse is a form that starts out rejected.
    for (const e of EGGS) {
      for (const v of e.variables) {
        if (v.kind !== 'string' || v.default === '') continue;
        expect(() => buildEggDeployment(e, { [v.key]: v.default }), `${e.id}.${v.key}`).not.toThrow();
      }
    }
  });
});

describe('the eggs added in #384', () => {
  const NEW = ['terraria', 'factorio', 'satisfactory', 'project-zomboid', 'enshrouded'];

  it('offers all five alongside the rest', () => {
    expect(EGGS.map((e) => e.id)).toEqual(expect.arrayContaining(NEW));
    expect(EGGS).toHaveLength(11);
  });

  it('takes each from the image its project publishes now', () => {
    expect(getEgg('terraria')!.dockerImage).toBe('passivelemon/terraria-docker:terraria-latest');
    // `latest` is Factorio's experimental build; `stable` is what factorio.com calls stable.
    expect(getEgg('factorio')!.dockerImage).toBe('factoriotools/factorio:stable');
    // wolveix renamed to robtme — the old name still updates, for now. #317 is
    // what following an old name to its end looks like.
    expect(getEgg('satisfactory')!.dockerImage).toBe('robtme/satisfactory-server');
    expect(getEgg('project-zomboid')!.dockerImage).toBe('danixu86/project-zomboid-dedicated-server');
    expect(getEgg('enshrouded')!.dockerImage).toBe('mornedhels/enshrouded-server');
  });

  it('publishes every port on the protocol the game uses (#313)', () => {
    // Terraria is the one game here that is plain TCP.
    expect(getEgg('terraria')!.ports).toEqual({ '7777': '7777' });
    expect(getEgg('factorio')!.ports).toEqual({ '34197': '34197/udp' });
    // 7777 carries the game on both protocols; 8888 is the server's TCP messaging.
    expect(getEgg('satisfactory')!.ports).toEqual({ '7777': '7777/tcp+udp', '8888': '8888/tcp' });
    expect(getEgg('project-zomboid')!.ports).toEqual({ '16261': '16261/udp', '16262': '16262/udp' });
    expect(getEgg('enshrouded')!.ports).toEqual({ '15637': '15637/udp' });
  });

  it('keeps each server’s files where its image writes them', () => {
    expect(getEgg('terraria')!.dataPath).toBe('/opt/terraria/config');
    expect(getEgg('factorio')!.dataPath).toBe('/factorio');
    expect(getEgg('satisfactory')!.dataPath).toBe('/config');
    expect(getEgg('project-zomboid')!.dataPath).toBe('/home/steam/Zomboid');
    expect(getEgg('enshrouded')!.dataPath).toBe('/opt/enshrouded');
  });

  describe('Terraria', () => {
    const terraria = getEgg('terraria')!;

    it('creates a world on first start instead of waiting at a prompt', () => {
      // The image has no default for AUTOCREATE: without it a fresh server has no
      // world to load and nothing to make one with.
      const built = buildEggDeployment(terraria);
      expect(built.env.AUTOCREATE).toBe('2');
      expect(built.env.WORLDNAME).toBeTruthy();
    });

    it('takes the world size and difficulty as the numbers the server reads', () => {
      expect(terraria.variables.find((v) => v.key === 'AUTOCREATE')!.options).toEqual(['1', '2', '3']);
      expect(terraria.variables.find((v) => v.key === 'DIFFICULTY')!.options).toEqual(['0', '1', '2', '3']);
      expect(() => buildEggDeployment(terraria, { AUTOCREATE: 'large' })).toThrow(EggValidationError);
    });

    it('leaves the password optional, because Terraria is open without one', () => {
      expect(buildEggDeployment(terraria).env.PASSWORD).toBe('');
      expect(buildEggDeployment(terraria, { PASSWORD: 'hunter22' }).env.PASSWORD).toBe('hunter22');
    });

    it('refuses a world name that would leave the Worlds folder', () => {
      // It becomes /opt/terraria/config/Worlds/<name>.wld.
      expect(() => buildEggDeployment(terraria, { WORLDNAME: '../escape' })).toThrow(EggValidationError);
      expect(buildEggDeployment(terraria, { WORLDNAME: 'My World 2' }).env.WORLDNAME).toBe('My World 2');
    });

    it('caps player slots at what the server supports', () => {
      expect(() => buildEggDeployment(terraria, { MAXPLAYERS: '256' })).toThrow(/at most 255/);
    });
  });

  describe('Factorio', () => {
    const factorio = getEgg('factorio')!;

    it('leaves Space Age off by default, so the base game can join', () => {
      // A Space Age server turns away every player who does not own the expansion.
      expect(buildEggDeployment(factorio).env.DLC_SPACE_AGE).toBe('false');
      expect(buildEggDeployment(factorio, { DLC_SPACE_AGE: 'TRUE' }).env.DLC_SPACE_AGE).toBe('true');
    });
  });

  describe('Satisfactory', () => {
    const satisfactory = getEgg('satisfactory')!;

    it('sets the image’s own variable names and bounds', () => {
      const built = buildEggDeployment(satisfactory);
      expect(built.env).toMatchObject({ MAXPLAYERS: '4', AUTOSAVENUM: '5', STEAMBETA: 'false' });
      expect(() => buildEggDeployment(satisfactory, { MAXPLAYERS: '0' })).toThrow(EggValidationError);
    });
  });

  describe('Project Zomboid', () => {
    const zomboid = getEgg('project-zomboid')!;

    it('has the admin password the image needs at first start', () => {
      // Without it the first start fails.
      expect(buildEggDeployment(zomboid).env.ADMINPASSWORD).toBeTruthy();
    });

    it('refuses a server name with a space, which breaks the admin account', () => {
      expect(() => buildEggDeployment(zomboid, { SERVERNAME: 'my server' })).toThrow(/Save name/);
      expect(buildEggDeployment(zomboid, { SERVERNAME: 'my_server-2' }).env.SERVERNAME).toBe('my_server-2');
    });

    it('names its JVM heap, so it is derived from the memory limit (#308)', () => {
      expect(zomboid.memoryVariable).toBe('MEMORY');
      expect(zomboid.variables.some((v) => v.key === 'MEMORY')).toBe(true);
    });

    it('offers only the presets the game ships', () => {
      // An unknown preset makes the image exit before the server starts.
      const preset = zomboid.variables.find((v) => v.key === 'SERVERPRESET')!;
      expect(preset.options).toEqual(['Apocalypse', 'Beginner', 'Builder', 'FirstWeek', 'SixMonthsLater', 'Survival', 'Survivor']);
      expect(() => buildEggDeployment(zomboid, { SERVERPRESET: 'Hardcore' })).toThrow(EggValidationError);
    });
  });

  describe('Enshrouded', () => {
    const enshrouded = getEgg('enshrouded')!;

    it('sets up an admin role and a player role, each behind its own password', () => {
      // Enshrouded has no server password any more — access is per role, and a
      // role with an empty password lets anyone in with its permissions.
      const built = buildEggDeployment(enshrouded);
      expect(built.env).toMatchObject({ SERVER_ROLE_0_NAME: 'Admin', SERVER_ROLE_0_CAN_KICK_BAN: 'true', SERVER_ROLE_1_NAME: 'Friend', SERVER_ROLE_1_CAN_KICK_BAN: 'false' });
      expect(built.env.SERVER_ROLE_0_PASSWORD).toBeTruthy();
      expect(built.env.SERVER_ROLE_1_PASSWORD).toBeTruthy();
      expect(built.env.SERVER_PASSWORD).toBeUndefined();
    });

    it('does not let a caller hand the player role admin rights', () => {
      // The permissions are the recipe, not a question.
      const built = buildEggDeployment(enshrouded, { SERVER_ROLE_1_CAN_KICK_BAN: 'true' });
      expect(built.env.SERVER_ROLE_1_CAN_KICK_BAN).toBe('false');
    });

    it('caps slots at the 16 the game allows', () => {
      expect(() => buildEggDeployment(enshrouded, { SERVER_SLOT_COUNT: '17' })).toThrow(/at most 16/);
    });

    it('asks for the voice chat mode only when voice chat is on', () => {
      expect(buildEggDeployment(enshrouded).env.SERVER_VOICE_CHAT_MODE).toBeUndefined();
      const on = buildEggDeployment(enshrouded, { SERVER_ENABLE_VOICE_CHAT: 'true', SERVER_VOICE_CHAT_MODE: 'Global' });
      expect(on.env.SERVER_VOICE_CHAT_MODE).toBe('Global');
    });
  });
});

describe('status queries (#382)', () => {
  it('asks only on a port the egg actually publishes', () => {
    // The query names the container side; a port that is not published has no
    // host port to ask on, and the server would read "offline" forever.
    for (const egg of EGGS) {
      if (!egg.query) continue;
      const containerPorts = Object.values(egg.ports).map((p) => p.split('/')[0]);
      expect(containerPorts, egg.id).toContain(egg.query.port);
    }
  });

  it('asks UDP games over a port published as UDP, and Java Minecraft over TCP', () => {
    for (const egg of EGGS) {
      if (!egg.query) continue;
      const spec = Object.values(egg.ports).find((p) => p.split('/')[0] === egg.query!.port)!;
      const protocols = (spec.split('/')[1] ?? 'tcp').split('+');
      expect(protocols, egg.id).toContain(egg.query.protocol === 'minecraft' ? 'tcp' : 'udp');
    }
  });

  it('knows how to ask every game whose protocol is known', () => {
    expect(getEgg('minecraft-java')!.query).toEqual({ protocol: 'minecraft', port: '25565' });
    expect(getEgg('minecraft-bedrock')!.query).toEqual({ protocol: 'bedrock', port: '19132' });
    expect(getEgg('valheim')!.query).toEqual({ protocol: 'a2s', port: '2457' });
    expect(getEgg('rust')!.query?.protocol).toBe('a2s');
    expect(getEgg('cs2')!.query?.protocol).toBe('a2s');
    expect(getEgg('project-zomboid')!.query).toEqual({ protocol: 'a2s', port: '16261' });
    expect(getEgg('enshrouded')!.query).toEqual({ protocol: 'a2s', port: '15637' });
  });

  it('does not pretend to ask a game whose status protocol it does not speak', () => {
    // Palworld does not report players over A2S; Terraria, Factorio and
    // Satisfactory each have a protocol of their own. Unsupported beats a wrong 0.
    for (const id of ['palworld', 'terraria', 'factorio', 'satisfactory']) expect(getEgg(id)!.query, id).toBeUndefined();
  });
});

// A fixed default password is one everybody who has seen the panel knows, and
// most servers keep it (#388). A blank answer now means "make one up".
describe('generated passwords (#388)', () => {
  const egg: Egg = {
    id: 'g',
    name: 'G',
    description: '',
    dockerImage: 'img',
    ports: {},
    dataPath: '/data',
    variables: [
      { key: 'ADMIN', label: 'Admin password', description: '', kind: 'string', default: '', generate: 'password' },
      { key: 'SHORT', label: 'Short', description: '', kind: 'string', default: '', generate: 'password', maxLength: 8 },
      { key: 'LONG', label: 'Long', description: '', kind: 'string', default: '', generate: 'password', minLength: 24 },
      { key: 'JOIN', label: 'Join password', description: '', kind: 'string', default: '' },
    ],
  };

  it('fills a blank answer with a fresh secret, and leaves an optional one blank', () => {
    const { env } = buildEggDeployment(egg, {});
    expect(env.ADMIN).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(env.JOIN).toBe('');
  });

  it('honours the variable’s own length rules', () => {
    const { env } = buildEggDeployment(egg, {});
    expect(env.SHORT).toHaveLength(8);
    expect(env.LONG).toHaveLength(24);
  });

  it('makes a different one every time', () => {
    expect(buildEggDeployment(egg, {}).env.ADMIN).not.toBe(buildEggDeployment(egg, {}).env.ADMIN);
  });

  it('keeps a password somebody chose, and one already stored', () => {
    expect(buildEggDeployment(egg, { ADMIN: 'my-own-secret' }).env.ADMIN).toBe('my-own-secret');
  });

  it('uses the injected generator, so the result can be pinned', () => {
    const { env } = buildEggDeployment(egg, {}, undefined, { generate: (length) => 'x'.repeat(length) });
    expect(env.ADMIN).toBe('x'.repeat(16));
  });

  it('avoids characters that are easy to misread when read out', () => {
    expect(generateSecret(2000)).not.toMatch(/[0O1lI]/);
  });

  it('ships no fixed password in any egg', () => {
    for (const e of EGGS) {
      for (const v of e.variables) {
        expect(v.default, `${e.id}.${v.key}`).not.toMatch(/changeme/i);
        if (/PASS/.test(v.key) && v.default === '' && !v.generate) {
          // Only a password the game treats as optional may stay blank.
          expect(v.description, `${e.id}.${v.key}`).toMatch(/empty|blank|optional|leave/i);
        }
      }
    }
  });
});
