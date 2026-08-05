/**
 * KAR-05.4 — the frame-size guard, as a pure byte counter.
 *
 * **Verified hazard.** `@agentclientprotocol/sdk`'s `LineBuffer`
 * (`dist/line-buffer.js`) has no maximum line length: `push()` accumulates
 * chunks into a private `#pending` array and only emits when it finds a `0x0a`
 * byte. An agent that never emits a newline — buggy, wedged, or emitting one
 * enormous tool result — grows that array until DeFlowd OOMs, and DeFlowd is a
 * daemon that supervises runs for days (docs/07-provider-adapter-layer.md §10.1).
 *
 * Two decisions in this file are the whole story.
 *
 * **It counts bytes since the last newline, not the size of a completed
 * frame.** A guard that measured completed frames cannot see the agent that
 * never completes one, which is exactly the agent it exists for. The
 * complement matters as much: the counter *resets* at every newline, or a
 * legitimate turn that streams for an hour would be aborted for the crime of
 * being long.
 *
 * **It is upstream of the SDK.** Bolting a cap onto the parsed frame is too
 * late — by then the buffer has already grown to whatever the agent sent. So
 * this is fed from the transport's `pull()`, chunk by chunk, before the bytes
 * reach `ndJsonStream`, and it trips inside the chunk that crosses the cap
 * rather than after it.
 *
 * The guard decides nothing about what to do with the trip. The transport
 * raises it, `run-node.ts` kills the process group and files the failure. This
 * file just counts, which is why it is unit-testable without a subprocess.
 */
import { NodeFailureError } from '@DeFlow/core';

/**
 * The cap, in bytes: 8 MiB, the figure docs/07-provider-adapter-layer.md §10.2
 * suggests and this build adopts.
 *
 * For scale, measured 2026-08-02: a *trivial* `claude -p "say ok"` turn emitted
 * a single 16,024-byte JSON line, and a turn that reads a large file or
 * captures a test log routinely produces multi-megabyte single lines. 8 MiB is
 * chosen to be far above any of those and far below what kills a daemon.
 */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * How much of the offending frame is kept for diagnosis — the first 4 KiB,
 * which becomes the failure's evidence handle (AC1).
 *
 * Kept from the **start** of the line, unlike a terminal's ring buffer which
 * keeps the tail: the front of a JSON-RPC frame is the part that says which
 * method and which session produced it, and the tail of a runaway frame is
 * just more of whatever ran away.
 */
export const FRAME_EVIDENCE_BYTES = 4096;

/**
 * A configured cap that could never fire, or would fire on everything.
 *
 * A `NodeFailureError` rather than a bare `Error` because of the rule
 * `test/adapter-shape.test.ts` keeps: nothing leaves this package as a thrown
 * `Error`, since a V8 stack does not survive `JSON.stringify`, a daemon restart
 * or the node inspector. `internal` is the honest reason — an impossible cap is
 * DeFlow's own misconfiguration, not something the agent did — and `permanent`
 * because a configuration value does not fix itself between attempts.
 */
export class InvalidFrameLimit extends NodeFailureError {
  readonly limit: unknown;

  constructor(limit: unknown) {
    super(
      `${String(limit)} is not a usable frame cap. It must be a positive, finite integer number ` +
        'of bytes: 0 rejects every frame including the handshake, and Infinity is the unbounded ' +
        'line buffer this guard exists to replace — a cap that cannot fire is not a cap.',
      { reason: 'internal', class: 'permanent', detail: { limit: String(limit) } },
    );
    this.name = 'InvalidFrameLimit';
    this.limit = limit;
  }
}

/**
 * The configured cap, or the 8 MiB default when nothing was configured.
 *
 * A run may lower it — a conformance run that wants the guard to fire quickly,
 * say — but it may not turn it off, and this is the one place that is decided
 * (EPIC-05-S15).
 */
export function parseFrameLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new InvalidFrameLimit(limit);
  return limit;
}

/** What the guard says when the cap is crossed. */
export interface FrameTooLargeReport {
  /** Bytes since the last newline at the moment the cap was crossed. */
  readonly bytes: number;
  readonly limit: number;
  /** The first `FRAME_EVIDENCE_BYTES` of the offending line, or all of it when
   * it is shorter. Bytes rather than a string: the evidence is what arrived. */
  readonly head: Uint8Array;
}

export interface FrameGuard {
  /**
   * Feeds one chunk of the child's stdout. Returns `null` while the stream is
   * legal, and the report **once**, on the chunk that crosses the cap.
   */
  inspect(chunk: Uint8Array): FrameTooLargeReport | null;
  bytesSinceNewline(): number;
  tripped(): boolean;
}

const NEWLINE = 0x0a;

export function frameGuard(limit: number = DEFAULT_MAX_FRAME_BYTES): FrameGuard {
  const cap = parseFrameLimit(limit);
  let since = 0;
  let over = false;
  // At most FRAME_EVIDENCE_BYTES are ever retained, so the guard's own memory
  // cost is constant no matter how large the frame it is watching grow.
  let head: Uint8Array = new Uint8Array(0);

  const remember = (chunk: Uint8Array, from: number, to: number): void => {
    if (head.byteLength >= FRAME_EVIDENCE_BYTES) return;
    const wanted = Math.min(FRAME_EVIDENCE_BYTES - head.byteLength, to - from);
    if (wanted <= 0) return;
    const grown = new Uint8Array(head.byteLength + wanted);
    grown.set(head, 0);
    grown.set(chunk.subarray(from, from + wanted), head.byteLength);
    head = grown;
  };

  return {
    inspect(chunk) {
      if (over) return null;

      // Segment by segment rather than "everything after the last newline",
      // which is the version that has a hole in it: the transport hands this
      // whole *completed* frames, and a chunk that ends in `\n` would reset the
      // counter without ever having counted the frame it just delivered. So
      // each newline closes a line — measured, then reset — and the tail of the
      // chunk is the line still growing.
      let from = 0;
      for (;;) {
        const newline = chunk.indexOf(NEWLINE, from);
        const end = newline === -1 ? chunk.byteLength : newline;
        remember(chunk, from, end);
        since += end - from;

        if (since > cap) {
          over = true;
          return { bytes: since, limit: cap, head };
        }
        if (newline === -1) return null;

        since = 0;
        head = new Uint8Array(0);
        from = newline + 1;
      }
    },
    bytesSinceNewline: () => since,
    tripped: () => over,
  };
}
