/**
 * KAR-13.3 — posting an interjection at a running node, and recording that it
 * arrived (docs/11-api-and-realtime.md §7.5).
 *
 * The decision is `@DeFlow/core`'s `planInterjection`; what lives here is the
 * **edge** — the two things a pure function cannot reach.
 *
 * **Which capability row applies.** The delivery answer turns on whether the
 * node's adapter advertises mid-turn steering, and that is a row in
 * `provider_capabilities` keyed by the provider the node was *scheduled onto* —
 * read from the projection, not from the plan's preference list, because a
 * quota re-route (KAR-14.4) can move a node onto a different adapter mid-run
 * and the plan would still name the first one. There is no provider name in
 * this file for the same reason there is none in `capabilities.ts`: the matrix
 * is a fixture to re-probe, never a constant.
 *
 * **The append.** One transaction, or none at all. A refusal writes nothing —
 * an interjection recorded against a node that has finished is an audit trail
 * implying something happened, which is worse than an error.
 *
 * As with `./gate.ts`, the service functions are written to be *mounted* rather
 * than to be an HTTP layer: `POST /api/runs/:id/interject` is
 * `interjectIntoNode` plus a status code, and the status code is on the result
 * so the two cannot drift.
 *
 * Verifies: EPIC-13-S17, EPIC-13-S18, EPIC-13-S19, EPIC-13-S20 · AC1, AC2, AC3,
 * AC4, AC6, AC7, AC9
 */
import { supportsSteering } from '@DeFlow/adapters';
import type {
  Db,
  EmittedEvent,
  EventSeq,
  InterjectionMode,
  NodeId,
  NodeStatus,
  ProviderId,
  RunId,
  RunState,
} from '@DeFlow/core';
import {
  EVENT_CURRENT_VERSIONS,
  initialRunState,
  planInterjection,
  toSingleLine,
} from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  headSeq,
  readProviderCapabilities,
  readRange,
  replayAll,
} from '@DeFlow/ledger';

const versionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

const stateOf = (db: Db, runId: RunId): RunState =>
  replayAll(db).runs.get(runId) ?? initialRunState();

function draft(
  runId: RunId,
  nodeId: NodeId,
  attempt: number,
  ts: number,
  epoch: number,
  event: EmittedEvent,
): EventDraft {
  return {
    runId,
    ts,
    kind: event.kind,
    v: versionOf(event.kind),
    epoch,
    nodeId,
    attempt,
    payload: event.payload,
  };
}

/**
 * AC2 — what the node's adapter advertised about mid-turn steering.
 *
 * `undefined` covers three cases that are all the same answer here: the node
 * has no provider on it yet, the provider was never probed, and the probed row
 * carries no `_meta.midSessionSteering`. Only an explicit grant delivers.
 */
export function steeringFor(db: Db, provider: ProviderId | null): boolean | undefined {
  if (provider === null) return undefined;
  // Oldest first; "what is installed now" is the last one.
  const row = readProviderCapabilities(db, provider).at(-1);
  // The two row types are structurally identical; only `provider` differs, and
  // only in its brand — @DeFlow/ledger owns the table and declares it as text,
  // while @DeFlow/adapters declares the branded id it was asked about. This is
  // that one narrowing, and it is safe because the row came back keyed on it.
  return row === undefined ? undefined : supportsSteering({ ...row, provider });
}

export interface InterjectOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly text: string;
  readonly mode: InterjectionMode;
  /** The cursor the Operator's panel rendered this node as running at (AC6). */
  readonly ifLastSeq?: number | undefined;
  readonly epoch: number;
  /** ms epoch, from the injected `Clock` — never `Date.now()`. */
  readonly ts: number;
}

/** The codes the API turns into status lines. */
export type InterjectRefusalCode =
  | 'node_not_found'
  | 'node_not_running'
  | 'use_respond'
  | 'empty_text'
  | 'stale_cursor';

export type InterjectResult =
  | {
      readonly status: 'ok';
      /** Accepted, never "done": delivery is asynchronous by construction. */
      readonly http: 202;
      readonly seq: EventSeq;
      readonly delivery: 'queued' | 'unsupported';
      /** Present for `unsupported`: why, and what to do instead. */
      readonly message?: string;
      readonly alternative?: InterjectionMode;
    }
  | {
      readonly status: 'refused';
      readonly http: 404 | 409 | 422;
      readonly code: InterjectRefusalCode;
      readonly message: string;
      /** The terminal state, for `node_not_running`. */
      readonly nodeStatus?: NodeStatus;
      /** For `stale_cursor`: where the node moved, and the ledger's head. */
      readonly movedAt?: number;
      readonly head?: number;
    };

/**
 * AC6 — the kinds that change whether *this node* can still be steered.
 *
 * Deliberately narrower than the approval queue's decision surface
 * (`./patch-decision.ts`), and node-scoped rather than run-wide. What an
 * interjection is decided against is one node's liveness — *"n_impl_3 is
 * running"* — so a gate opening on some other branch has changed nothing the
 * Operator was looking at, and answering `409` for it would train them to
 * re-post through a conflict that never mattered.
 */
const NODE_LIVENESS_KINDS: readonly string[] = [
  'node.completed',
  'node.failed',
  'node.cancelled',
  'node.suspended',
];

/** The seq at which `nodeId` stopped being steerable after `afterSeq`, or `null`. */
export function nodeMovedAfter(
  db: Db,
  runId: RunId,
  nodeId: NodeId,
  afterSeq: number,
): number | null {
  let cursor = afterSeq;
  for (;;) {
    const page = readRange(db, runId, cursor, LIVENESS_PAGE);
    for (const event of page.events) {
      cursor = event.seq;
      if (!NODE_LIVENESS_KINDS.includes(event.kind)) continue;
      if ((event.payload as { node?: unknown }).node === nodeId) return event.seq;
    }
    if (!page.hasMore) return null;
  }
}

const LIVENESS_PAGE = 500;

/** AC2 — the sentence an `unsupported` answer carries, so the UI need not invent one. */
const UNSUPPORTED_MESSAGE =
  'this adapter does not advertise mid-turn steering, so the guidance was recorded but not ' +
  'handed to the live session; post it again with mode "pause-and-inject", which works on ' +
  'every adapter because the guidance travels in the next context packet';

/**
 * AC1, AC2, AC4, AC6, AC7 — the Operator's correction, as the ledger records it.
 *
 * Three properties are load-bearing and all three are asserted in
 * `packages/daemon/test/integration/interject-api.test.ts`.
 *
 * **`unsupported` is a `202`.** It is an outcome, not a client error: the
 * Operator did nothing wrong and retrying will not help. What helps is the
 * alternative mode, which is why the answer names it.
 *
 * **A refusal appends nothing at all.** Both refusals that can race — the node
 * finishing, and an Operator reaching for the wrong mechanism on a `human` node
 * — leave the log exactly as they found it.
 *
 * **Nothing here mints an attempt.** `pause-and-inject` appends a
 * `node.suspended` beside the interjection in the same transaction, and that is
 * the whole of what it changes: the node resumes on the attempt it was
 * suspended on, so no completed effect is re-executed.
 */
export function interjectIntoNode(options: InterjectOptions): InterjectResult {
  const { db, runId, nodeId } = options;

  // Asked first, and before the node's own state: an Operator whose panel is
  // behind should be told their view is stale, not told about a node state they
  // have not seen yet. `Number.isSafeInteger` rather than a truthiness check —
  // seq 0 is a legitimate cursor meaning "I have read nothing".
  const cursor = options.ifLastSeq;
  if (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 0) {
    const movedAt = nodeMovedAfter(db, runId, nodeId, cursor);
    if (movedAt !== null) {
      return {
        status: 'refused',
        http: 409,
        code: 'stale_cursor',
        message: toSingleLine(
          `node '${nodeId}' moved at seq ${movedAt}, after the cursor ${cursor} this interjection ` +
            'was written against — it is no longer running. Nothing was appended; re-hydrate ' +
            'from your cursor and look at what it did',
        ),
        movedAt,
        head: headSeq(db),
      };
    }
  }

  const state = stateOf(db, runId);

  const planned = planInterjection(state, {
    node: nodeId,
    text: options.text,
    mode: options.mode,
    steering: steeringFor(db, state.nodes[nodeId]?.provider ?? null),
  });

  if (planned.status !== 'ok') {
    return {
      status: 'refused',
      http: refusalStatus(planned.status),
      code: planned.status,
      message: planned.message,
      ...(planned.status === 'node_not_running' ? { nodeStatus: planned.nodeStatus } : {}),
    };
  }

  const seqs = appendEvents(
    db,
    planned.events.map((event) =>
      draft(runId, nodeId, planned.attempt, options.ts, options.epoch, event),
    ),
  );

  const first = seqs[0];
  if (first === undefined) {
    throw new Error('the interjection appended no events, which cannot happen');
  }

  return {
    status: 'ok',
    http: 202,
    seq: first,
    delivery: planned.delivery,
    ...(planned.delivery === 'unsupported'
      ? { message: UNSUPPORTED_MESSAGE, alternative: 'pause-and-inject' as const }
      : {}),
  };
}

/**
 * `404` for a node that does not exist, `422` for a request that is malformed,
 * and `409` for the two conflicts — a world that moved, and a mechanism that
 * belongs to another route. `409` rather than `404` for a completed node
 * because the node *does* exist; what has changed is its state, which is a
 * conflict with what the Operator was looking at when they typed.
 */
function refusalStatus(code: Exclude<InterjectRefusalCode, 'stale_cursor'>): 404 | 409 | 422 {
  if (code === 'node_not_found') return 404;
  if (code === 'empty_text') return 422;
  return 409;
}

/**
 * AC2, AC9 — the receipt: this guidance reached the node.
 *
 * Appended by whichever path delivered it — the adapter, after a mid-turn
 * `session/prompt` resolved, or the packet assembler, once the guidance is a
 * segment in the re-assembled packet. One transaction for the batch, because a
 * partial receipt would leave the projection claiming that some of three
 * corrections arrived and the rest are still queued, which is a state nothing
 * produced.
 */
export function recordInterjectionsDelivered(options: {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly seqs: readonly EventSeq[];
  readonly epoch: number;
  readonly ts: number;
}): readonly EventSeq[] {
  if (options.seqs.length === 0) return [];

  const state = stateOf(options.db, options.runId);
  const attempt = state.nodes[options.nodeId]?.attempt ?? 0;

  return appendEvents(
    options.db,
    options.seqs.map((interjectedSeq) =>
      draft(options.runId, options.nodeId, attempt, options.ts, options.epoch, {
        kind: 'human.interjection.delivered',
        payload: { node: options.nodeId, interjectedSeq },
      }),
    ),
  );
}
