import { describe, it, expect } from 'vitest';
import { EGGS, getEgg, buildEggDeployment, variableApplies, EggValidationError, type Egg } from './eggs.js';

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
});
