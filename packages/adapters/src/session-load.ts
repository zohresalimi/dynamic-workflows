/**
 * KAR-05.5 AC6 — `session/load` is not `session/resume`, and this module is
 * the only place in DeFlow allowed to say the word.
 *
 * `loadSession` was advertised `true` by every adapter probed on 2026-08-02,
 * which makes it a tempting substitute for a capability two of them do not
 * have. It is not one: `session/load` **streams the entire conversation
 * history back as `session/update` notifications** while `session/resume` does
 * not. For a run that has been going for two days that is tens of thousands of
 * frames, every one of which DeFlow already has durably.
 *
 * So nothing here is reachable from the strategy selector (see ./resume.ts,
 * which never asks about `loadSession`). This is a *diagnostic* path — "show
 * me what the agent thinks the history is" — and it comes with two guards.
 *
 * **The flood is bounded before the frame is sent.** DeFlow knows how many
 * notifications it has recorded for the session, which is how many the agent
 * is about to replay; above the cap it refuses with a typed failure naming the
 * count, and the caller resumes by replay from the ledger instead.
 *
 * **Deduplication is keyed on DeFlow's own event ids, never the agent's.** The
 * agent's ids are not stable across a reconnect: the same tool call comes back
 * as a different `toolCallId`, and a dedupe keyed on it concludes that a
 * history DeFlow already holds is hundreds of new events. Both keys used here
 * are DeFlow's — the notification's **ordinal in DeFlow's own durable log**,
 * and a **digest DeFlow computed itself** over the frame, scoped by node and
 * attempt. The ordinal survives the agent re-minting its ids; the digest
 * survives the agent replaying them out of order. A notification matched by
 * either is discarded.
 */

import { type Clock, canonicalJson, NodeFailureError, type NodeId, sha256Hex } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import type { LedgerSink } from './ports.ts';

/**
 * How many recorded notifications make a `session/load` unreasonable.
 *
 * A thousand `session/update` frames is already a multi-hour turn, and the
 * whole point of the guard is that the cost of `load` grows with the *run* and
 * not with what the caller is trying to inspect. Above it, replay from the
 * ledger is both cheaper and the answer DeFlow trusts anyway.
 */
export const MAX_LOAD_REPLAY_NOTIFICATIONS = 1_000;

/** Which node's session a notification belongs to, in DeFlow's own terms. */
export interface NotificationScope {
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
}

/**
 * DeFlow's own id for one agent notification.
 *
 * `<nodeId>#<attempt>#sha256-<hex>`: DeFlow's coordinates plus a digest DeFlow
 * computed over the canonical encoding of the frame. Nothing in it comes from
 * the agent's own id space, which is the entire point — those ids are
 * regenerated on a reconnect.
 */
export async function deflowNotificationId(
  scope: NotificationScope,
  notification: unknown,
): Promise<string> {
  return `${scope.nodeId}#${scope.attempt}#sha256-${await sha256Hex(canonicalJson(notification))}`;
}

export interface ReplayedNotification {
  /** Its position in DeFlow's own log once appended. */
  readonly ordinal: number;
  readonly notification: unknown;
}

export interface LoadDedupeResult {
  /** What DeFlow has never appended, numbered from the end of its own log. */
  readonly fresh: readonly ReplayedNotification[];
  /** How many replayed frames were dropped — the number the warning records. */
  readonly discarded: number;
}

/**
 * Splits a replayed history into "already durable" and "new".
 *
 * `known` is DeFlow's own id for every notification it has already appended
 * for this session, in the order it appended them.
 */
export async function dedupeReplayedNotifications(
  known: Iterable<string>,
  replayed: readonly unknown[],
  scope: NotificationScope,
): Promise<LoadDedupeResult> {
  const knownIds = [...known];
  const seen = new Set(knownIds);
  const fresh: ReplayedNotification[] = [];

  for (const [index, notification] of replayed.entries()) {
    const id = await deflowNotificationId(scope, notification);
    // Two DeFlow-minted keys, either of which is enough to discard. The
    // positional one catches an agent that re-minted its ids; the id set
    // catches a replay that arrives out of order, and catches the same frame
    // delivered twice inside one load.
    if (index < knownIds.length || seen.has(id)) continue;
    seen.add(id);
    fresh.push({ ordinal: knownIds.length + fresh.length, notification });
  }

  return { fresh, discarded: replayed.length - fresh.length };
}

/**
 * The refusal, decided from DeFlow's own count **before** the frame goes out —
 * `null` when the session is small enough to load.
 *
 * `adapter.protocol-error` is the reason because the failure is about the ACP
 * exchange rather than about the agent's answer to it, and `permanent` because
 * a session does not get shorter: the caller's move is to resume by replay,
 * not to try `load` again in a minute.
 */
export function loadWouldFlood(
  recordedNotifications: number,
  cap: number = MAX_LOAD_REPLAY_NOTIFICATIONS,
): NodeFailureError | null {
  if (recordedNotifications <= cap) return null;
  return new NodeFailureError(
    `refusing session/load: this session has ${recordedNotifications} recorded session/update ` +
      `notifications and session/load replays all of them, over the ${cap}-notification cap. ` +
      'session/load is not session/resume; DeFlow rebuilds the prompt from its own ledger instead',
    {
      reason: 'adapter.protocol-error',
      class: 'permanent',
      detail: { notifications: recordedNotifications, cap },
    },
  );
}

export interface SessionLoadRequest {
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly sessionId: string;
  /**
   * DeFlow's own id for every notification it has already appended for this
   * session, oldest first — read back out of its own `io_chunk` rows, never
   * out of anything the agent said.
   */
  readonly known: readonly string[];
}

export interface SessionLoadPorts {
  readonly clock: Clock;
  readonly ledger: LedgerSink;
  /**
   * Issues `session/load` and resolves with every notification the agent
   * replayed, in arrival order.
   *
   * A port because the ACP plumbing belongs to whoever holds the connection,
   * and because the decisions this module makes — refuse, dedupe, append,
   * warn — are the part worth testing without one.
   */
  readonly load: (sessionId: string) => Promise<readonly unknown[]>;
}

export type SessionLoadOutcome =
  | { readonly status: 'refused'; readonly failure: NodeFailureError }
  | { readonly status: 'loaded'; readonly appended: number; readonly discarded: number };

/**
 * The deliberate diagnostic path, with both guards attached.
 *
 * Nothing in DeFlow's scheduling reaches this: `selectResumeStrategy` never
 * asks about `loadSession`, and a resume that wanted history rebuilds it from
 * the ledger. This exists so that "show me what the agent believes the history
 * is" is answerable at all — and so that answering it cannot flood the daemon
 * or double the run's transcript.
 */
export async function diagnoseSessionLoad(
  request: SessionLoadRequest,
  ports: SessionLoadPorts,
): Promise<SessionLoadOutcome> {
  const refusal = loadWouldFlood(request.known.length);
  if (refusal !== null) return { status: 'refused', failure: refusal };

  const scope: NotificationScope = { nodeId: request.nodeId, attempt: request.attempt };
  const replayed = await ports.load(request.sessionId);
  const { fresh, discarded } = await dedupeReplayedNotifications(request.known, replayed, scope);

  for (const entry of fresh) {
    await ports.ledger.appendIo({
      nodeId: request.nodeId,
      attempt: request.attempt,
      stream: 'agent_json',
      ts: ports.clock.now(),
      data: Buffer.from(
        `${JSON.stringify({ method: 'session/update', params: entry.notification })}\n`,
        'utf8',
      ),
    });
  }

  // The warning EPIC-05-S21 asks for: how much of that flood was already
  // durable. A load that discarded everything is the normal case and still
  // worth a row — it is the evidence that the dedupe ran at all.
  await ports.ledger.append({
    kind: 'node.progress',
    v: 1,
    ts: ports.clock.now(),
    nodeId: request.nodeId,
    attempt: request.attempt,
    payload: {
      node: request.nodeId,
      attempt: request.attempt,
      phase: 'session.load.deduped',
      message: `session/load replayed ${replayed.length} notifications: discarded ${discarded}, appended ${fresh.length}`,
    },
  });

  return { status: 'loaded', appended: fresh.length, discarded };
}
