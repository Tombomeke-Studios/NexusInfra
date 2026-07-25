import { describe, it, expect } from 'vitest';
import { buildGameDeployment } from './gameSpec';

describe('buildGameDeployment', () => {
  it('maps Minecraft to itzg with the software TYPE, version and slots', () => {
    const g = buildGameDeployment({ game: 'minecraft', software: 'fabric', version: '1.21.4', slots: 20, motd: 'Hi' });
    expect(g.dockerImage).toBe('itzg/minecraft-server');
    expect(g.ports).toEqual({ '25565': '25565' });
    expect(g.env).toMatchObject({ EULA: 'TRUE', TYPE: 'FABRIC', VERSION: '1.21.4', MAX_PLAYERS: '20', MOTD: 'Hi' });
  });

  it('defaults the Minecraft TYPE to PAPER for an unknown software', () => {
    expect(buildGameDeployment({ game: 'minecraft', software: 'weird', version: '1.20', slots: 8, motd: '' }).env.TYPE).toBe('PAPER');
  });

  it('falls back to a default MOTD when blank', () => {
    expect(buildGameDeployment({ game: 'minecraft', software: 'paper', version: '1.21', slots: 8, motd: '   ' }).env.MOTD).toBe('A NexusInfra server');
  });

  it('maps other games to their real images and ports', () => {
    expect(buildGameDeployment({ game: 'valheim', software: '', version: '', slots: 10, motd: '' }).dockerImage).toBe('lloesche/valheim-server');
    expect(buildGameDeployment({ game: 'rust', software: '', version: '', slots: 50, motd: '' }).ports).toEqual({ '28015': '28015' });
    expect(buildGameDeployment({ game: 'cs2', software: '', version: '', slots: 12, motd: 'x' }).env.CS2_MAXPLAYERS).toBe('12');
  });

  it('falls back to Minecraft for an unknown game', () => {
    expect(buildGameDeployment({ game: 'doom', software: 'paper', version: '1.21', slots: 4, motd: '' }).dockerImage).toBe('itzg/minecraft-server');
  });
});
