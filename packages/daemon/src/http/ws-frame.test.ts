/**
 * KAR-15.8 — RFC 6455 framing, which this daemon owns rather than imports.
 *
 * Owned because the only WebSocket in the product is one terminal panel's
 * keystrokes (docs/11-api-and-realtime.md §1), the upgrade is already taken by
 * hand off `server.on('upgrade', …)` so that auth runs *before* a socket
 * exists (KAR-15.2 AC11), and what is left after the handshake is a length
 * prefix and a four-byte XOR. A dependency here would buy nothing the upgrade
 * guard has not already paid for, and would add a second thing with an opinion
 * about when a socket may be accepted.
 *
 * Every case below is one the wire actually produces: the three length
 * encodings (a browser sends `Buffer.byteLength(text)` and does not care that
 * 125 and 126 take different headers), the mandatory client mask, fragmented
 * data frames, a control frame interleaved between two fragments, and a byte
 * stream that arrives split anywhere — a pty writing 40 KB does not arrive as
 * one `data` event, and a decoder that assumed it would would work all day on
 * a laptop and drop output under load.
 *
 * Verifies: EPIC-15-S48 · KAR-15.8 AC3
 */
import { Buffer } from 'node:buffer';
import { expect, it, describe as suite } from 'vitest';
import { acceptKey, createFrameDecoder, encodeFrame, OPCODE, WsProtocolError } from './ws-frame.ts';

/** The one worked example RFC 6455 §1.3 spells out end to end. */
const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

const decodeAll = (bytes: Buffer): { opcode: number; payload: Buffer }[] => {
  const decoder = createFrameDecoder({ requireMask: false });
  return decoder.push(bytes);
};

suite('acceptKey (AC1 — the handshake)', () => {
  it('answers the RFC 6455 §1.3 sample key with the RFC 6455 §1.3 sample accept', () => {
    expect(acceptKey(RFC_KEY)).toBe(RFC_ACCEPT);
  });

  it('is a function of the key, so a replayed accept does not match a fresh key', () => {
    expect(acceptKey('AAAAAAAAAAAAAAAAAAAAAA==')).not.toBe(RFC_ACCEPT);
  });
});

suite('encodeFrame (AC3 — server → client)', () => {
  it('never masks: a masked server frame is a protocol violation, not a nicety', () => {
    const frame = encodeFrame(OPCODE.binary, Buffer.from([1, 2, 3]));

    expect(frame[0]).toBe(0x82); // FIN | binary
    expect((frame[1] as number) & 0x80).toBe(0); // MASK clear
    expect(frame.subarray(2)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('uses the 7-bit length for 125 bytes and the 16-bit one for 126', () => {
    const short = encodeFrame(OPCODE.binary, Buffer.alloc(125));
    const extended = encodeFrame(OPCODE.binary, Buffer.alloc(126));

    expect(short[1]).toBe(125);
    expect(short.byteLength).toBe(2 + 125);
    expect(extended[1]).toBe(126);
    expect(extended.readUInt16BE(2)).toBe(126);
    expect(extended.byteLength).toBe(4 + 126);
  });

  it('uses the 64-bit length past 65535, which a build log reaches in one write', () => {
    const big = encodeFrame(OPCODE.binary, Buffer.alloc(65_536));

    expect(big[1]).toBe(127);
    expect(Number(big.readBigUInt64BE(2))).toBe(65_536);
    expect(big.byteLength).toBe(10 + 65_536);
  });

  it('round-trips a text frame through the decoder', () => {
    const frames = decodeAll(encodeFrame(OPCODE.text, Buffer.from('{"t":"exit","code":0}')));

    expect(frames).toEqual([
      { opcode: OPCODE.text, payload: Buffer.from('{"t":"exit","code":0}') },
    ]);
  });
});

suite('createFrameDecoder (AC3 — client → server)', () => {
  it('unmasks a client frame, because every client frame is masked', () => {
    const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
    const frame = encodeFrame(OPCODE.binary, Buffer.from('ls -la\r'), { mask });

    expect(decodeAll(frame)).toEqual([{ opcode: OPCODE.binary, payload: Buffer.from('ls -la\r') }]);
  });

  it('refuses an unmasked client frame when the mask is required', () => {
    const decoder = createFrameDecoder({ requireMask: true });

    expect(() => decoder.push(encodeFrame(OPCODE.binary, Buffer.from('x')))).toThrow(
      WsProtocolError,
    );
  });

  it('reassembles a fragmented message into one payload', () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    const first = encodeFrame(OPCODE.binary, Buffer.from('abc'), { mask, fin: false });
    const rest = encodeFrame(OPCODE.continuation, Buffer.from('def'), { mask });

    expect(decodeAll(Buffer.concat([first, rest]))).toEqual([
      { opcode: OPCODE.binary, payload: Buffer.from('abcdef') },
    ]);
  });

  it('lets a control frame through between two fragments without joining them', () => {
    const mask = Buffer.from([9, 9, 9, 9]);
    const first = encodeFrame(OPCODE.binary, Buffer.from('ab'), { mask, fin: false });
    const ping = encodeFrame(OPCODE.ping, Buffer.from('hb'), { mask });
    const rest = encodeFrame(OPCODE.continuation, Buffer.from('cd'), { mask });

    expect(decodeAll(Buffer.concat([first, ping, rest]))).toEqual([
      { opcode: OPCODE.ping, payload: Buffer.from('hb') },
      { opcode: OPCODE.binary, payload: Buffer.from('abcd') },
    ]);
  });

  it('survives a stream split at every single byte boundary', () => {
    // A pty's output arrives in whatever sizes the kernel felt like. Splitting
    // the *whole* encoding one byte at a time is the cheap way to prove the
    // decoder never assumes a frame arrives whole — including inside the
    // length field and inside the mask key.
    const bytes = Buffer.concat([
      encodeFrame(OPCODE.binary, Buffer.alloc(300, 7), { mask: Buffer.from([4, 3, 2, 1]) }),
      encodeFrame(OPCODE.text, Buffer.from('{"t":"resize","cols":120,"rows":40}'), {
        mask: Buffer.from([8, 7, 6, 5]),
      }),
    ]);

    const decoder = createFrameDecoder({ requireMask: true });
    const seen: { opcode: number; payload: Buffer }[] = [];
    for (const byte of bytes) seen.push(...decoder.push(Buffer.from([byte])));

    expect(seen).toEqual([
      { opcode: OPCODE.binary, payload: Buffer.alloc(300, 7) },
      { opcode: OPCODE.text, payload: Buffer.from('{"t":"resize","cols":120,"rows":40}') },
    ]);
  });

  it('refuses a payload past the bound rather than buffering it', () => {
    // The daemon is on loopback, which is not a reason to let one client frame
    // decide how much memory DeFlowd holds. Keystrokes are bytes; a 4 GB length
    // header is a bug or an attack, and either way it is refused at the header.
    const decoder = createFrameDecoder({ requireMask: false, maxPayloadBytes: 16 });

    expect(() => decoder.push(encodeFrame(OPCODE.binary, Buffer.alloc(17)))).toThrow(
      WsProtocolError,
    );
  });

  it('refuses a reserved opcode instead of guessing what it meant', () => {
    const decoder = createFrameDecoder({ requireMask: false });

    expect(() => decoder.push(Buffer.from([0x83, 0x00]))).toThrow(WsProtocolError);
  });
});
