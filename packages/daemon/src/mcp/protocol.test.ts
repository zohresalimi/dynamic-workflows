/**
 * KAR-05.6 — the DeFlowd ⇄ `DeFlow-mcp` bridge frames.
 *
 * The shim is thin because the bridge is small: a hello that presents a token,
 * a tool call, a result, and a pushed tool list. Parsing is strict in both
 * directions — a frame nobody understands is a refusal, never a guess — for
 * the same reason the ACP transport refuses an oversized line: the process on
 * the other end of this socket is spawned by an agent.
 *
 * Verifies: EPIC-05-S23 · AC3, AC5, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  BRIDGE_VERSION,
  BridgeProtocolError,
  encodeFrame,
  type HostFrame,
  lineReader,
  parseHostFrame,
  parseShimFrame,
  type ShimFrame,
} from './protocol.ts';

const hello: ShimFrame = { t: 'hello', v: BRIDGE_VERSION, run: 'run_1', token: 'tok' };

suite('frames round-trip', () => {
  it('encodes one newline-terminated JSON object', () => {
    const line = encodeFrame(hello);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(parseShimFrame(line.trim())).toEqual(hello);
  });

  it('round-trips every host frame', () => {
    const frames: HostFrame[] = [
      { t: 'welcome', v: BRIDGE_VERSION, tools: ['DeFlow.readFact'] },
      { t: 'tools', tools: [] },
      { t: 'result', id: 3, value: { key: 'finding/x' } },
      { t: 'error', id: 3, message: 'no such fact' },
      { t: 'refused', reason: 'unknown run token' },
    ];
    for (const frame of frames) expect(parseHostFrame(encodeFrame(frame).trim())).toEqual(frame);
  });

  it('round-trips a tool call and a denial', () => {
    const call: ShimFrame = { t: 'call', id: 1, tool: 'DeFlow.readFact', args: { key: 'k' } };
    expect(parseShimFrame(encodeFrame(call).trim())).toEqual(call);
    const denied: ShimFrame = { t: 'denied', tool: 'DeFlow.proposePlanPatch' };
    expect(parseShimFrame(encodeFrame(denied).trim())).toEqual(denied);
  });
});

suite('a frame nobody understands is refused, never guessed at', () => {
  it('refuses a line that is not JSON', () => {
    expect(() => parseShimFrame('not json')).toThrow(BridgeProtocolError);
  });

  it('refuses an unknown frame type', () => {
    expect(() => parseShimFrame('{"t":"exec","cmd":"rm -rf /"}')).toThrow(BridgeProtocolError);
  });

  it('refuses a hello from a different bridge version', () => {
    expect(() => parseShimFrame(JSON.stringify({ ...hello, v: BRIDGE_VERSION + 1 }))).toThrow(
      BridgeProtocolError,
    );
  });

  it('refuses a call whose id is not a number', () => {
    expect(() => parseShimFrame('{"t":"call","id":"1","tool":"x","args":{}}')).toThrow(
      BridgeProtocolError,
    );
  });
});

suite('the line reader', () => {
  it('splits on newlines across chunk boundaries', () => {
    const read = lineReader();
    expect(read('{"a":1}\n{"b')).toEqual(['{"a":1}']);
    expect(read('":2}\n')).toEqual(['{"b":2}']);
  });

  it('holds an unterminated tail until its newline arrives', () => {
    const read = lineReader();
    expect(read('partial')).toEqual([]);
    expect(read(' line\n')).toEqual(['partial line']);
  });

  it('refuses a line that exceeds the cap rather than buffering it', () => {
    const read = lineReader(16);
    expect(() => read('x'.repeat(17))).toThrow(BridgeProtocolError);
  });

  it('ignores blank lines', () => {
    const read = lineReader();
    expect(read('\n\n{"a":1}\n')).toEqual(['{"a":1}']);
  });
});
