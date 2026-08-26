import { describe, it, expect } from 'vitest';
import { EGGS, getEgg, buildEggDeployment, EggValidationError, type Egg } from './eggs.js';

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
