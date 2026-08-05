/**
 * KAR-05.5 — two resume strategies behind one interface, chosen from the
 * probed capability row.
 *
 * The design rule this implements is unambiguous
 * (docs/07-provider-adapter-layer.md §5.1):
 *
 * > **DeFlow's own SQLite ledger is the sole source of truth for a run.** Every
 * > prompt DeFlow sends must be reconstructible from that log alone.
 * > `session/resume` is a **token-cost optimisation**, never the durability
 * > mechanism.
 *
 * Two of the five adapters measured on 2026-08-02 do not advertise resume at
 * all, so the replay path is the durability path for 40% of the matrix — and
 * it is needed anyway for the CLI exec-shim adapter, which has no session
 * concept whatsoever. Selection therefore asks the probed row one question and
 * asks it through `canResume`, which is a reading of `capability()`. There is
 * no vendor name in this file and `test/resume-strategy.test.ts` greps it to
 * keep it that way: a "we know this one can resume" constant would be the
 * stale-matrix hazard wearing this story's clothes.
 *
 * `loadSession` is deliberately *not* consulted. It is advertised `true` by
 * every adapter probed and is semantically different — `session/load` streams
 * the entire conversation history back as `session/update` notifications while
 * `session/resume` does not — so treating it as a resume capability floods a
 * days-long run. See ./session-load.ts, which is the only module allowed to
 * mention it and refuses it above a bound.
 *
 * The second half of this file is the poisoning guard (§6.1). Session-file
 * formats and resume semantics are internal vendor details that change without
 * notice; resuming a session started under one build of a binary under a
 * different build is not a supported operation by anyone, and the failure mode
 * is not a clean error but a subtly corrupted context that poisons the rest of
 * a multi-hour run. So a drift refuses by default, asks a human, and records
 * the answer.
 */
import { NodeFailureError, type NodeId } from '@DeFlow/core';
import { type CapabilityRow, canResume } from './capabilities.ts';

/**
 * The two strategies, named as they are in the architecture doc so a ledger
 * row and §5.1 read the same.
 */
export type ResumeStrategyName = 'ResumeNative' | 'ResumeByReplay';

/**
 * `AgentNode.resume` (docs/04-domain-model.md §3): what the *plan* asked for.
 *
 * Restated here rather than imported as `AgentNode['resume']` so that this
 * module keeps no dependency on the plan schema — the value arrives from the
 * scheduler. It can only ever narrow: a node may insist on replay, and no node
 * can insist on a native resume the row does not support.
 */
export type ResumePolicy = 'native-if-available' | 'always-replay';

/**
 * The whole selection, and it reads exactly one probed answer.
 *
 * An unprobed provider (`null`) replays: "has advertised nothing" is not "can
 * resume", and the durability path is the one that is always correct.
 */
export function selectResumeStrategy(
  row: CapabilityRow | null,
  policy: ResumePolicy = 'native-if-available',
): ResumeStrategyName {
  if (policy === 'always-replay') return 'ResumeByReplay';
  if (row === null) return 'ResumeByReplay';
  return canResume(row) ? 'ResumeNative' : 'ResumeByReplay';
}

/** What `node.started` recorded about the binary, and what it reports now. */
export interface BinaryIdentity {
  /** The verbatim `--version` output. */
  readonly version: string;
  /** sha256 of the resolved entry file, 64 lowercase hex. */
  readonly sha256: string;
}

export type BinaryDriftField = 'version' | 'sha256';

/**
 * Which halves of the identity moved, in a stable order.
 *
 * Both are checked, and the sha is not redundant: a locally patched or
 * partially reinstalled binary reports the old version string while being a
 * different program, which is the case a version-only guard waves through.
 */
export function binaryDrift(
  recorded: BinaryIdentity,
  current: BinaryIdentity,
): readonly BinaryDriftField[] {
  const drift: BinaryDriftField[] = [];
  if (recorded.version !== current.version) drift.push('version');
  if (recorded.sha256 !== current.sha256) drift.push('sha256');
  return drift;
}

export const RESUME_REFUSE_OPTION_ID = 'refuse-cross-version-resume';
export const RESUME_OVERRIDE_OPTION_ID = 'resume-across-version-change';

/**
 * The operator's two answers, **refuse first**.
 *
 * The order is the default: a gate whose first option is the safe one is a
 * gate a hurried operator answers safely, and F3.6 asks for refusal by default
 * with an explicit opt-in — not for a coin toss rendered as two equal buttons.
 */
export const RESUME_GATE_OPTIONS = [
  {
    id: RESUME_REFUSE_OPTION_ID,
    label: 'Refuse the resume and restart this node from the ledger',
    effect: 'reject',
  },
  {
    id: RESUME_OVERRIDE_OPTION_ID,
    label: 'Resume anyway, accepting the risk of a corrupted context',
    effect: 'approve',
  },
] as const satisfies readonly { id: string; label: string; effect: 'approve' | 'reject' }[];

export interface CrossVersionGateInput {
  readonly node: NodeId;
  readonly recorded: BinaryIdentity;
  readonly current: BinaryIdentity;
  readonly drift: readonly BinaryDriftField[];
}

/** A short digest, so a prompt naming two sha256s stays readable. */
const short = (sha256: string): string => sha256.slice(0, 12);

function describeDrift(input: CrossVersionGateInput): string {
  const parts: string[] = [];
  if (input.drift.includes('version')) {
    parts.push(`version ${input.recorded.version} → ${input.current.version}`);
  }
  if (input.drift.includes('sha256')) {
    parts.push(`sha256 ${short(input.recorded.sha256)} → ${short(input.current.sha256)}`);
  }
  return parts.join(', ');
}

/**
 * The `human.requested` payload a refused resume writes (EPIC-05-S20).
 *
 * It names the recorded identity, the current one, and the risk — because the
 * operator answering this at 2am needs to know that the failure mode is not a
 * crash but a context that looks fine and is not.
 */
export function crossVersionGatePrompt(input: CrossVersionGateInput): {
  readonly node: NodeId;
  readonly prompt: string;
  readonly options: typeof RESUME_GATE_OPTIONS;
} {
  return {
    node: input.node,
    prompt:
      `The agent binary changed while ${input.node} was suspended (${describeDrift(input)}). ` +
      `The session was started by ${input.recorded.version} (sha256 ${short(input.recorded.sha256)}) ` +
      `and the binary resolved now is ${input.current.version} (sha256 ${short(input.current.sha256)}). ` +
      'Session-file formats and resume semantics are internal vendor details that change without ' +
      'notice, and resuming across the change is not a supported operation: the failure mode is ' +
      'not a clean error but a subtly corrupted context that poisons the rest of the run. ' +
      'DeFlow refuses by default and can restart this node from its own ledger instead.',
    options: RESUME_GATE_OPTIONS,
  };
}

/**
 * The refusal as a value (AC5).
 *
 * `provider.unavailable` and not a spawn or handshake failure: the binary that
 * started this session is no longer on this machine, and that is exactly what
 * the reason names. `gate` because no automatic action is correct — retrying
 * resumes against the same changed binary, and failing the node throws away
 * work a human might legitimately choose to keep.
 */
export function crossVersionRefusal(input: CrossVersionGateInput): NodeFailureError {
  return new NodeFailureError(
    `refusing to resume ${input.node}: the agent binary changed since node.started recorded it ` +
      `(${describeDrift(input)}). Resuming a session across a vendor build change corrupts the ` +
      'context silently; answer the operator gate to override',
    {
      reason: 'provider.unavailable',
      class: 'gate',
      detail: {
        node: input.node,
        drift: [...input.drift],
        recordedVersion: input.recorded.version,
        currentVersion: input.current.version,
        recordedSha256: input.recorded.sha256,
        currentSha256: input.current.sha256,
      },
    },
  );
}
