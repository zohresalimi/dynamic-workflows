/**
 * The SSE wire contract (docs/11-api-and-realtime.md §3), as pure functions.
 *
 * Every byte this daemon writes to a `text/event-stream` is produced here, and
 * that is the point: the frame format is a contract with a client that resumes
 * from `id:`, and a contract asserted by reading a running server is a contract
 * that can only be checked after it has already been broken. These are unit
 * tested in `./sse.test.ts` and used verbatim by `./stream.ts`.
 *
 * Four rules from §3.2 are encoded in the two builders rather than left to the
 * caller:
 *
 * 1. **`id: <seq>` on every ledger frame, and on nothing else.** A control
 *    frame that set one would poison `Last-Event-ID` with a number out of a
 *    different sequence, and the client would resume from a `seq` belonging to
 *    somebody else's event.
 * 2. **Ledger frames use the default, unnamed event type**, so the client needs
 *    exactly one `onmessage` feeding `applyEvent`, and discriminates on the
 *    payload's `kind`.
 * 3. **Named events are stream control** — `hello`, `subscribed`, `caught_up`,
 *    `fatal` — and never reach the reducer.
 * 4. **`data` is one line.** `JSON.stringify` escapes every newline an event
 *    payload can contain, so a serialised envelope has no line breaks in it;
 *    splitting an event across `data:` lines is legal SSE and buys nothing but
 *    a harder reader.
 */
import type { RunId } from '@DeFlow/core';
import type { StoredEvent } from '@DeFlow/ledger';
import { asRunId } from './ledger-view.ts';

/**
 * KAR-13.2 AC5 / KAR-15.3 AC10 — `runs=*`, and what it is *not*.
 *
 * It is not "every event of every run". It is the low-volume global lifecycle
 * topic, membership exactly four kinds, which is what the run list and the
 * cross-run approval queue need and is deliberately nothing else. An idle tab
 * subscribed to it receives a `human.requested` from any run and not one
 * `node.progress` frame from the noisy run next to it — which is the whole
 * reason one connection per tab is affordable (docs/11 §2).
 */
export const GLOBAL_TOPIC = '*';

export const GLOBAL_TOPIC_KINDS: readonly string[] = [
  'run.created',
  'run.completed',
  'run.aborted',
  'human.requested',
];

/**
 * KAR-19.2 AC8 — the kinds after which a run says nothing else, ever.
 *
 * The two `endRun` folds, and no third. `run.stalled` is deliberately absent —
 * F4.7 is *"surfaced, never auto-killed"*, and a stalled run is one somebody is
 * about to interject on. `needs-human` likewise: it is a run waiting for a
 * person, which is the one state a stream must stay open through.
 */
export const TERMINAL_KINDS: readonly string[] = ['run.completed', 'run.aborted'];

/** The named frames, and the whole set of them (§3.2 rule 4). */
export const CONTROL_EVENTS = ['hello', 'subscribed', 'caught_up', 'fatal'] as const;
export type ControlEvent = (typeof CONTROL_EVENTS)[number];

/** §3.2 rule 2 — written once, immediately after the headers. */
export const RETRY_MS = 2000;
export const RETRY_FRAME = `retry: ${RETRY_MS}\n\n`;

/**
 * §3.2 rule 3 — thirteen bytes whose only job is that no socket-inactivity
 * timer anywhere in the path (Node's, the OS's, a proxy's) ever sees a silent
 * connection. A comment line carries no field, so every client ignores it.
 */
export const KEEPALIVE_FRAME = ': keepalive\n\n';

/** What `?runs=` resolved to, as the serving loop needs it. */
export interface RunFilter {
  /** Whether the global lifecycle topic was asked for. */
  readonly global: boolean;
  /** The runs named, de-duplicated, in the order given. */
  readonly runs: readonly RunId[];
  /** The kinds the global topic admits; empty when it was not asked for. */
  readonly kinds: readonly string[];
}

/**
 * `?runs=a,b` or `?runs=*` as the filter the **server** applies.
 *
 * Server-side is the whole design: a handler that materialised every row and
 * dropped most of them in the client would still pay for the firehose, which is
 * the cost `runs=*` exists to avoid. Anything unparseable is dropped rather
 * than refused — a stale run id in a tab's restored session is a subscription
 * that delivers nothing, not a connection that fails to open.
 */
export function parseRuns(query: string | undefined): RunFilter {
  const tokens = (query ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const global = tokens.includes(GLOBAL_TOPIC);
  const runs = [
    ...new Set(
      tokens
        .filter((token) => token !== GLOBAL_TOPIC)
        .map((token) => asRunId(token))
        .filter((value): value is RunId => value !== null),
    ),
  ];
  return { global, runs, kinds: global ? GLOBAL_TOPIC_KINDS : [] };
}

/**
 * One ledger event, as the bytes that go on the wire.
 *
 * `id:` first so that a reader tailing the socket by eye sees the cursor before
 * the payload, and an unnamed type so the client's single `onmessage` gets it.
 */
export function ledgerFrame(event: StoredEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** One stream-control frame: named, and deliberately without an `id:`. */
export function controlFrame(name: ControlEvent, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}
