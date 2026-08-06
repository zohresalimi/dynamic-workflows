/**
 * KAR-06.4 — the `agent` probe: the good case, and the one place a vendor
 * capability decides recovery (docs/05-durable-execution.md §8.3).
 *
 * Two facts arrive from elsewhere and this module only reads them:
 *
 * 1. **The journalled session id.** `runAcpNode` appends it as its own
 *    `node.progress { phase: 'session.opened' }` event the instant the first
 *    frame carries it, never buffered — a buffered session id is a session id
 *    you lose in exactly the crash where you needed it (AC2). `readSessionId`
 *    below is the reader for that event.
 * 2. **What the adapter advertises.** `session.resume` was advertised by
 *    claude, codex and opencode and **not** by copilot or gemini when the five
 *    were measured on 2026-08-02. Two of five cannot resume at all.
 *
 * The rule those two produce is §5.1's, and it is the opposite of what a
 * durability story usually looks like: **`session/resume` is a token-cost
 * optimisation, never the durability mechanism.** The ledger is the durability
 * mechanism, and it can always reconstruct the prompt — which is why this
 * probe has no `unknown` answer to give. An adapter that cannot resume makes a
 * crashed node cost more, not mean less.
 *
 * Verifies: EPIC-06-S12 (agent rows) · AC2, AC3
 */
import type { CapabilityRow, ResumePolicy, ResumeStrategyName } from '@DeFlow/adapters';
import { selectResumeStrategy } from '@DeFlow/adapters';
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { readRange } from '@DeFlow/ledger';

/** The phase `runAcpNode` stamps on the event that carries the session id. */
export const SESSION_OPENED_PHASE = 'session.opened';

/** The phase a reconciled agent node records its resume strategy under. */
export const RESUME_PHASE = 'resume';

const SESSION_ID_PREFIX = 'sessionId=';

export interface AgentReconcileInput {
  /**
   * Whether the turn this effect covers reached its stop frame.
   *
   * A completed turn is `done` whatever the adapter can do — there is nothing
   * out there left to resume.
   */
  readonly turn: 'complete' | 'incomplete';
  /** From the ledger, or `null` when the agent died before advertising one. */
  readonly sessionId: string | null;
  /** The probed manifest row, or `null` when this provider was never probed. */
  readonly capabilities: CapabilityRow | null;
  /** What the *plan* asked for. It can only ever narrow. */
  readonly policy?: ResumePolicy;
}

export interface AgentReconcileOutcome {
  /**
   * `done` means the session out there is usable and this effect need not
   * re-establish one; `not-started` means a clean start is both safe and
   * necessary. There is deliberately no third answer.
   */
  readonly verdict: 'done' | 'not-started';
  readonly strategy: 'none' | ResumeStrategyName;
  readonly sessionId: string | null;
}

export function reconcileAgent(input: AgentReconcileInput): AgentReconcileOutcome {
  if (input.turn === 'complete') {
    return { verdict: 'done', strategy: 'none', sessionId: input.sessionId };
  }

  // No session id was ever journalled: the agent produced no durable state on
  // its side, so a clean restart is safe by construction and the capability
  // row is not even consulted.
  if (input.sessionId === null) {
    return { verdict: 'not-started', strategy: 'ResumeByReplay', sessionId: null };
  }

  const strategy = selectResumeStrategy(input.capabilities, input.policy ?? 'native-if-available');

  return strategy === 'ResumeNative'
    ? { verdict: 'done', strategy, sessionId: input.sessionId }
    : { verdict: 'not-started', strategy, sessionId: input.sessionId };
}

export interface SessionIdQuery {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
}

/**
 * The session id a previous daemon life journalled for this node attempt, or
 * `null` (AC2).
 *
 * Read out of the `event` table and nowhere else. A vendor session file on
 * disk would be the other candidate and is not one: its format is an internal
 * detail that changes without notice, and the claim being made here is about
 * what *DeFlow* recorded, which is the only thing that survived the crash by
 * design rather than by luck.
 */
export function readSessionId(db: Db, query: SessionIdQuery): string | null {
  let cursor = 0;
  let found: string | null = null;

  for (;;) {
    const page = readRange(db, query.runId, cursor, 500);
    for (const event of page.events) {
      cursor = event.seq;
      if (event.kind !== 'node.progress') continue;
      if (event.nodeId !== query.nodeId || event.attempt !== query.attempt) continue;

      const payload = event.payload as { phase?: unknown; message?: unknown };
      if (payload.phase !== SESSION_OPENED_PHASE) continue;
      if (typeof payload.message !== 'string') continue;
      if (!payload.message.startsWith(SESSION_ID_PREFIX)) continue;

      // The last one wins: a node that opened a session, died and opened
      // another has two, and the live one is the newer.
      found = payload.message.slice(SESSION_ID_PREFIX.length);
    }
    if (!page.hasMore) return found;
  }
}

export interface ResumeProgress {
  readonly node: NodeId;
  readonly attempt: number;
  readonly phase: string;
  readonly message: string;
}

/**
 * The `node.progress` payload that makes the cost of a replay visible (AC3).
 *
 * A node that restarts from scratch on copilot or gemini re-sends its whole
 * context, and that is real money on a nine-hour run. Recording which strategy
 * was taken — as an event, in the timeline, next to the restart it explains —
 * is what turns "this run cost more than the last one" into a question with an
 * answer.
 */
export function resumeProgress(input: {
  readonly node: NodeId;
  readonly attempt: number;
  readonly strategy: ResumeStrategyName;
  readonly sessionId: string | null;
}): ResumeProgress {
  const replay = input.strategy === 'ResumeByReplay';
  return {
    node: input.node,
    attempt: input.attempt,
    phase: RESUME_PHASE,
    message:
      `resumeStrategy: ${replay ? 'replay' : 'native'} (${input.strategy}) ` +
      (replay
        ? 'the context packet is re-sent from the ledger'
        : `session ${input.sessionId ?? 'unknown'} is resumed in place`),
  };
}
