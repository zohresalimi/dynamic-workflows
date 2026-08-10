/**
 * RFC 6455 framing — the whole of the WebSocket dependency this project takes
 * (KAR-15.8 AC3).
 *
 * There is exactly one socket in the product: a terminal panel's keystrokes
 * (docs/11-api-and-realtime.md §1, §7.7). The handshake is a SHA-1 of a
 * constant, and a data frame is a length prefix and a four-byte XOR. What a
 * library would add on top of that is a second opinion about *when a socket
 * may be accepted*, and that decision is already made one layer up: the
 * upgrade is taken by hand off `server.on('upgrade', …)` so the bearer token
 * is checked before any socket exists (KAR-15.2 AC11). AC1 asks for the socket
 * to be independent of any Hono WebSocket helper's version; this is that
 * independence spelled out rather than moved to a different package name.
 *
 * What is deliberately **not** here: permessage-deflate (a terminal's bytes
 * are already going over loopback), `Sec-WebSocket-Protocol` negotiation
 * (there is one protocol), and client-side masking of server frames (the RFC
 * forbids it). The decoder does implement fragmentation and interleaved
 * control frames, because browsers really do send both and a decoder that
 * skipped them would fail on a large paste rather than on anything a test
 * would think to try.
 */
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';

/** RFC 6455 §1.3's constant. It is not a secret and it is not configurable. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/** RFC 6455 §7.4.1's "normal closure". */
export const CLOSE_NORMAL = 1000;
/** §7.4.1's "going away" — what a daemon shutting down owes a client. */
export const CLOSE_GOING_AWAY = 1001;
/** §7.4.1's "protocol error", which every throw from the decoder becomes. */
export const CLOSE_PROTOCOL_ERROR = 1002;
/** §7.4.1's "message too big". */
export const CLOSE_TOO_BIG = 1009;

/**
 * One MiB. Keystrokes are bytes and a paste is kilobytes, so this is not a
 * throughput bound — it is the answer to a 64-bit length header arriving from
 * a page that is not the UI. Loopback is not a reason to let one frame decide
 * how much memory DeFlowd holds.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;

/** A frame the peer had no right to send. The socket is closed, not repaired. */
export class WsProtocolError extends Error {
  /** The RFC 6455 §7.4.1 code that goes out in the close frame. */
  readonly closeCode: number;

  constructor(message: string, closeCode: number = CLOSE_PROTOCOL_ERROR) {
    super(message);
    this.name = 'WsProtocolError';
    this.closeCode = closeCode;
  }
}

export interface WsMessage {
  /** Never `continuation`: fragments are joined before a message is handed back. */
  readonly opcode: Opcode;
  readonly payload: Buffer;
}

export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
}

/** The 16 random bytes a client's `Sec-WebSocket-Key` is, base64-encoded. */
export function newWebSocketKey(): string {
  return randomBytes(16).toString('base64');
}

export interface EncodeOptions {
  /**
   * The 4-byte masking key. Present for a **client** frame, absent for a
   * server one: RFC 6455 §5.1 requires the first and forbids the second, and
   * the asymmetry is why one codec can serve both sides of the connection —
   * the daemon encodes unmasked and decodes masked, a client does the reverse.
   * `true` mints a fresh key.
   */
  readonly mask?: Buffer | boolean;
  /** `false` marks a fragment: the message continues in the next frame. */
  readonly fin?: boolean;
}

export function encodeFrame(
  opcode: Opcode,
  payload: Buffer = Buffer.alloc(0),
  options: EncodeOptions = {},
): Buffer {
  const fin = options.fin ?? true;
  const mask =
    options.mask === undefined || options.mask === false
      ? null
      : options.mask === true
        ? randomBytes(4)
        : options.mask;

  const length = payload.byteLength;
  const lengthBytes = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + (mask === null ? 0 : 4));

  header[0] = (fin ? 0x80 : 0x00) | opcode;
  const maskBit = mask === null ? 0x00 : 0x80;
  if (lengthBytes === 0) header[1] = maskBit | length;
  else if (lengthBytes === 2) {
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  if (mask === null) return Buffer.concat([header, payload]);

  mask.copy(header, 2 + lengthBytes);
  return Buffer.concat([header, xorMask(Buffer.from(payload), mask)]);
}

/** In place, and its own function because it is the one hot loop in the file. */
function xorMask(bytes: Buffer, mask: Buffer): Buffer {
  for (let index = 0; index < bytes.byteLength; index += 1) {
    // biome-ignore lint/style/noNonNullAssertion: indexes are bounded by the loop
    bytes[index] = (bytes[index] as number) ^ (mask[index % 4] as number);
  }
  return bytes;
}

export interface DecoderOptions {
  /**
   * Server-side this is `true`: RFC 6455 §5.1 says a server MUST close the
   * connection on an unmasked client frame. Client-side it is `false`, for the
   * mirror-image reason.
   */
  readonly requireMask?: boolean;
  readonly maxPayloadBytes?: number;
}

export interface FrameDecoder {
  /**
   * Feeds bytes in and takes whole messages out. A socket hands over whatever
   * the kernel gave it, which is not frames — so this is the only shape that
   * can be correct.
   *
   * @throws {WsProtocolError} on a frame the peer had no right to send.
   */
  push(bytes: Buffer): WsMessage[];
}

const DATA_OPCODES = new Set<number>([OPCODE.continuation, OPCODE.text, OPCODE.binary]);
const CONTROL_OPCODES = new Set<number>([OPCODE.close, OPCODE.ping, OPCODE.pong]);

export function createFrameDecoder(options: DecoderOptions = {}): FrameDecoder {
  const requireMask = options.requireMask ?? true;
  const maxPayload = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  let pending = Buffer.alloc(0);
  // The message being assembled across fragments, or null between messages.
  let fragmentOpcode: Opcode | null = null;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;

  const takeOne = (): WsMessage | null => {
    if (pending.byteLength < 2) return null;

    const first = pending[0] as number;
    const second = pending[1] as number;
    const fin = (first & 0x80) !== 0;
    // RSV1-3 carry extensions, and this endpoint negotiates none. A set bit
    // means the peer believes something was agreed that was not.
    if ((first & 0x70) !== 0) throw new WsProtocolError('reserved bits are set on a frame');

    const opcode = first & 0x0f;
    if (!DATA_OPCODES.has(opcode) && !CONTROL_OPCODES.has(opcode)) {
      throw new WsProtocolError(`opcode 0x${opcode.toString(16)} is reserved`);
    }

    const masked = (second & 0x80) !== 0;
    if (requireMask && !masked) throw new WsProtocolError('a client frame must be masked');

    const short = second & 0x7f;
    let offset = 2;
    let length = short;
    if (short === 126) {
      if (pending.byteLength < offset + 2) return null;
      length = pending.readUInt16BE(offset);
      offset += 2;
    } else if (short === 127) {
      if (pending.byteLength < offset + 8) return null;
      const wide = pending.readBigUInt64BE(offset);
      // Refused at the header, before a byte of it is buffered: the whole
      // point of the bound is not to allocate what the peer asked for.
      if (wide > BigInt(maxPayload)) {
        throw new WsProtocolError(`frame of ${wide} bytes exceeds the bound`, CLOSE_TOO_BIG);
      }
      length = Number(wide);
      offset += 8;
    }

    if (CONTROL_OPCODES.has(opcode)) {
      // §5.5: a control frame is at most 125 bytes and is never fragmented.
      if (short > 125) throw new WsProtocolError('a control frame may not exceed 125 bytes');
      if (!fin) throw new WsProtocolError('a control frame may not be fragmented');
    }
    if (length > maxPayload) {
      throw new WsProtocolError(`frame of ${length} bytes exceeds the bound`, CLOSE_TOO_BIG);
    }

    const maskKey = masked ? pending.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (pending.byteLength < offset + length) return null;

    const payload = Buffer.from(pending.subarray(offset, offset + length));
    pending = pending.subarray(offset + length);
    if (maskKey !== null) xorMask(payload, maskKey);

    if (CONTROL_OPCODES.has(opcode)) return { opcode: opcode as Opcode, payload };

    if (opcode === OPCODE.continuation) {
      if (fragmentOpcode === null) {
        throw new WsProtocolError('a continuation frame arrived with nothing to continue');
      }
      fragments.push(payload);
      fragmentBytes += payload.byteLength;
      if (fragmentBytes > maxPayload) {
        throw new WsProtocolError(
          `a fragmented message reached ${fragmentBytes} bytes`,
          CLOSE_TOO_BIG,
        );
      }
      if (!fin) return null;
      const joined = Buffer.concat(fragments);
      const finished: WsMessage = { opcode: fragmentOpcode, payload: joined };
      fragmentOpcode = null;
      fragments = [];
      fragmentBytes = 0;
      return finished;
    }

    if (fragmentOpcode !== null) {
      throw new WsProtocolError('a new data frame arrived inside a fragmented message');
    }
    if (fin) return { opcode: opcode as Opcode, payload };

    fragmentOpcode = opcode as Opcode;
    fragments = [payload];
    fragmentBytes = payload.byteLength;
    return null;
  };

  return {
    push(bytes) {
      pending = pending.byteLength === 0 ? Buffer.from(bytes) : Buffer.concat([pending, bytes]);
      const messages: WsMessage[] = [];
      // `takeOne` returns null both for "need more bytes" and for "that frame
      // was a fragment", so the loop stops on a length that did not move.
      for (;;) {
        const before = pending.byteLength;
        const message = takeOne();
        if (message !== null) {
          messages.push(message);
          continue;
        }
        if (pending.byteLength === before) return messages;
      }
    },
  };
}

/** The close frame's payload: a big-endian code, then an optional reason. */
export function closePayload(code: number, reason = ''): Buffer {
  const bytes = Buffer.alloc(2 + Buffer.byteLength(reason));
  bytes.writeUInt16BE(code, 0);
  bytes.write(reason, 2);
  return bytes;
}
