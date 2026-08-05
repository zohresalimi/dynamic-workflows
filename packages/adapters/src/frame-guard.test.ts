/**
 * KAR-05.4 — the byte counter that sits upstream of the SDK's line buffer.
 *
 * The counter is "bytes since the last newline", and every assertion here is
 * about that phrase rather than about frames. A guard that measured the size of
 * a *completed* frame is invisible to the agent that never completes one — which
 * is precisely the wedged agent it exists for (EPIC-05-S14).
 *
 * Pure logic, so unit: no child, no stream, no clock. The integration specs
 * upstream of this one drive it from a real subprocess.
 *
 * Verifies: EPIC-05-S13, EPIC-05-S14, EPIC-05-S15 · AC1, AC2, AC3
 */
import { Buffer } from 'node:buffer';
import { expect, it, describe as suite } from 'vitest';
import {
  DEFAULT_MAX_FRAME_BYTES,
  FRAME_EVIDENCE_BYTES,
  frameGuard,
  InvalidFrameLimit,
  parseFrameLimit,
} from './frame-guard.ts';

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf8'));
const filler = (count: number): Uint8Array => new Uint8Array(Buffer.alloc(count, 0x61));

suite('the cap defaults to 8 MiB and is configurable but never absurd', () => {
  it('defaults to 8388608 bytes', () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(8388608);
  });

  it('keeps 4096 bytes of the offending frame, which is what the evidence handle holds', () => {
    expect(FRAME_EVIDENCE_BYTES).toBe(4096);
  });

  it('accepts a lower cap a run chose for itself', () => {
    expect(parseFrameLimit(64 * 1024)).toBe(65536);
    expect(parseFrameLimit(1)).toBe(1);
    expect(parseFrameLimit(undefined)).toBe(DEFAULT_MAX_FRAME_BYTES);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %p, because a cap that cannot fire is not a cap',
    (limit) => {
      expect(() => parseFrameLimit(limit)).toThrow(InvalidFrameLimit);
    },
  );
});

suite('the counter is bytes since the last newline (AC3)', () => {
  it('accumulates across chunks that contain no newline', () => {
    const guard = frameGuard(1024);
    expect(guard.inspect(filler(400))).toBeNull();
    expect(guard.bytesSinceNewline()).toBe(400);
    expect(guard.inspect(filler(400))).toBeNull();
    expect(guard.bytesSinceNewline()).toBe(800);
  });

  it('resets on every newline, so a long turn of legal frames never trips', () => {
    const guard = frameGuard(1024);
    for (let frame = 0; frame < 100; frame += 1) {
      expect(guard.inspect(bytes(`${'a'.repeat(1000)}\n`))).toBeNull();
      expect(guard.bytesSinceNewline()).toBe(0);
    }
  });

  it('counts only the bytes after the last newline of a multi-frame chunk', () => {
    const guard = frameGuard(1024);
    expect(guard.inspect(bytes('one\ntwo\nthre'))).toBeNull();
    expect(guard.bytesSinceNewline()).toBe(4);
  });

  /**
   * The hole in the obvious implementation, and the one an integration spec
   * found first: the transport hands the guard **completed frames**, newline
   * included, so a counter that only measured "bytes after the last newline"
   * would reset on every frame without ever having measured one — and would
   * never fire on an oversized line that arrived in a single read.
   */
  it('measures a completed line handed over as one newline-terminated chunk', () => {
    const guard = frameGuard(1024);
    const tripped = guard.inspect(bytes(`${'a'.repeat(2000)}\n`));
    expect(tripped?.bytes).toBe(2000);
  });

  it('measures each line of a multi-line chunk on its own', () => {
    const guard = frameGuard(1024);
    expect(guard.inspect(bytes(`${'a'.repeat(900)}\n${'b'.repeat(900)}\n`))).toBeNull();
    const tripped = guard.inspect(bytes(`${'c'.repeat(900)}\n${'d'.repeat(1100)}\n`));
    expect(tripped?.bytes).toBe(1100);
    expect(Buffer.from(tripped?.head ?? new Uint8Array()).toString('utf8')).toBe('d'.repeat(1100));
  });
});

suite('the boundary, from both sides (EPIC-05-S15)', () => {
  it('delivers a line of exactly the cap', () => {
    const guard = frameGuard(1024);
    expect(guard.inspect(filler(1024))).toBeNull();
    expect(guard.inspect(bytes('\n'))).toBeNull();
    expect(guard.bytesSinceNewline()).toBe(0);
  });

  it('trips on the byte after the cap', () => {
    const guard = frameGuard(1024);
    expect(guard.inspect(filler(1024))).toBeNull();
    const tripped = guard.inspect(filler(1));
    expect(tripped?.bytes).toBe(1025);
    expect(tripped?.limit).toBe(1024);
  });

  it('trips inside the chunk that crosses the cap, not after it', () => {
    const guard = frameGuard(1024);
    const tripped = guard.inspect(filler(4096));
    expect(tripped).not.toBeNull();
    expect(tripped?.bytes).toBe(4096);
  });

  it('trips on an unterminated flood as readily as on a completed line', () => {
    const guard = frameGuard(1024);
    let tripped = null;
    for (let chunk = 0; chunk < 100 && tripped === null; chunk += 1) {
      tripped = guard.inspect(filler(64));
    }
    expect(tripped?.bytes).toBeGreaterThan(1024);
  });
});

suite('the evidence head (AC1)', () => {
  it('is the first 4096 bytes of the offending line, assembled across chunks', () => {
    const guard = frameGuard(64 * 1024);
    // Exactly the cap, 2 KiB at a time: the head is assembled from the first
    // two of these and the rest add nothing to it.
    for (let chunk = 0; chunk < 32; chunk += 1) {
      expect(guard.inspect(bytes('x'.repeat(2048)))).toBeNull();
    }
    const tripped = guard.inspect(bytes('x'));
    expect(tripped?.head.byteLength).toBe(FRAME_EVIDENCE_BYTES);
    expect(Buffer.from(tripped?.head ?? new Uint8Array()).toString('utf8')).toBe(
      'x'.repeat(FRAME_EVIDENCE_BYTES),
    );
  });

  it('starts at the *line*, not at the stream: earlier frames are not in it', () => {
    const guard = frameGuard(4096);
    guard.inspect(bytes('an earlier, perfectly legal frame\n'));
    const tripped = guard.inspect(bytes('B'.repeat(5000)));
    expect(Buffer.from(tripped?.head ?? new Uint8Array()).toString('utf8')).toBe(
      'B'.repeat(FRAME_EVIDENCE_BYTES),
    );
  });

  it('is short when the offending line is shorter than the evidence window', () => {
    const guard = frameGuard(64);
    const tripped = guard.inspect(bytes('C'.repeat(100)));
    expect(tripped?.head.byteLength).toBe(100);
  });
});

suite('a tripped guard stays tripped', () => {
  it('reports the trip once and refuses to keep counting', () => {
    const guard = frameGuard(1024);
    expect(guard.inspect(filler(2048))).not.toBeNull();
    expect(guard.inspect(filler(2048))).toBeNull();
    expect(guard.tripped()).toBe(true);
  });
});
