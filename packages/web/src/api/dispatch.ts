/**
 * KAR-15.3 — the client half of the frame contract: one dispatcher, fanning
 * out by `runId` (docs/11-api-and-realtime.md §2, §3.2 rules 4 and 6).
 *
 * The tab holds **one** connection carrying every run it is watching, so
 * something has to route each frame to the right projection set. That is this
 * module, and it makes exactly two decisions:
 *
 * 1. **Named frame or not.** A named frame is stream control — `hello`,
 *    `subscribed`, `caught_up`, `fatal` — and never reaches the reducer. An
 *    unnamed one is a ledger event and always does. The discriminator is
 *    therefore the payload's `kind`, never the SSE `event:` name: an unknown
 *    *name* is still control, and a new event kind needs no new handler.
 * 2. **Known kind or not.** `parseEvent` is @DeFlow/core's, the same function
 *    the daemon's reducer reads events through, so "ignored by the client
 *    exactly as the backend reducer ignores it" is one implementation rather
 *    than two that agree today. An unknown kind is dropped **and the cursor
 *    still advances past it** — a client that skipped both would re-request
 *    that event on every reconnect, forever.
 *
 * The cursor is the client's own, not the browser's `Last-Event-ID`: §4.1 is
 * explicit that a tab reloading sends no such header, so the persisted cursor
 * is what `?since=` carries and this is where it comes from.
 */
import type { Event, ParseEventResult } from '@DeFlow/core';
import { parseEvent } from '@DeFlow/core';

/** One frame off the wire, in the shape `eventsource-client` reports it. */
export interface StreamFrame {
  readonly event?: string | undefined;
  readonly id?: string | undefined;
  readonly data: string;
}

/** A named frame, with its data parsed. `payload` is `null` if it was not JSON. */
export interface ControlFrame {
  readonly name: string;
  readonly payload: unknown;
}

export interface DispatcherOptions {
  /** Called for every ledger event of a kind this build knows. */
  readonly applyEvent: (event: Event) => void;
  /** Called for every named frame, control being the only thing they are. */
  readonly control: (frame: ControlFrame) => void;
  /** Called for a kind this build has never heard of. Diagnostics only. */
  readonly onUnknownKind?: (kind: string, seq: number) => void;
}

export interface Dispatcher {
  onFrame(frame: StreamFrame): void;
  /** The highest `seq` seen, whether or not this build understood it. */
  cursor(): number;
}

/**
 * The one `onmessage` the client needs.
 *
 * Nothing here throws. A stream is a long-lived connection processing frames a
 * newer daemon wrote, and an exception on frame 4,000 would take out every
 * projection in the tab over one event nobody needed.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  let cursor = 0;

  return {
    cursor: () => cursor,
    onFrame(frame: StreamFrame): void {
      if (frame.event !== undefined && frame.event !== '' && frame.event !== 'message') {
        options.control({ name: frame.event, payload: parseJson(frame.data) });
        return;
      }

      // The cursor advances on the frame's own `id:` when the envelope cannot
      // be read at all, which is the only way past a payload this build has no
      // schema for without asking for it again on every reconnect.
      const parsed = parseEvent(parseJson(frame.data));
      if (parsed.status === 'ok') {
        cursor = Math.max(cursor, parsed.event.seq);
        options.applyEvent(parsed.event);
        return;
      }

      const seq = seqOf(parsed, frame.id);
      cursor = Math.max(cursor, seq);
      if (parsed.status === 'unknown-kind') options.onUnknownKind?.(parsed.kind, seq);
    },
  };
}

/**
 * An `applyEvent` that routes by `runId` to whichever projection set is
 * watching that run — the fan-out §2 describes, and the reason three run
 * panels are three projection sets behind one connection.
 *
 * A frame for a run nothing is watching is dropped rather than treated as an
 * error: the filter is the server's, and a subscription the tab has since
 * closed will keep delivering for as long as the server has not been told.
 */
export function fanOutByRun(
  route: (runId: string) => ((event: Event) => void) | undefined,
): (event: Event) => void {
  return (event) => route(event.runId)?.(event);
}

/**
 * AC15 — the two codes a client must **stop** retrying on.
 *
 * Everything else is transient by assumption, including `internal`: a daemon
 * that failed one read is a daemon worth reconnecting to. These two are not —
 * a rotated token and a superseded daemon epoch both mean this client needs a
 * human or a reload, and a client that retried would hammer a socket that can
 * only ever refuse it.
 */
const TERMINAL_FATAL_CODES: readonly string[] = ['bad_token', 'epoch_mismatch'];

export function stopsRetrying(code: string): boolean {
  return TERMINAL_FATAL_CODES.includes(code);
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * The `seq` of a frame this build could not parse.
 *
 * Off the parse result when it has one — an unknown `kind` still yields a
 * well-formed envelope — and off the frame's own `id:` when the envelope
 * itself was unreadable, which is the only way past a frame this build cannot
 * decode without asking for it again on every reconnect.
 */
function seqOf(parsed: ParseEventResult, id: string | undefined): number {
  if ('seq' in parsed && typeof parsed.seq === 'number') return parsed.seq;
  const fromId = Number(id);
  return Number.isSafeInteger(fromId) && fromId > 0 ? fromId : 0;
}
