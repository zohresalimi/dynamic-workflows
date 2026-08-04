/**
 * The resume contract, as arithmetic.
 *
 * `EventSource` sends `Last-Event-ID` **only on an automatic reconnect** —
 * never on a fresh `new EventSource()` after a page reload — and it cannot set
 * custom headers at all (verified 2026-08-02, re-verified against a real
 * Chromium by e2e/spike-s4-one-port.test.ts). So a stream endpoint needs both
 * mechanisms: `?since=<seq>` for the reload, the header for the reconnect.
 *
 * Both mean the same thing, and it is not "seq + 1": **deliver strictly greater
 * than this seq**. A rolled-back transaction burns an AUTOINCREMENT value in
 * the real ledger, so a client that expects contiguous ids reports a phantom
 * missing event the first time a write fails.
 */

export interface StreamEvent {
  readonly seq: number;
  /** Milliseconds since the emitter started, for the record only. */
  readonly at: number;
  readonly data: string;
}

export type Resume =
  | { readonly mode: 'live' }
  | { readonly mode: 'since'; readonly after: number }
  | { readonly mode: 'last-event-id'; readonly after: number };

/** Non-negative integers only: no `-1`, no `1.5`, no `1e3`, no `NaN`. */
const SEQ = /^(?:0|[1-9][0-9]*)$/;

function parseSeq(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return SEQ.test(value) ? Number(value) : null;
}

/**
 * A malformed cursor resolves to `live`, not to `after: 0`. Replaying the whole
 * log because a query string was mistyped is the more expensive mistake.
 *
 * When **both** are offered, resume from the greater of the two. That case is
 * not hypothetical and it is not the one this spike expected: a page that
 * reloads hydrates at `/api/stream?since=137`, and when that connection is
 * later severed the browser reconnects **to the same URL**, so it sends the
 * now-stale `?since=137` *and* a current `Last-Event-ID: 150` together
 * (measured, Chromium 151, 2026-08-04). Preferring `?since` there would replay
 * thirteen events the page already had — the exact duplication AC5 forbids.
 */
export function resumeFrom(input: {
  readonly since?: string | null;
  readonly lastEventId?: string | null;
}): Resume {
  const since = parseSeq(input.since);
  const header = parseSeq(input.lastEventId);
  if (header !== null && (since === null || header >= since)) {
    return { mode: 'last-event-id', after: header };
  }
  if (since !== null) return { mode: 'since', after: since };
  return { mode: 'live' };
}

export function eventsAfter(log: readonly StreamEvent[], resume: Resume): readonly StreamEvent[] {
  if (resume.mode === 'live') return [];
  return log.filter((event) => event.seq > resume.after);
}

export type SeqVerdict = 'accepted' | 'duplicate' | 'regression';

/**
 * A gap is `accepted`: it is what a rolled-back transaction looks like from the
 * client's side. Only a repeat or a step backwards is a contract violation.
 */
export function classifySeq(previous: number | null, seq: number): SeqVerdict {
  if (previous === null || seq > previous) return 'accepted';
  return seq === previous ? 'duplicate' : 'regression';
}
