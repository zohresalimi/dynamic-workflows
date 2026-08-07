/**
 * KAR-05.5 — resuming one node, from the ledger and the probed row.
 *
 * The order of the four steps is the story, and each one is a refusal point
 * before the previous one's cost is spent:
 *
 * 1. **Read what the previous life recorded.** `node.started` for the binary
 *    it ran, the journalled `sessionId`, and `context.built` for the packet.
 *    Nothing about the resume consults a vendor session file or a vendor API;
 *    if the ledger cannot answer, the resume does not happen.
 * 2. **Check the binary identity** (§6.1). A changed `version` or
 *    `binary_sha256` refuses by default with a typed failure and an operator
 *    prompt, because resuming across a vendor build change does not fail
 *    cleanly — it produces a subtly corrupted context that poisons the rest of
 *    the run. An explicit opt-in proceeds and is recorded.
 * 3. **Select the strategy from the probed row** — and only from it.
 * 4. **Run the same turn either way.** `runAcpNode` does the work; the two
 *    strategies differ in one frame (`session/resume` vs `session/new`) and in
 *    one prompt (a short continuation vs the packet rebuilt from the ledger).
 *    The observable node outcome is the same; the token cost is not, and that
 *    difference is written to the ledger as `budget.consumed` rather than left
 *    to be inferred — by `runAcpNode`, which writes exactly one such record
 *    per node attempt (KAR-14.1 AC1), so the two strategies are compared on
 *    the same ledger rows as every other node rather than on a second record
 *    only resumed nodes have.
 */
import type { EventSeq, NodeFailure, NodeId } from '@DeFlow/core';
import { toAdapterFailure } from './failures.ts';
import type { AcpNodeRequest, AcpPorts, EventRecord } from './ports.ts';
import type { LedgerEventRow, PacketSources } from './replay-packet.ts';
import { reconstructPacket } from './replay-packet.ts';
import {
  type BinaryIdentity,
  binaryDrift,
  crossVersionGatePrompt,
  crossVersionRefusal,
  RESUME_OVERRIDE_OPTION_ID,
  type ResumePolicy,
  type ResumeStrategyName,
  selectResumeStrategy,
} from './resume.ts';
import { type AcpNodeOutcome, runAcpNode } from './run-node.ts';

/**
 * What DeFlow says after `session/resume`.
 *
 * Short by construction: the agent still holds the context, and re-sending the
 * packet would spend the tokens the native path exists to save. It carries no
 * instruction of its own — the node's work was already described in the packet
 * the session was opened with, and inventing a second description here is how
 * a resumed node quietly starts doing something else.
 */
export const DEFAULT_CONTINUATION =
  'Continue the task from where the session left off. Your context is intact; ' +
  'do not restart work that is already done.';

export interface ResumeOverride {
  /** The option the operator chose, from `RESUME_GATE_OPTIONS`. */
  readonly optionId: string;
  /** ISO-8601, display only — ordering is by `seq`. */
  readonly at: string;
}

export type ResumeNodeRequest = Omit<AcpNodeRequest, 'prompt' | 'resume'> & {
  /** What a native resume sends instead of the packet. */
  readonly continuation?: string;
  /** `AgentNode.resume`. A node may insist on replay; none can insist on native. */
  readonly policy?: ResumePolicy;
  /** F3.6's explicit opt-in, as the operator answered the gate. */
  readonly override?: ResumeOverride;
};

export interface ResumePorts extends AcpPorts {
  /** Every control-plane row of this run, oldest first. */
  readonly history: () => Promise<readonly LedgerEventRow[]>;
  /** Segment bytes by `contentHash`, out of DeFlow's own store. */
  readonly readSegmentText: PacketSources['readSegmentText'];
}

export type ResumeNodeOutcome =
  | {
      readonly status: 'refused';
      readonly strategy: null;
      readonly failure: NodeFailure;
    }
  | (AcpNodeOutcome & { readonly strategy: ResumeStrategyName });

/** The binary `node.started` recorded for this node and attempt, if any. */
function recordedBinary(
  history: readonly LedgerEventRow[],
  target: { nodeId: NodeId; attempt: number },
): BinaryIdentity | null {
  const rows = history.filter((row) => {
    if (row.kind !== 'node.started') return false;
    const payload = row.payload as { node?: unknown; attempt?: unknown };
    return payload.node === target.nodeId && payload.attempt === target.attempt;
  });
  const binary = (rows.at(-1)?.payload as { binary?: BinaryIdentity } | undefined)?.binary;
  return binary === undefined ? null : { version: binary.version, sha256: binary.sha256 };
}

/**
 * The session id the previous life journalled, read back out of the
 * `session.opened` progress row.
 *
 * That row is written the instant `session/new` answers and before any update
 * can refer to the session (KAR-05.1 AC3) — which is exactly why it, and not
 * an in-memory handle, is what a resume reads.
 */
const SESSION_OPENED_PREFIX = 'sessionId=';

function journalledSessionId(
  history: readonly LedgerEventRow[],
  target: { nodeId: NodeId; attempt: number },
): string | null {
  for (const row of history.toReversed()) {
    if (row.kind !== 'node.progress') continue;
    const payload = row.payload as {
      node?: unknown;
      attempt?: unknown;
      phase?: unknown;
      message?: unknown;
    };
    if (payload.node !== target.nodeId || payload.attempt !== target.attempt) continue;
    if (payload.phase !== 'session.opened') continue;
    const message = typeof payload.message === 'string' ? payload.message : '';
    if (message.startsWith(SESSION_OPENED_PREFIX)) {
      return message.slice(SESSION_OPENED_PREFIX.length);
    }
  }
  return null;
}

export async function resumeAcpNode(
  request: ResumeNodeRequest,
  ports: ResumePorts,
): Promise<ResumeNodeOutcome> {
  const { clock, ledger } = ports;
  const target = { nodeId: request.nodeId, attempt: request.attempt };

  const event = (kind: string, payload: unknown): EventRecord => ({
    kind,
    v: 1,
    ts: clock.now(),
    nodeId: request.nodeId,
    attempt: request.attempt,
    payload,
  });

  const history = await ports.history();
  let lastSeq: EventSeq = (history.at(-1)?.seq ?? 0) as EventSeq;

  // ── 1. the poisoning guard, before anything is spawned ────────────────────
  const recorded = recordedBinary(history, target);
  const current: BinaryIdentity = {
    version: request.binary.version,
    sha256: request.binary.sha256,
  };
  const drift = recorded === null ? [] : binaryDrift(recorded, current);

  if (recorded !== null && drift.length > 0) {
    const gate = { node: request.nodeId, recorded, current, drift };
    if (request.override?.optionId !== RESUME_OVERRIDE_OPTION_ID) {
      // Refuse, ask, and suspend — in that order, so the run's own log
      // explains the pause before anything reads the node as stuck.
      const refusal = crossVersionRefusal(gate);
      lastSeq = await ledger.append(event('human.requested', crossVersionGatePrompt(gate)));
      const failure = toAdapterFailure(refusal, {
        occurredAtEvent: lastSeq,
        attempt: request.attempt,
        captureEvidence: ports.captureEvidence,
      });
      await ledger.append(
        event('node.progress', {
          node: request.nodeId,
          attempt: request.attempt,
          phase: 'resume.refused',
          message: failure.message,
        }),
      );
      await ledger.append(
        event('node.suspended', { node: request.nodeId, until: { kind: 'human' } }),
      );
      return { status: 'refused', strategy: null, failure };
    }

    // The opt-in, recorded twice on purpose: `human.responded` is the decision,
    // and the progress row is what the run header reads without replaying the
    // human-gate machinery.
    lastSeq = await ledger.append(
      event('human.responded', {
        node: request.nodeId,
        optionId: request.override.optionId,
        text: `cross-version resume permitted: ${recorded.version} → ${current.version}`,
        at: request.override.at,
      }),
    );
    lastSeq = await ledger.append(
      event('node.progress', {
        node: request.nodeId,
        attempt: request.attempt,
        phase: 'resume.cross-version-permitted',
        message:
          `resuming a session started by ${recorded.version} under ${current.version} ` +
          `(${drift.join(', ')} changed), by explicit operator override`,
      }),
    );
  }

  // ── 2. the strategy, from the probed row and from nothing else ────────────
  const sessionId = journalledSessionId(history, target);
  const selected = selectResumeStrategy(ports.capabilityRow ?? null, request.policy);
  // A native resume with no journalled session id is not a resume: the agent
  // produced no durable state to return to, so a clean replay is both correct
  // and the only thing available (docs/05-durable-execution.md §8.3).
  const strategy: ResumeStrategyName =
    selected === 'ResumeNative' && sessionId === null ? 'ResumeByReplay' : selected;

  // ── 3. the prompt each strategy sends ─────────────────────────────────────
  let prompt: string;
  if (strategy === 'ResumeNative') {
    prompt = request.continuation ?? DEFAULT_CONTINUATION;
  } else {
    try {
      prompt = (await reconstructPacket(history, target, ports)).prompt;
    } catch (thrown) {
      const failure = toAdapterFailure(thrown, {
        occurredAtEvent: lastSeq,
        attempt: request.attempt,
        captureEvidence: ports.captureEvidence,
      });
      await ledger.append(
        event('node.failed', { node: request.nodeId, attempt: request.attempt, failure }),
      );
      return { status: 'refused', strategy: null, failure };
    }
  }

  await ledger.append(
    event('node.progress', {
      node: request.nodeId,
      attempt: request.attempt,
      phase: strategy === 'ResumeNative' ? 'resume.native' : 'resume.replay',
      message:
        strategy === 'ResumeNative'
          ? `session/resume on ${sessionId ?? ''}, context not re-sent`
          : 'session/new with the packet rebuilt from the ledger',
    }),
  );

  // ── 4. the same turn, either way ──────────────────────────────────────────
  const outcome = await runAcpNode(
    {
      ...request,
      prompt,
      ...(strategy === 'ResumeNative' && sessionId !== null ? { resume: { sessionId } } : {}),
    },
    ports,
  );

  // KAR-05.5 AC4 — the difference between the two strategies is token cost,
  // and it is recorded rather than reasoned about. The record itself is
  // `runAcpNode`'s, not this function's: KAR-14.1 makes `budget.consumed` the
  // single accounting record, one per node attempt, written in the same
  // transaction as the event that ends the attempt. A second one here would
  // double every resumed node's spend in the rollup — silently, and only ever
  // after a restart, which is the hardest place to notice a wrong number.
  return { ...outcome, strategy };
}
