import { describe, it, expect } from 'vitest';
import { DEFAULT_PROTOCOL, parseContainerPort, publishPorts } from './ports.js';

// Publishing ports (#313). Every mapping used to be hardcoded to TCP, which for a
// UDP game published nothing at all — the container ran, the panel showed it
// green, and nobody could join.

describe('parseContainerPort', () => {
  it('defaults to TCP, exactly as before', () => {
    // Existing deployments carry a bare number and must keep working untouched.
    expect(parseContainerPort('25565')).toEqual({ port: '25565', protocols: ['tcp'] });
    expect(DEFAULT_PROTOCOL).toBe('tcp');
  });

  it('reads a protocol in Docker’s own notation', () => {
    expect(parseContainerPort('2456/udp')).toEqual({ port: '2456', protocols: ['udp'] });
    expect(parseContainerPort('28016/tcp')).toEqual({ port: '28016', protocols: ['tcp'] });
  });

  it('reads both protocols for a port that needs them', () => {
    // Source servers use the same number for gameplay (UDP) and RCON (TCP), and
    // two entries would collide on the host-port key the mapping is stored under.
    expect(parseContainerPort('27015/tcp+udp')).toEqual({ port: '27015', protocols: ['tcp', 'udp'] });
    expect(parseContainerPort('7777/udp+tcp')?.protocols).toEqual(['udp', 'tcp']);
  });

  it('tolerates case and whitespace', () => {
    expect(parseContainerPort(' 2456/UDP ')).toEqual({ port: '2456', protocols: ['udp'] });
  });

  it('does not publish the same protocol twice', () => {
    expect(parseContainerPort('2456/udp+udp')?.protocols).toEqual(['udp']);
  });

  it('falls back to TCP on a suffix it cannot read, rather than dropping the port', () => {
    // Publishing the wrong protocol is recoverable; publishing nothing is a
    // server nobody can reach for a reason nothing reports.
    expect(parseContainerPort('2456/sctp')).toEqual({ port: '2456', protocols: ['tcp'] });
    expect(parseContainerPort('2456/')).toEqual({ port: '2456', protocols: ['tcp'] });
  });

  it('refuses something that is not a port', () => {
    for (const bad of ['', 'http', '-1', '25565a', '../etc']) {
      expect(parseContainerPort(bad)).toBeNull();
    }
  });
});

describe('publishPorts', () => {
  it('publishes a TCP port the way it always did', () => {
    expect(publishPorts({ '25565': '25565' })).toEqual({
      exposedPorts: { '25565/tcp': {} },
      portBindings: { '25565/tcp': [{ HostPort: '25565' }] },
    });
  });

  it('publishes a UDP game on UDP', () => {
    // Valheim: neither this nor Rust needs TCP for gameplay, so mapping them as
    // TCP left them unreachable.
    expect(publishPorts({ '2456': '2456/udp' })).toEqual({
      exposedPorts: { '2456/udp': {} },
      portBindings: { '2456/udp': [{ HostPort: '2456' }] },
    });
  });

  it('publishes one number on both protocols when asked', () => {
    const published = publishPorts({ '27015': '27015/tcp+udp' });
    expect(Object.keys(published.exposedPorts).sort()).toEqual(['27015/tcp', '27015/udp']);
    expect(published.portBindings['27015/tcp']).toEqual([{ HostPort: '27015' }]);
    expect(published.portBindings['27015/udp']).toEqual([{ HostPort: '27015' }]);
  });

  it('maps a host port that differs from the container port', () => {
    expect(publishPorts({ '30000': '2456/udp' }).portBindings).toEqual({ '2456/udp': [{ HostPort: '30000' }] });
  });

  it('keeps several mappings apart', () => {
    // Rust: the game on UDP, RCON on TCP.
    const published = publishPorts({ '28015': '28015/udp', '28016': '28016/tcp' });
    expect(Object.keys(published.portBindings).sort()).toEqual(['28015/udp', '28016/tcp']);
  });

  it('skips a mapping it cannot read instead of guessing', () => {
    const published = publishPorts({ '25565': '25565', nonsense: '80', '8080': 'http' });
    expect(published.portBindings).toEqual({ '25565/tcp': [{ HostPort: '25565' }] });
  });

  it('publishes nothing when there is nothing to publish', () => {
    expect(publishPorts(undefined)).toEqual({ exposedPorts: {}, portBindings: {} });
    expect(publishPorts({})).toEqual({ exposedPorts: {}, portBindings: {} });
  });
});
