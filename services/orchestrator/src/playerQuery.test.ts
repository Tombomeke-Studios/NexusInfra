import { describe, it, expect } from 'vitest';
import { createQueryCache, emptyQuery, fromAgentAnswer, queryTargetFor } from './playerQuery.js';

const NOW = new Date('2026-10-15T12:00:00.000Z');

describe('queryTargetFor (#382)', () => {
  it('finds the host port the query port is published on', () => {
    expect(queryTargetFor({ protocol: 'a2s', port: '2457' }, { '2456': '2456/udp', '2457': '2457/udp' })).toEqual({ protocol: 'a2s', hostPort: 2457 });
  });

  it('follows a host port the creator chose, rather than the egg’s default', () => {
    expect(queryTargetFor({ protocol: 'minecraft', port: '25565' }, { '30001': '25565' })).toEqual({ protocol: 'minecraft', hostPort: 30001 });
  });

  it('reads a container port written with a protocol suffix', () => {
    expect(queryTargetFor({ protocol: 'a2s', port: '27015' }, { '27100': '27015/tcp+udp' })).toEqual({ protocol: 'a2s', hostPort: 27100 });
  });

  it('has no target when the egg has no query or the port is not published', () => {
    expect(queryTargetFor(undefined, { '25565': '25565' })).toBeNull();
    expect(queryTargetFor({ protocol: 'a2s', port: '2457' }, { '2456': '2456/udp' })).toBeNull();
  });

  it('ignores a host side that is not a port', () => {
    expect(queryTargetFor({ protocol: 'minecraft', port: '25565' }, { auto: '25565' })).toBeNull();
  });
});

describe('fromAgentAnswer', () => {
  it('passes an online answer through', () => {
    expect(
      fromAgentAnswer('minecraft', { status: 'online', players: { online: 2, max: 20 }, version: '1.21', motd: 'hi', name: null, map: null, latencyMs: 4 }, NOW)
    ).toEqual({
      status: 'online',
      protocol: 'minecraft',
      players: { online: 2, max: 20 },
      version: '1.21',
      motd: 'hi',
      name: null,
      map: null,
      latencyMs: 4,
      checkedAt: NOW.toISOString(),
    });
  });

  it('keeps a hidden player count as unknown, not zero', () => {
    expect(fromAgentAnswer('minecraft', { status: 'online', players: null }, NOW).players).toBeNull();
    expect(fromAgentAnswer('minecraft', { status: 'online', players: { online: -1, max: 20 } }, NOW).players).toBeNull();
  });

  it('reports offline with the reason and no players', () => {
    const q = fromAgentAnswer('a2s', { status: 'offline', error: 'no answer within 2500 ms' }, NOW);
    expect(q).toMatchObject({ status: 'offline', protocol: 'a2s', players: null, error: 'no answer within 2500 ms' });
  });

  it('treats a reply it does not understand as unknown', () => {
    expect(fromAgentAnswer('a2s', { error: 'Not Found' }, NOW).status).toBe('unknown');
    expect(fromAgentAnswer('a2s', null, NOW).status).toBe('unknown');
  });
});

describe('emptyQuery', () => {
  it('carries no figures at all', () => {
    expect(emptyQuery('stopped', {}, NOW)).toEqual({
      status: 'stopped',
      protocol: null,
      players: null,
      version: null,
      motd: null,
      name: null,
      map: null,
      latencyMs: null,
      checkedAt: NOW.toISOString(),
    });
  });
});

describe('createQueryCache', () => {
  function counter() {
    let calls = 0;
    const ask = async () => {
      calls++;
      return emptyQuery('online', {}, NOW);
    };
    return { ask, calls: () => calls };
  }

  it('asks once per ttl, however often it is polled', async () => {
    let t = 0;
    const cache = createQueryCache({ ttlMs: 10_000, now: () => t });
    const c = counter();
    await cache('d1', c.ask);
    t = 9_999;
    await cache('d1', c.ask);
    expect(c.calls()).toBe(1);
    t = 10_000;
    await cache('d1', c.ask);
    expect(c.calls()).toBe(2);
  });

  it('shares a question already in flight', async () => {
    const cache = createQueryCache({ now: () => 0 });
    let release!: () => void;
    let calls = 0;
    const ask = () =>
      new Promise<ReturnType<typeof emptyQuery>>((resolve) => {
        calls++;
        release = () => resolve(emptyQuery('online', {}, NOW));
      });
    const a = cache('d1', ask);
    const b = cache('d1', ask);
    release();
    expect(await a).toBe(await b);
    expect(calls).toBe(1);
  });

  it('keeps servers apart', async () => {
    const cache = createQueryCache({ now: () => 0 });
    const c = counter();
    await cache('d1', c.ask);
    await cache('d2', c.ask);
    expect(c.calls()).toBe(2);
  });

  it('does not keep a failure', async () => {
    const cache = createQueryCache({ now: () => 0 });
    await expect(cache('d1', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const c = counter();
    await cache('d1', c.ask);
    expect(c.calls()).toBe(1);
  });
});
