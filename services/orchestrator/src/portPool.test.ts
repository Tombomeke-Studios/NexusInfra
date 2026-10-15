import { describe, it, expect } from 'vitest';
import { parsePortRange, planPorts, type TakenPorts } from './portPool.js';

const taken: TakenPorts = new Map([
  [25565, { deploymentId: 'd-mc', name: 'survival' }],
  [30001, { deploymentId: 'd-x', name: 'other' }],
]);

describe('planPorts (#233)', () => {
  it('keeps free explicit ports as they are', () => {
    expect(planPorts({ ports: { '8080': '80' }, range: null, taken })).toEqual({ ok: true, ports: { '8080': '80' }, hostPorts: [8080] });
  });

  it('refuses a port another server on the node already has, naming it', () => {
    const r = planPorts({ ports: { '25565': '25565' }, range: null, taken });
    expect(r).toEqual({ ok: false, status: 409, error: 'port 25565 is already used by survival on this node' });
  });

  it("does not count the server's own ports against it", () => {
    const own: TakenPorts = new Map([[25565, { deploymentId: 'me', name: 'me' }]]);
    expect(planPorts({ ports: { '25565': '25565' }, range: null, taken: own, self: 'me' }).ok).toBe(true);
  });

  it('assigns "auto" from the pool, lowest free first, and never twice in one request', () => {
    const r = planPorts({ ports: { auto: '25565', AUTO: '27015/udp' }, range: { start: 30000, end: 30010 }, taken });
    expect(r).toEqual({ ok: true, ports: { '30000': '25565', '30002': '27015/udp' }, hostPorts: [30000, 30002] });
  });

  it('refuses "auto" on a node with no pool — there is nothing to choose from', () => {
    expect(planPorts({ ports: { auto: '80' }, range: null, taken }).ok).toBe(false);
  });

  it('says so when the pool is full', () => {
    const r = planPorts({ ports: { auto: '80' }, range: { start: 30001, end: 30001 }, taken });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no free port.*30001–30001/) });
  });

  it('holds explicit ports to the pool when the node has one', () => {
    expect(planPorts({ ports: { '8080': '80' }, range: { start: 30000, end: 30100 }, taken })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/8080 is outside this node's port range 30000–30100/),
    });
  });

  it('refuses something that is not a port', () => {
    for (const bad of ['0', '70000', 'http', '12.5']) expect(planPorts({ ports: { [bad]: '80' }, range: null, taken }).ok).toBe(false);
  });
});

describe('parsePortRange', () => {
  it('accepts a range, and null to remove it', () => {
    expect(parsePortRange({ start: 30000, end: 30100 })).toEqual({ ok: true, range: { start: 30000, end: 30100 } });
    expect(parsePortRange(null)).toEqual({ ok: true, range: null });
  });

  it('refuses a backwards, out-of-bounds or fractional range', () => {
    for (const bad of [{ start: 5, end: 1 }, { start: 0, end: 10 }, { start: 1, end: 70000 }, { start: 1.5, end: 3 }, { start: 1 }, 'x']) {
      expect(parsePortRange(bad).ok).toBe(false);
    }
  });
});
