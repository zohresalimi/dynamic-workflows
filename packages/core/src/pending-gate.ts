/**
 * KAR-19.12 AC1, AC5 — the one reader of *"is this run waiting on a person, and
 * on what"*.
 *
 * On 2026-08-14 a run reached its F1.3 gate, offered four options, and every
 * surface an operator could ask went quiet about it: the terminal printed the
 * rendered spec with no sentence saying the run had stopped, `deflow status`
 * printed the status word, and the run list printed *needs a decision* with
 * nothing to decide on. Each of those is a different rendering, and none of them
 * is a different *fact* — so the fact is produced here, once, and rendered
 * there.
 *
 * The shape is deliberately the same discipline `run-status-label.ts` records:
 * a function of the projection and of nothing else. No clock, no database, no
 * option set matched by hand — `state.humanGates` is already the reducer's fold
 * of `human.requested`/`human.responded`, and a second walk of the log to answer
 * the same question is how two surfaces come to disagree about an answered gate.
 *
 * Verifies: EPIC-19-S79, EPIC-19-S82 · KAR-19.12 AC1, AC5
 */
import type { HumanGateState } from './human-gate.ts';
import { openHumanGates } from './human-gate.ts';
import type { NodeId } from './ids.ts';
import type { RunState } from './run-state.ts';
import { SPEC_GATE_NODE } from './spec-approval.ts';

/** One option a gate offers, as a surface renders it: an id to send back and a
 * sentence to read. The `effect` stays out — it is DeFlow's own vocabulary about
 * what happens to the node, and the operator is choosing between sentences. */
export interface PendingGateOption {
  readonly id: string;
  readonly label: string;
}

/** The gate a run has stopped on, and everything a surface needs to say so. */
export interface PendingGate {
  readonly node: NodeId;
  /** What the gate asked, verbatim from `human.requested`. */
  readonly prompt: string;
  readonly options: readonly PendingGateOption[];
  /** The `seq` of the `human.requested` that opened it — F10.3's deep link. */
  readonly requestedSeq: number;
  /**
   * Whether this is the run's F1.3 spec-approval gate.
   *
   * Carried rather than left for each caller to compare against
   * `SPEC_GATE_NODE`, because two of them route an answer differently on it —
   * the four spec endpoints against `nodes/:nodeId/respond` — and a comparison
   * written twice is a comparison that can be written wrong once.
   */
  readonly specApproval: boolean;
  /**
   * Why the safety layer escalated, for a permission gate; `null` otherwise.
   *
   * Typed off `HumanGateState` rather than off `PermissionReason` directly:
   * the projection's own field is what this carries, verbatim, and a second
   * spelling of its type is a second thing to keep true.
   */
  readonly reason: HumanGateState['reason'];
}

/**
 * The gate this run is waiting on, oldest first, or `null` for a run that is
 * not waiting on anybody.
 *
 * Oldest rather than newest: a run can hold more than one open gate, and the
 * one that has been waiting longest is the one blocking the most work. A
 * surface that needs all of them still has `openHumanGates`; what this answers
 * is *"what do I tell the operator right now"*, which is one thing.
 */
export function pendingGate(state: RunState): PendingGate | null {
  const [open] = openHumanGates(state);
  if (open === undefined) return null;
  return {
    node: open.node,
    prompt: open.prompt,
    options: open.options.map((option) => ({ id: option.id, label: option.label })),
    requestedSeq: open.requestedSeq,
    specApproval: open.node === SPEC_GATE_NODE,
    reason: open.reason,
  };
}

/**
 * The one sentence a surface prints beside a run to say what it is waiting on.
 *
 * Produced here for the reason `runStatusLabel` is: `deflow status`, the run
 * list and the run API all have to say it, and three defensible local wordings
 * of one fact is the failure KAR-19.1 AC6 already paid for once. The run's
 * *status* word is not repeated here — that is `runStatusLabel`'s and this sits
 * beside it, because the whole point of AC5 is that a `running` run can be
 * waiting on somebody and the status word cannot carry it.
 */
export function pendingGateSummary(gate: PendingGate): string {
  const options = gate.options.map((option) => option.id).join(', ');
  return options === ''
    ? `waiting on the '${gate.node}' gate`
    : `waiting on the '${gate.node}' gate — ${options}`;
}
