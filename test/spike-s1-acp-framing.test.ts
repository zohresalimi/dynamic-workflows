/**
 * KAR-00.1 — the frame cap the ACP SDK does not have.
 *
 * `@agentclientprotocol/sdk@1.3.0`'s `LineBuffer` has no maximum line length:
 * `push()` retains an unterminated tail for ever, so an agent that never emits
 * `\n` grows it until the daemon dies. The architecture's answer is an 8 MiB
 * cap upstream of `ndJsonStream()` (docs/01-architecture-overview.md §5,
 * docs/07-provider-adapter-layer.md §"Enforce your own frame cap"). This is
 * that cap's own unit test — pure byte arithmetic, no child process.
 *
 * That the SDK's buffer really is unbounded is asserted against the real SDK
 * class in test/integration/spike-s1-acp.test.ts, which is the only place the
 * dependency exists.
 *
 * Verifies: EPIC-00-S8 · AC8.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  CappedLineFramer,
  DEFAULT_FRAME_CAP_BYTES,
  FrameTooLargeError,
} from '../spikes/s1-acp/src/framing.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);
const text = (lines: Uint8Array[]) => lines.map((line) => new TextDecoder().decode(line));

suite('the cap is the architecture’s 8 MiB', () => {
  it('defaults to 8 MiB and states it in bytes', () => {
    expect(DEFAULT_FRAME_CAP_BYTES).toBe(8 * 1024 * 1024);
  });
});

suite('framing in the ordinary case', () => {
  it('splits newline-delimited lines and drops the newline', () => {
    const framer = new CappedLineFramer();
    expect(text(framer.push(utf8('{"a":1}\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('carries an unterminated tail across chunks', () => {
    const framer = new CappedLineFramer();
    expect(framer.push(utf8('{"a":'))).toEqual([]);
    expect(text(framer.push(utf8('1}\n')))).toEqual(['{"a":1}']);
  });

  it('never emits an empty line for a bare newline', () => {
    const framer = new CappedLineFramer();
    expect(text(framer.push(utf8('\n\n')))).toEqual(['', '']);
  });
});

suite('the cap fires on the byte that crosses it, not after the buffer is whole', () => {
  it('accepts a line exactly at the cap', () => {
    const framer = new CappedLineFramer(16);
    expect(text(framer.push(utf8(`${'x'.repeat(16)}\n`)))).toEqual(['x'.repeat(16)]);
  });

  it('throws a typed error on the first byte past the cap', () => {
    const framer = new CappedLineFramer(16);
    let thrown: unknown;
    try {
      framer.push(utf8('x'.repeat(17)));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FrameTooLargeError);
    expect((thrown as FrameTooLargeError).code).toBe('adapter.frame-too-large');
    expect((thrown as FrameTooLargeError).capBytes).toBe(16);
    expect((thrown as FrameTooLargeError).bytesAtFailure).toBe(17);
  });

  it('fires across chunk boundaries, so a slow flood is caught too', () => {
    const framer = new CappedLineFramer(16);
    framer.push(utf8('x'.repeat(10)));
    expect(() => framer.push(utf8('y'.repeat(10)))).toThrow(FrameTooLargeError);
  });

  it('measures the pending line, not the chunk: a capped-size chunk of complete lines is fine', () => {
    const framer = new CappedLineFramer(8);
    // 24 bytes of chunk, but no single line exceeds 8.
    expect(framer.push(utf8('aaaa\nbbbb\ncccc\ndddd\n')).length).toBe(4);
  });

  it('resets its measurement after each completed line', () => {
    const framer = new CappedLineFramer(8);
    framer.push(utf8('aaaaaaaa\n'));
    expect(() => framer.push(utf8('bbbbbbbb\n'))).not.toThrow();
  });
});

suite('the pending tail is observable, which is how the flood is measured', () => {
  it('reports how many bytes are held for an unterminated line', () => {
    const framer = new CappedLineFramer();
    framer.push(utf8('x'.repeat(1000)));
    expect(framer.pendingBytes).toBe(1000);
    framer.push(utf8('\n'));
    expect(framer.pendingBytes).toBe(0);
  });
});
