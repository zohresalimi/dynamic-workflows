/**
 * KAR-15.8 AC1, AC3 — the two pure halves of the PTY socket: which URL is a
 * terminal, and what a text frame on it is allowed to say.
 *
 * Unit, because neither needs a socket and both are where the interesting
 * cases live. The routing half has to refuse a shape rather than guess at one
 * — `/api/pty/x` and `/api/pty/a/b/c` are not terminals, and a malformed
 * `RunId` is a 404 rather than a 500, the same rule `asRunId` follows for the
 * HTTP routes. The frame half is parsing attacker-reachable JSON: an upgrade
 * is authenticated, but the frames after it are still input, and `cols` is
 * about to be handed to an ioctl.
 *
 * Verifies: EPIC-15-S48 · KAR-15.8 AC1, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { exitFrameText, parseClientText, parsePtyPath } from './pty-protocol.ts';
import { WsProtocolError } from './ws-frame.ts';

const RUN = 'run_20260810T101500Z_ac1540';

suite('parsePtyPath (AC1)', () => {
  it('reads /api/pty/:runId/:nodeId', () => {
    expect(parsePtyPath(`/api/pty/${RUN}/n-impl`)).toEqual({ runId: RUN, nodeId: 'n-impl' });
  });

  it('refuses a path with too few or too many segments', () => {
    expect(parsePtyPath('/api/pty')).toBeNull();
    expect(parsePtyPath(`/api/pty/${RUN}`)).toBeNull();
    expect(parsePtyPath(`/api/pty/${RUN}/n-impl/extra`)).toBeNull();
  });

  it('refuses a path that is not the PTY route at all', () => {
    expect(parsePtyPath('/api/stream')).toBeNull();
    expect(parsePtyPath(`/api/runs/${RUN}/nodes/n-impl/io`)).toBeNull();
  });

  it('refuses a malformed RunId rather than passing it to a lookup', () => {
    expect(parsePtyPath('/api/pty/r1/n-impl')).toBeNull();
  });

  it('refuses a nodeId that is not one, including a traversal attempt', () => {
    expect(parsePtyPath(`/api/pty/${RUN}/..%2F..%2Fetc`)).toBeNull();
    expect(parsePtyPath(`/api/pty/${RUN}/`)).toBeNull();
  });
});

suite('parseClientText (AC3)', () => {
  it('reads the documented resize frame', () => {
    expect(parseClientText('{"t":"resize","cols":120,"rows":40}')).toEqual({
      t: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  it('refuses a frame that is not JSON', () => {
    expect(() => parseClientText('resize 120 40')).toThrow(WsProtocolError);
  });

  it('refuses an unknown frame type instead of ignoring it', () => {
    // Ignoring it is how a client ships against a frame the daemon silently
    // drops and nobody finds out until a user reports that nothing happens.
    expect(() => parseClientText('{"t":"kill"}')).toThrow(WsProtocolError);
  });

  it('refuses dimensions that are not positive integers', () => {
    expect(() => parseClientText('{"t":"resize","cols":0,"rows":40}')).toThrow(WsProtocolError);
    expect(() => parseClientText('{"t":"resize","cols":120.5,"rows":40}')).toThrow(WsProtocolError);
    expect(() => parseClientText('{"t":"resize","cols":"120","rows":40}')).toThrow(WsProtocolError);
    expect(() => parseClientText('{"t":"resize","cols":-1,"rows":40}')).toThrow(WsProtocolError);
  });

  it('refuses dimensions past the bound, which reach an ioctl', () => {
    expect(() => parseClientText('{"t":"resize","cols":100000,"rows":40}')).toThrow(
      WsProtocolError,
    );
  });
});

suite('exitFrameText (AC5)', () => {
  it('is the documented shape for a normal exit', () => {
    expect(exitFrameText({ code: 0, signal: null })).toBe('{"t":"exit","code":0}');
  });

  it('carries a non-zero code verbatim', () => {
    expect(exitFrameText({ code: 3, signal: null })).toBe('{"t":"exit","code":3}');
  });

  it('says which signal killed it, rather than inventing a code', () => {
    // A process killed by SIGKILL has no exit code, and reporting 0 or 137
    // would both be fiction. `code: null` plus the signal is the true answer.
    expect(exitFrameText({ code: null, signal: 9 })).toBe('{"t":"exit","code":null,"signal":9}');
  });
});
