/**
 * KAR-13.2 AC10 — mutating a live stream's topic filter without reconnecting
 * (docs/11-api-and-realtime.md §2).
 *
 * *"Adding a run panel must **not** open a second connection and must not
 * require a reconnect."* That is an architecture constraint rather than a
 * tuning knob: HTTP/1.1 caps concurrent connections per origin at about six, an
 * SSE connection never closes, and one stream per run panel across three tabs
 * exhausts the budget — after which every subsequent `fetch` silently queues
 * behind them, forever. The symptom reads as *"the daemon hung"*.
 *
 * So the `hello` frame carries a `streamId`, and `POST /api/stream/:id/subscribe`
 * hands this registry the runs to add. The handler that owns the socket picks
 * them up on its next tick and does the two-phase thing §5 insists on:
 * **backfill the newly subscribed run from the client's cursor, then resume live
 * delivery** — subscribe-then-drain-again, never subscribe-only, or every event
 * committing between the last drain and the subscription is lost.
 *
 * The queue is a *handoff*, not shared mutable state: the POST handler appends,
 * the stream handler drains, and nothing but the stream handler ever touches
 * the cursor map or writes a frame. Two writers on one SSE socket is how frames
 * end up interleaved mid-line.
 */
import type { RunId } from '@DeFlow/core';
import { randomUUID } from 'node:crypto';

/** One live connection, as the subscribe route can reach it. */
interface StreamRegistration {
  /** Runs asked for since the handler last looked. Drained, never read twice. */
  pending: RunId[];
}

const streams = new Map<string, StreamRegistration>();

/** One live stream, from the perspective of the handler that owns the socket. */
export interface StreamHandle {
  readonly id: string;
  /** The runs asked for since the last call, and they are taken, not copied. */
  takePending(): readonly RunId[];
  /** Called when the socket closes. A registry entry outliving its socket is a
   * subscription nothing will ever deliver. */
  close(): void;
}

/** Registers a connection and returns the id its `hello` frame announces. */
export function registerStream(): StreamHandle {
  const id = randomUUID();
  const registration: StreamRegistration = { pending: [] };
  streams.set(id, registration);

  return {
    id,
    takePending: () => registration.pending.splice(0),
    close: () => {
      streams.delete(id);
    },
  };
}

/**
 * Queues `runs` onto a live stream. `false` when no such stream is open — a
 * `404`, and never a silent success, because a client that believes it
 * subscribed and receives nothing has no way to find out it did not.
 */
export function subscribeStream(streamId: string, runs: readonly RunId[]): boolean {
  const registration = streams.get(streamId);
  if (registration === undefined) return false;
  registration.pending.push(...runs);
  return true;
}

/** How many streams are open. For a test asserting the connection budget. */
export function openStreamCount(): number {
  return streams.size;
}
