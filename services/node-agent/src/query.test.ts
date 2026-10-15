import { describe, it, expect } from 'vitest';
import {
  encodeVarInt,
  readVarInt,
  minecraftStatusRequest,
  readMinecraftStatusFrame,
  parseMinecraftStatus,
  flattenChat,
  bedrockPing,
  parseBedrockPong,
  RAKNET_MAGIC,
  a2sInfoRequest,
  parseA2sResponse,
  isQueryProtocol,
} from './query.js';

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'hex');

/** A NUL-terminated string, as A2S writes them. */
const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

describe('VarInt', () => {
  // The worked examples from the protocol documentation (wiki.vg).
  const cases: Array<[number, string]> = [
    [0, '00'],
    [1, '01'],
    [127, '7f'],
    [128, '8001'],
    [255, 'ff01'],
    [25565, 'ddc701'],
    [2097151, 'ffff7f'],
    [2147483647, 'ffffffff07'],
    [-1, 'ffffffff0f'],
    [-2147483648, '8080808008'],
  ];

  it.each(cases)('encodes %i as %s', (value, bytes) => {
    expect(encodeVarInt(value).toString('hex')).toBe(bytes);
  });

  it.each(cases)('decodes %s back to %i', (value, bytes) => {
    expect(readVarInt(hex(bytes), 0)).toEqual({ value, size: bytes.length / 2 });
  });

  it('reads from an offset', () => {
    expect(readVarInt(hex('aa bb ddc701'), 2)).toEqual({ value: 25565, size: 3 });
  });

  it('says "not yet" for a VarInt cut off mid-way, rather than misreading it', () => {
    expect(readVarInt(hex('80'), 0)).toBeNull();
    expect(readVarInt(hex('ffff'), 0)).toBeNull();
  });

  it('refuses a VarInt longer than five bytes', () => {
    expect(() => readVarInt(hex('ffffffffff01'), 0)).toThrow(/too long/);
  });
});

describe('Minecraft Server List Ping', () => {
  it('sends a handshake for status followed by an empty status request', () => {
    const bytes = minecraftStatusRequest('localhost', 25565);
    // handshake: length 0x13, id 0x00, protocol -1, "localhost", 25565, next state 1
    // then the status request: length 1, id 0x00
    expect(bytes.toString('hex')).toBe(
      '13' + '00' + 'ffffffff0f' + '09' + Buffer.from('localhost').toString('hex') + '63dd' + '01' + '0100'
    );
  });

  it('frames the length of the handshake correctly for a long host name', () => {
    const host = 'a'.repeat(200);
    const bytes = minecraftStatusRequest(host, 1);
    const length = readVarInt(bytes, 0)!;
    // The first frame's declared length covers exactly the rest of the handshake.
    expect(length.size + length.value + 2).toBe(bytes.length);
  });

  function frame(json: string): Buffer {
    const body = Buffer.concat([Buffer.from([0x00]), encodeVarInt(Buffer.byteLength(json)), Buffer.from(json, 'utf8')]);
    return Buffer.concat([encodeVarInt(body.length), body]);
  }

  it('reads the JSON out of a complete status frame', () => {
    expect(readMinecraftStatusFrame(frame('{"a":1}'))).toBe('{"a":1}');
  });

  it('waits for the rest of a frame that arrived in pieces', () => {
    const whole = frame(JSON.stringify({ description: 'x'.repeat(300) }));
    expect(readMinecraftStatusFrame(whole.subarray(0, 1))).toBeNull();
    expect(readMinecraftStatusFrame(whole.subarray(0, 50))).toBeNull();
    expect(readMinecraftStatusFrame(whole)).toContain('xxx');
  });

  it('keeps multi-byte characters intact — the length is in bytes, not characters', () => {
    expect(readMinecraftStatusFrame(frame('{"d":"héllo ✓"}'))).toBe('{"d":"héllo ✓"}');
  });

  it('refuses a frame that is not a status response', () => {
    const body = Buffer.concat([Buffer.from([0x01]), encodeVarInt(2), Buffer.from('{}')]);
    expect(() => readMinecraftStatusFrame(Buffer.concat([encodeVarInt(body.length), body]))).toThrow(/packet 1/);
  });

  it('turns the status JSON into players, version and MOTD', () => {
    const status = parseMinecraftStatus(
      JSON.stringify({
        version: { name: 'Paper 1.21.1', protocol: 767 },
        players: { max: 20, online: 2, sample: [{ name: 'alex', id: '…' }] },
        description: { text: '§aA NexusInfra §lserver', extra: [{ text: ' — welcome' }] },
      })
    );
    expect(status).toEqual({
      players: { online: 2, max: 20 },
      version: 'Paper 1.21.1',
      motd: 'A NexusInfra server — welcome',
      name: null,
      map: null,
    });
  });

  it('reports the players as unknown, not zero, when the server hides them', () => {
    // A server may answer with no "players" object at all (hidden player count).
    const status = parseMinecraftStatus(JSON.stringify({ version: { name: '1.21' }, description: 'hi' }));
    expect(status.players).toBeNull();
  });

  it('refuses a body that is not JSON', () => {
    expect(() => parseMinecraftStatus('not json')).toThrow();
  });
});

describe('flattenChat', () => {
  it('handles a plain string, nested extras and translate-less components', () => {
    expect(flattenChat('plain')).toBe('plain');
    expect(flattenChat({ text: 'a', extra: [{ text: 'b', extra: ['c'] }] })).toBe('abc');
    expect(flattenChat([{ text: 'x' }, 'y'])).toBe('xy');
    expect(flattenChat(null)).toBe('');
  });

  it('strips legacy § formatting codes', () => {
    expect(flattenChat('§6Gold §r§knope§r')).toBe('Gold nope');
  });
});

describe('Bedrock RakNet unconnected ping', () => {
  it('encodes id, time, magic and client GUID in 33 bytes', () => {
    const ping = bedrockPing(0x0102030405060708n, 0x1122334455667788n);
    expect(ping.length).toBe(33);
    expect(ping.toString('hex')).toBe('01' + '0102030405060708' + RAKNET_MAGIC.toString('hex') + '1122334455667788');
  });

  function pong(text: string): Buffer {
    const s = Buffer.from(text, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(s.length);
    return Buffer.concat([hex('1c'), hex('0000000000000001'), hex('00000000000000aa'), RAKNET_MAGIC, len, s]);
  }

  it('reads the MCPE status string', () => {
    const status = parseBedrockPong(
      pong('MCPE;A NexusInfra server;712;1.21.20;3;10;13253860892328930865;Bedrock level;Survival;1;19132;19133;')
    );
    expect(status).toEqual({
      players: { online: 3, max: 10 },
      version: '1.21.20',
      motd: 'A NexusInfra server',
      name: null,
      map: 'Bedrock level',
    });
  });

  it('refuses a packet that is not an unconnected pong', () => {
    expect(() => parseBedrockPong(hex('01 00'))).toThrow(/not a RakNet pong/);
  });

  it('refuses a pong without the RakNet magic', () => {
    const bad = pong('MCPE;x;1;1;0;1;');
    bad[17] ^= 0xff;
    expect(() => parseBedrockPong(bad)).toThrow(/magic/);
  });

  it('refuses a truncated pong', () => {
    expect(() => parseBedrockPong(pong('MCPE;x;1;1;0;1;').subarray(0, 40))).toThrow(/truncated/);
  });

  it('keeps the players unknown when the counts are not numbers', () => {
    expect(parseBedrockPong(pong('MCPE;x;1;1.0;?;?;')).players).toBeNull();
  });
});

describe('Steam A2S_INFO', () => {
  const PAYLOAD = 'ffffffff54' + Buffer.from('Source Engine Query').toString('hex') + '00';

  it('asks with the fixed "Source Engine Query" payload', () => {
    expect(a2sInfoRequest().toString('hex')).toBe(PAYLOAD);
  });

  it('appends the challenge when one was handed out (the 2020 change)', () => {
    expect(a2sInfoRequest(hex('0a0b0c0d')).toString('hex')).toBe(PAYLOAD + '0a0b0c0d');
  });

  it('recognises a challenge response', () => {
    expect(parseA2sResponse(hex('ffffffff41 0a0b0c0d'))).toEqual({ kind: 'challenge', challenge: hex('0a0b0c0d') });
  });

  function info(opts: { appId?: number; players?: number; max?: number; bots?: number; ship?: boolean } = {}): Buffer {
    const appId = Buffer.alloc(2);
    appId.writeUInt16LE(opts.appId ?? 730);
    return Buffer.concat([
      hex('ffffffff49'),
      Buffer.from([17]), // protocol
      cstr('A NexusInfra server'),
      cstr('de_dust2'),
      cstr('csgo'),
      cstr('Counter-Strike 2'),
      appId,
      Buffer.from([opts.players ?? 4, opts.max ?? 10, opts.bots ?? 1, 0x64, 0x6c, 0, 1]),
      ...(opts.ship ? [Buffer.from([0, 0, 0])] : []),
      cstr('1.40.2.4'),
    ]);
  }

  it('reads name, map, players and version from an info response', () => {
    expect(parseA2sResponse(info())).toEqual({
      kind: 'info',
      status: {
        name: 'A NexusInfra server',
        map: 'de_dust2',
        players: { online: 4, max: 10 },
        version: '1.40.2.4',
        motd: null,
      },
    });
  });

  it('skips The Ship’s extra fields before the version', () => {
    const parsed = parseA2sResponse(info({ appId: 2400, ship: true }));
    expect(parsed.kind === 'info' && parsed.status.version).toBe('1.40.2.4');
  });

  it('refuses a split (multi-packet) response rather than misreading half of one', () => {
    expect(() => parseA2sResponse(hex('feffffff 00000000'))).toThrow(/split/);
  });

  it('refuses an unknown response type', () => {
    expect(() => parseA2sResponse(hex('ffffffff6d00'))).toThrow(/0x6d/);
  });

  it('refuses a truncated info response', () => {
    expect(() => parseA2sResponse(info().subarray(0, 30))).toThrow(/truncated/);
  });
});

describe('isQueryProtocol', () => {
  it('accepts exactly the three protocols', () => {
    expect(['minecraft', 'bedrock', 'a2s'].every(isQueryProtocol)).toBe(true);
    expect(isQueryProtocol('gamespy')).toBe(false);
    expect(isQueryProtocol(undefined)).toBe(false);
  });
});
