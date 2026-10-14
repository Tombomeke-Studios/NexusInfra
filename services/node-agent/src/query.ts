// Asking a game server how it is doing (#382) — the wire formats.
//
// A running container says nothing about whether anybody can join it: a
// Minecraft server still generating its world, or a Valheim server whose query
// port never came up, looks exactly like a healthy one from Docker's side. The
// games themselves answer a status question, each in its own protocol:
//
// - Minecraft Java: Server List Ping over TCP — a handshake, a status request,
//   and a JSON document back, every packet framed by a VarInt length.
// - Minecraft Bedrock: RakNet's unconnected ping over UDP, answered by a pong
//   carrying a `MCPE;…` status string.
// - Steam games: A2S_INFO over UDP. Since 2020 a server may answer the first
//   request with a challenge, which has to be sent back before it says anything.
//
// Pure: bytes in, bytes or facts out. The sockets are in queryRoutes.ts.

export const QUERY_PROTOCOLS = ['minecraft', 'bedrock', 'a2s'] as const;
export type QueryProtocol = (typeof QUERY_PROTOCOLS)[number];

export function isQueryProtocol(value: unknown): value is QueryProtocol {
  return typeof value === 'string' && (QUERY_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * What a server said about itself. A field it did not say is `null` — never a
 * made-up default. In particular a server that hides its player count has
 * `players: null`, which is not the same as nobody playing.
 */
export interface GameStatus {
  players: { online: number; max: number } | null;
  version: string | null;
  /** The description players see (Minecraft's MOTD). */
  motd: string | null;
  /** The server's own name, where the protocol has one apart from the MOTD (A2S). */
  name: string | null;
  /** The map or world loaded, where the protocol reports one. */
  map: string | null;
}

// ── VarInt (Minecraft) ────────────────────────────────────────────────────────

/** Minecraft's VarInt: a signed 32-bit integer, seven bits per byte, low group first. */
export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  // Unsigned shift so a negative number terminates after five bytes instead of
  // sign-extending forever.
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/**
 * Read a VarInt at `offset`. `null` means the buffer ends before the VarInt does
 * — wait for more bytes; a VarInt longer than five bytes is an error, because no
 * 32-bit value needs one.
 */
export function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    result |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value: result | 0, size: i + 1 };
  }
  throw new Error('VarInt too long');
}

function mcString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarInt(bytes.length), bytes]);
}

function mcPacket(id: number, body: Buffer): Buffer {
  const payload = Buffer.concat([encodeVarInt(id), body]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

/**
 * Everything a client sends to ask for the status: the handshake (protocol -1,
 * "whatever you speak", next state 1 = status) and the empty status request.
 */
export function minecraftStatusRequest(host: string, port: number): Buffer {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  const handshake = mcPacket(0x00, Buffer.concat([encodeVarInt(-1), mcString(host), portBytes, encodeVarInt(1)]));
  return Buffer.concat([handshake, mcPacket(0x00, Buffer.alloc(0))]);
}

/**
 * The JSON from a status response, once the whole frame has arrived; `null`
 * until then. TCP hands over whatever it has, and a status with a server icon
 * runs to several kilobytes, so the first chunk is rarely the whole answer.
 */
export function readMinecraftStatusFrame(buf: Buffer): string | null {
  const length = readVarInt(buf, 0);
  if (!length) return null;
  const end = length.size + length.value;
  if (buf.length < end) return null;

  let offset = length.size;
  const id = readVarInt(buf, offset);
  if (!id) throw new Error('truncated status response');
  if (id.value !== 0x00) throw new Error(`expected a status response, got packet ${id.value}`);
  offset += id.size;

  const strLen = readVarInt(buf, offset);
  if (!strLen) throw new Error('truncated status response');
  offset += strLen.size;
  if (offset + strLen.value > end) throw new Error('truncated status response');
  return buf.toString('utf8', offset, offset + strLen.value);
}

/**
 * The text of a chat component — a string, an array, or `{ text, extra }`
 * nested any depth — with the legacy `§` formatting codes removed.
 */
export function flattenChat(component: unknown): string {
  const walk = (c: unknown): string => {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (typeof c === 'number' || typeof c === 'boolean') return String(c);
    if (Array.isArray(c)) return c.map(walk).join('');
    if (typeof c === 'object') {
      const o = c as { text?: unknown; extra?: unknown };
      return walk(o.text) + walk(o.extra);
    }
    return '';
  };
  return walk(component).replace(/§./g, '');
}

const count = (n: unknown): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null);

/** The status JSON, reduced to what the panel shows. */
export function parseMinecraftStatus(json: string): GameStatus {
  const doc = JSON.parse(json) as {
    version?: { name?: unknown };
    players?: { online?: unknown; max?: unknown };
    description?: unknown;
  };
  const online = count(doc.players?.online);
  const max = count(doc.players?.max);
  const motd = flattenChat(doc.description).trim();
  return {
    players: online !== null && max !== null ? { online, max } : null,
    version: typeof doc.version?.name === 'string' ? flattenChat(doc.version.name) : null,
    motd: motd || null,
    name: null,
    map: null,
  };
}

// ── RakNet (Bedrock) ──────────────────────────────────────────────────────────

/** The sixteen bytes RakNet puts in every offline message. */
export const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

const UNCONNECTED_PING = 0x01;
const UNCONNECTED_PONG = 0x1c;

/** An unconnected ping: id, the client's clock, the magic, the client's GUID. */
export function bedrockPing(timeMs: bigint, clientGuid: bigint): Buffer {
  const buf = Buffer.alloc(33);
  buf[0] = UNCONNECTED_PING;
  buf.writeBigInt64BE(BigInt.asIntN(64, timeMs), 1);
  RAKNET_MAGIC.copy(buf, 9);
  buf.writeBigInt64BE(BigInt.asIntN(64, clientGuid), 25);
  return buf;
}

/**
 * An unconnected pong. Its string is `;`-separated:
 * `MCPE;<motd>;<protocol>;<version>;<online>;<max>;<server id>;<level name>;<game mode>;…`
 */
export function parseBedrockPong(buf: Buffer): GameStatus {
  if (buf.length < 1 || buf[0] !== UNCONNECTED_PONG) throw new Error('not a RakNet pong');
  // id (1) + time (8) + server GUID (8) + magic (16) + string length (2)
  if (buf.length < 35) throw new Error('truncated RakNet pong');
  if (!buf.subarray(17, 33).equals(RAKNET_MAGIC)) throw new Error('RakNet pong without the magic');
  const length = buf.readUInt16BE(33);
  if (buf.length < 35 + length) throw new Error('truncated RakNet pong');

  const fields = buf.toString('utf8', 35, 35 + length).split(';');
  const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
  const online = num(fields[4]);
  const max = num(fields[5]);
  return {
    players: online !== null && max !== null ? { online, max } : null,
    version: fields[3] || null,
    motd: fields[1] ? flattenChat(fields[1]) : null,
    name: null,
    map: fields[7] || null,
  };
}

// ── A2S_INFO (Steam) ──────────────────────────────────────────────────────────

const A2S_HEADER = Buffer.from('ffffffff', 'hex');
const A2S_SPLIT = Buffer.from('feffffff', 'hex');
const A2S_INFO = Buffer.concat([A2S_HEADER, Buffer.from([0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);
const S2C_CHALLENGE = 0x41;
const S2A_INFO = 0x49;
/** The Ship's app id: the one game whose info response has three extra bytes. */
const THE_SHIP = 2400;

/** The A2S_INFO request, with the challenge appended when the server handed one out. */
export function a2sInfoRequest(challenge?: Buffer): Buffer {
  return challenge ? Buffer.concat([A2S_INFO, challenge]) : Buffer.from(A2S_INFO);
}

export type A2sResponse = { kind: 'challenge'; challenge: Buffer } | { kind: 'info'; status: GameStatus };

/** A cursor over an A2S response that fails loudly instead of reading past the end. */
class Reader {
  constructor(
    private readonly buf: Buffer,
    private offset: number
  ) {}

  private need(n: number) {
    if (this.offset + n > this.buf.length) throw new Error('truncated A2S_INFO response');
  }

  byte(): number {
    this.need(1);
    return this.buf[this.offset++];
  }

  uint16le(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.offset);
    this.offset += 2;
    return v;
  }

  cstring(): string {
    const end = this.buf.indexOf(0, this.offset);
    if (end === -1) throw new Error('truncated A2S_INFO response');
    const s = this.buf.toString('utf8', this.offset, end);
    this.offset = end + 1;
    return s;
  }

  skip(n: number) {
    this.need(n);
    this.offset += n;
  }
}

/** A challenge to answer, or the server's info. */
export function parseA2sResponse(buf: Buffer): A2sResponse {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(A2S_SPLIT)) {
    // An info response fits one packet on every game we ship; a split one would
    // need reassembly, and half of one parsed as a whole would be wrong numbers.
    throw new Error('split A2S responses are not supported');
  }
  if (buf.length < 5 || !buf.subarray(0, 4).equals(A2S_HEADER)) throw new Error('not an A2S response');

  const type = buf[4];
  if (type === S2C_CHALLENGE) {
    if (buf.length < 9) throw new Error('truncated A2S challenge');
    return { kind: 'challenge', challenge: Buffer.from(buf.subarray(5, 9)) };
  }
  if (type !== S2A_INFO) throw new Error(`unexpected A2S response type 0x${type.toString(16)}`);

  const r = new Reader(buf, 5);
  r.byte(); // protocol version
  const name = r.cstring();
  const map = r.cstring();
  r.cstring(); // folder
  r.cstring(); // game
  const appId = r.uint16le();
  const online = r.byte();
  const max = r.byte();
  r.byte(); // bots — counted in `online` by the server already
  r.skip(4); // server type, environment, visibility, VAC
  if (appId === THE_SHIP) r.skip(3);
  const version = r.cstring();

  return {
    kind: 'info',
    status: { name: name || null, map: map || null, players: { online, max }, version: version || null, motd: null },
  };
}
