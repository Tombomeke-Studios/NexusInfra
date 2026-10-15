import { describe, it, expect } from 'vitest';
import type { ServerQuery } from './api';
import { compactPlayers, describeQuery } from './playerStatus';

const base: ServerQuery = {
  status: 'online',
  protocol: 'minecraft',
  players: { online: 2, max: 20 },
  version: 'Paper 1.21.1',
  motd: 'A NexusInfra server',
  name: null,
  map: null,
  latencyMs: 3,
  checkedAt: '2026-10-15T12:00:00.000Z',
};

describe('describeQuery (#382)', () => {
  it('says how many are on, and what else the game said', () => {
    expect(describeQuery(base)).toMatchObject({
      label: '2 / 20 players',
      variant: 'success',
      detail: 'A NexusInfra server · Paper 1.21.1 · 3 ms',
    });
  });

  it('uses the A2S server name and map', () => {
    const d = describeQuery({ ...base, protocol: 'a2s', motd: null, name: 'Vikings', map: 'Dedicated', version: '0.219' });
    expect(d?.detail).toBe('Vikings · 0.219 · Dedicated · 3 ms');
  });

  it('never invents a count the server hid', () => {
    const d = describeQuery({ ...base, players: null });
    expect(d?.label).toBe('Answering');
    expect(d?.label).not.toMatch(/0/);
    expect(compactPlayers({ ...base, players: null })).toBe('Answering');
  });

  it('calls a server that does not answer what it is — not empty', () => {
    const d = describeQuery({ ...base, status: 'offline', players: null, error: 'no answer within 2500 ms' });
    expect(d).toMatchObject({ label: 'Not answering', variant: 'warning' });
    expect(d?.title).toContain('no answer within 2500 ms');
    expect(compactPlayers({ ...base, status: 'offline', players: null })).toBe('Not answering');
  });

  it('says it does not know when the node could not be asked', () => {
    expect(describeQuery({ ...base, status: 'unknown', players: null })?.label).toBe('Players unknown');
  });

  it('shows nothing for a stopped server, a kind it cannot ask, or no answer yet', () => {
    expect(describeQuery({ ...base, status: 'stopped', players: null })).toBeNull();
    expect(describeQuery({ ...base, status: 'unsupported', players: null })).toBeNull();
    expect(describeQuery(null)).toBeNull();
    expect(compactPlayers(null)).toBeNull();
  });

  it('gives the list a compact count', () => {
    expect(compactPlayers(base)).toBe('2/20 online');
  });
});
