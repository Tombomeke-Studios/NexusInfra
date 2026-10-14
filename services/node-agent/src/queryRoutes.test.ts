import { describe, it, expect, afterEach } from 'vitest';
import net, { type AddressInfo } from 'net';
import dgram from 'dgram';
import express from 'express';
import request from 'supertest';
import { createQueryRouter, queryA2s, queryBedrock, queryMinecraft, resolveQueryHost, type Probe } from './queryRoutes.js';
import { encodeVarInt, RAKNET_MAGIC } from './query.js';

// Real sockets on loopback, so the framing, the challenge round and the
// timeouts are exercised the way a game server would exercise them.

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function statusFrame(json: string): Buffer {
  const body = Buffer.concat([Buffer.from([0x00]), encodeVarInt(Buffer.byteLength(json)), Buffer.from(json, 'utf8')]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

async function tcpServer(onData: (socket: net.Socket, data: Buffer) => void): Promise<number> {
  const server = net.createServer((socket) => socket.on('data', (d) => onData(socket, d)));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return (server.address() as AddressInfo).port;
}

async function udpServer(onMessage: (msg: Buffer, reply: (b: Buffer) => void) => void): Promise<number> {
  const socket = dgram.createSocket('udp4');
  socket.on('message', (msg, rinfo) => onMessage(msg, (b) => socket.send(b, rinfo.port, rinfo.address)));
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  closers.push(() => socket.close());
  return socket.address().port;
}

describe('queryMinecraft', () => {
  it('reads a status that arrives in two pieces', async () => {
    const json = JSON.stringify({ version: { name: '1.21.1' }, players: { online: 2, max: 20 }, description: 'hello' });
    const port = await tcpServer((socket) => {
      const frame = statusFrame(json);
      socket.write(frame.subarray(0, 5));
      setTimeout(() => socket.write(frame.subarray(5)), 20);
    });
    const result = await queryMinecraft('127.0.0.1', port, 1000);
    expect(result.status).toMatchObject({ players: { online: 2, max: 20 }, version: '1.21.1', motd: 'hello' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('gives up at the deadline when the server accepts but never answers', async () => {
    const port = await tcpServer(() => {});
    await expect(queryMinecraft('127.0.0.1', port, 150)).rejects.toThrow(/no answer within 150 ms/);
  });

  it('fails when nothing listens on the port', async () => {
    const port = await tcpServer(() => {});
    closers.pop()!(); // close it again: the port is now free
    await expect(queryMinecraft('127.0.0.1', port, 500)).rejects.toThrow();
  });
});

describe('queryBedrock', () => {
  it('answers a ping with the server’s status', async () => {
    const port = await udpServer((msg, reply) => {
      expect(msg[0]).toBe(0x01);
      const text = Buffer.from('MCPE;Bedrock box;712;1.21.20;1;10;1;World;Survival;1;19132;19133;');
      const len = Buffer.alloc(2);
      len.writeUInt16BE(text.length);
      reply(Buffer.concat([Buffer.from([0x1c]), msg.subarray(1, 9), Buffer.alloc(8), RAKNET_MAGIC, len, text]));
    });
    const result = await queryBedrock('127.0.0.1', port, 1000);
    expect(result.status).toMatchObject({ players: { online: 1, max: 10 }, motd: 'Bedrock box', version: '1.21.20' });
  });

  it('reports a silent server as a timeout', async () => {
    const port = await udpServer(() => {});
    await expect(queryBedrock('127.0.0.1', port, 150)).rejects.toThrow(/no answer/);
  });
});

describe('queryA2s', () => {
  const info = Buffer.concat([
    Buffer.from('ffffffff49', 'hex'),
    Buffer.from([17]),
    Buffer.from('Valheim box\0map\0valheim\0Valheim\0', 'utf8'),
    Buffer.from([0xc4, 0x9a]), // app id, little-endian
    Buffer.from([3, 10, 0, 0x64, 0x6c, 0, 0]),
    Buffer.from('0.219.16\0', 'utf8'),
  ]);

  it('answers the challenge and then reads the info', async () => {
    const asked: string[] = [];
    const port = await udpServer((msg, reply) => {
      asked.push(msg.subarray(-4).toString('hex'));
      // Only a request carrying the challenge gets an answer, like a post-2020 server.
      if (msg.subarray(-4).equals(Buffer.from('c0ffee11', 'hex'))) reply(info);
      else reply(Buffer.from('ffffffff41c0ffee11', 'hex'));
    });
    const result = await queryA2s('127.0.0.1', port, 1000);
    expect(result.status).toMatchObject({ name: 'Valheim box', players: { online: 3, max: 10 }, version: '0.219.16' });
    expect(asked).toHaveLength(2);
  });

  it('answers at once when the server asks for no challenge', async () => {
    const port = await udpServer((_msg, reply) => reply(info));
    await expect(queryA2s('127.0.0.1', port, 1000)).resolves.toMatchObject({ status: { name: 'Valheim box' } });
  });

  it('stops answering a server that keeps handing out new challenges', async () => {
    let n = 0;
    const port = await udpServer((_msg, reply) => {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(++n);
      reply(Buffer.concat([Buffer.from('ffffffff41', 'hex'), c]));
    });
    await expect(queryA2s('127.0.0.1', port, 1000)).rejects.toThrow(/new challenge/);
  });
});

describe('resolveQueryHost', () => {
  it('uses QUERY_HOST when it is set', async () => {
    expect(await resolveQueryHost({ QUERY_HOST: '10.0.0.5' }, async () => ({}))).toBe('10.0.0.5');
  });

  it('prefers the host gateway name when it resolves — loopback in a container is the container', async () => {
    expect(await resolveQueryHost({}, async () => ({ address: '172.17.0.1' }))).toBe('host.docker.internal');
  });

  it('falls back to loopback for an agent run directly on the host', async () => {
    expect(
      await resolveQueryHost({}, async () => {
        throw new Error('ENOTFOUND');
      })
    ).toBe('127.0.0.1');
  });
});

describe('GET /query', () => {
  function app(probe: Probe) {
    const a = express();
    a.use(createQueryRouter({ host: async () => 'game-host', probes: { minecraft: probe, bedrock: probe, a2s: probe }, timeoutMs: 100 }));
    return a;
  }

  it('reports an answering server as online, with what it said', async () => {
    const asked: Array<[string, number, number]> = [];
    const probe: Probe = async (host, port, timeout) => {
      asked.push([host, port, timeout]);
      return { latencyMs: 12, status: { players: { online: 2, max: 20 }, version: '1.21', motd: 'hi', name: null, map: null } };
    };
    const res = await request(app(probe)).get('/query?protocol=minecraft&port=25565');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'online', protocol: 'minecraft', latencyMs: 12, players: { online: 2, max: 20 }, version: '1.21', motd: 'hi', name: null, map: null });
    expect(asked).toEqual([['game-host', 25565, 100]]);
  });

  it('reports a server that does not answer as offline — with no player count at all', async () => {
    const res = await request(app(async () => Promise.reject(new Error('no answer within 100 ms')))).get('/query?protocol=a2s&port=2457');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'offline', protocol: 'a2s', error: 'no answer within 100 ms' });
    expect(res.body.players).toBeUndefined();
  });

  it('refuses an unknown protocol or a port out of range', async () => {
    const probe: Probe = async () => {
      throw new Error('not called');
    };
    expect((await request(app(probe)).get('/query?protocol=gamespy&port=1')).status).toBe(400);
    expect((await request(app(probe)).get('/query?protocol=a2s&port=0')).status).toBe(400);
    expect((await request(app(probe)).get('/query?protocol=a2s&port=70000')).status).toBe(400);
    expect((await request(app(probe)).get('/query?protocol=a2s')).status).toBe(400);
  });
});
