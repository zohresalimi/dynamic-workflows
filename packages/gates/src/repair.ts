/**
 * KAR-12.5 — the surgical repair loop's decisions
 * (docs/10-verification-gates.md §7).
 *
 * A gate failure spawns a fresh, narrowly-scoped fix node. One issue.
 * Regression test first. Capped at 3 attempts. Then escalate. This module is
 * the three decisions in that sentence, as pure functions: *which* fix nodes a
 * verdict earns, *whether* another attempt is scheduled, and *what* the
 * exhausted loop hands the operator. The packet is ./repair-packet.ts, the
 * ordering check is ./repair-ordering.ts, and the path-scope defence is
 * ./scope-gate.ts.
 *
 * Four decisions here carry the story.
 *
 * **One finding per fix node, mechanically.** *"A fix node given five findings
 * will fix two, half-fix two, and introduce a sixth."* The split is a `for`
 * loop over `verdict.findings` rather than a heuristic, and it is only possible
 * because KAR-12.3's `Finding.id` is stable across attempts: the id is a
 * function of what the finding is *about*, so `fix-a13f5c2b1e04` is the same
 * node on attempt 3 as it was on attempt 1.
 *
 * **A `needs-human` verdict produces no fix node at all.** The distinction is
 * the whole reason `needs-human` exists rather than being folded into `fail`: a
 * gate whose binary was missing has not shown the work to be wrong, and routing
 * that into a repair loop asks a fix node to repair a missing binary. It opens a
 * human node, which is the only action that can help.
 *
 * **Nothing here decides whether the patch applies.** `repairPatchesFor`
 * *proposes*; `decidePatch` (`@DeFlow/core`) rules, and it is the same door
 * every other patch goes through. That is AC8 — *"a fix needing more permission
 * is NOT auto-applied"* — and AC9: repair attempts are node attempts, so they
 * land in the churn window, and a tripped breaker short-circuits **further
 * repair patches too**. A repair loop that has become a churn loop must stop,
 * not accelerate. Both fall out of routing through the engine rather than
 * around it, which is why there is no `applyRepairPatch` in this file.
 *
 * **The cap is read, never restated.** `REPAIR_ATTEMPT_CAP` *is*
 * `DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode`. §7 says the cap matches the
 * scheduler's default, and two constants that happen to agree is a bug waiting
 * for one of them to be tuned.
 *
 * Pure: no clock, no filesystem, no database, no `Date.now()`.
 *
 * Verifies: EPIC-12-S29, EPIC-12-S30, EPIC-12-S31, EPIC-12-S32, EPIC-12-S33,
 * EPIC-12-S34 · AC1, AC2, AC5, AC6, AC7, AC11
 */
import {
  admitGates,
  DEFAULT_NO_PROGRESS_POLICY,
  type EventPayloadOf,
  FINDING_SEVERITIES,
  type Finding,
  type FindingV2,
  type GateId,
  type Handle,
  HumanRequestedSchema,
  type LadderGate,
  NodeFailureError,
  type NodeId,
  type PermissionLevel,
  type PlanPatch,
  PlanPatchSchema,
  type ProposedBy,
  type ProviderId,
  type ResumeRequest,
  toSingleLine,
  type VerdictV3,
} from '@DeFlow/core';
import { type FindingDelta, findingDelta } from './projection.ts';

/**
 * §7's cap, and the scheduler's, which are one number.
 *
 * Read from `DEFAULT_NO_PROGRESS_POLICY` rather than written as `3`. A repair
 * loop that outlived the node it was repairing — or died before the scheduler
 * was willing to stop retrying — is the failure two independent constants
 * produce the first time somebody tunes one of them, and it is invisible until
 * a run either loops four times or escalates after two.
 */
export const REPAIR_ATTEMPT_CAP = DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode;

/**
 * The domain severity at or above which a finding earns a fix node.
 *
 * `blocker`, which is what a gate's own `severityFloor: error` maps to
 * (./verdict-of.ts). Below it, §6.2's rule applies instead: the violation is
 * recorded, reaches the diff view and feeds the blast-radius estimate, and does
 * not spawn a node. A repair loop that opened a fix node per `info` finding
 * would spend the run's budget on advice.
 */
export const REPAIR_SEVERITY_FLOOR: Finding['severity'] = 'blocker';

/** Severity as a number, most severe first — `FINDING_SEVERITIES`' own order. */
const severityRank = (severity: Finding['severity']): number =>
  FINDING_SEVERITIES.indexOf(severity);

/** Whether this finding is one the floor says earns a fix node. */
export function repairable(
  finding: FindingV2,
  floor: Finding['severity'] = REPAIR_SEVERITY_FLOOR,
): boolean {
  return severityRank(finding.severity) <= severityRank(floor);
}

/**
 * `fix-<findingId>` — §7's node id, verbatim.
 *
 * The finding id is *in* the node id rather than in a field beside it because
 * the id is what everything else keys on: the worktree is
 * `.DeFlow/wt/<runId>__<nodeId>`, the branch is `DeFlow/<runId>__<nodeId>`, and
 * an operator reading either wants to know which finding they are looking at
 * without opening the plan.
 */
export function fixNodeId(finding: string): NodeId {
  return `fix-${finding}` as NodeId;
}

/** The patch id a repair proposes under. Deterministic, because one finding
 * earns exactly one fix node ever — the three attempts are attempts of that
 * node, not three patches. */
export function repairPatchId(gate: GateId, finding: string): string {
  return `repair-${gate}-${finding}`;
}

/** §7's `reason` string: `"<gate> failed: <F1.message>"`. Rendered verbatim in
 * the scrubber (F10.2), so it is the finding's own words, never a summary. */
export function repairReason(gate: GateId, message: string): string {
  return toSingleLine(`${gate} failed: ${message}`);
}

/** Why a repair went to a human instead of to a fix node. */
export type RepairHumanReason = 'gate-unverifiable' | 'no-actionable-finding';

/** One finding, the node that will repair it, and the patch that inserts it. */
export interface RepairTarget {
  readonly finding: FindingV2;
  readonly node: NodeId;
  readonly patch: PlanPatch;
}

export type RepairDecision =
  | { readonly kind: 'none'; readonly why: 'gate-passed' }
  | {
      readonly kind: 'human';
      readonly why: RepairHumanReason;
      readonly prompt: string;
      /** Whatever the gate did report, so nothing is lost on the way to a
       * person. */
      readonly findings: readonly FindingV2[];
    }
  | {
      readonly kind: 'fix';
      readonly patches: readonly PlanPatch[];
      readonly findings: readonly RepairTarget[];
      /**
       * Blocking findings with no `location` — a path the tool invented, a file
       * the attempt deleted (./anchor.ts).
       *
       * They earn no fix node, because a fix node's whole value is a *narrow*
       * write scope and there is no file to scope it to; giving one `src/**`
       * would produce exactly the wide, unaccountable node §7 exists to avoid.
       * Carried out rather than dropped so the caller escalates them.
       */
      readonly unrepairable: readonly FindingV2[];
    };

export interface RepairContext {
  /** Whose work failed — the fix node depends on it. */
  readonly evaluatedNode: NodeId;
  /** The permission level the run itself executes at. */
  readonly ambientPermission: PermissionLevel;
  /** Distance from `PlanGraph` v1, for the policy engine's replan-depth rule. */
  readonly replanDepth: number;
  /** Handles to the failing command's output — §7's *"the failing command's
   * output artifact"*, which is what the fix node reads instead of a
   * transcript. */
  readonly evidence: readonly Handle[];
  readonly proposedBy: ProposedBy;
  /** Defaults to `REPAIR_SEVERITY_FLOOR`. */
  readonly severityFloor?: Finding['severity'];
  /**
   * Where this repository keeps its tests, so the fix node may declare the
   * regression test it is required to write.
   *
   * Without it the fix node's first commit — the failing test — is an
   * undeclared write on every repair, which would make §6.2's warning fire on
   * correct behaviour and train everybody to ignore it.
   */
  readonly testScopes?: readonly string[];
  /**
   * The permission the fix node needs, when it is not the run's own.
   *
   * Supplied rather than inferred: DeFlow cannot know from a finding that its
   * repair needs the network. What it *can* guarantee is that a fix asking for
   * more than the run has goes to a human — which is `escalates-permission`'s
   * job, in the engine, not this function's.
   */
  readonly fixPermission?: PermissionLevel;
  /**
   * The providers the fix node may be routed onto, in preference order.
   *
   * Supplied rather than inherited, and required in practice: KAR-11.2's
   * `PROVIDER_NOT_PROBED` is a *blocking* plan diagnostic, so a fix node that
   * prefers nothing is a patch `commitPatchedPlan` refuses — a repair that can
   * be proposed and never applied. Which adapters are installed and healthy is
   * the scheduler's knowledge and nothing this module can derive, so it arrives
   * here.
   *
   * A preference is routing, not context: it says *where* the fix node runs,
   * never what it has read. AC6's "inherits nothing" is `resume:
   * 'always-replay'` below, and it is unaffected.
   */
  readonly fixProvider?: readonly ProviderId[];
  readonly estimatedCostDeltaUsd?: number;
  readonly estimatedWallClockDeltaMs?: number;
}

/** The three steps, in order, as the fix node's brief states them. */
function repairBrief(gate: GateId, finding: FindingV2): string {
  const where =
    finding.location === undefined ? '' : ` at ${finding.location.file}:${finding.location.line}`;
  return [
    `The ${gate} gate failed with exactly one finding (${finding.id})${where}: ${finding.message}`,
    '',
    'Do these three things, in this order, and commit between them:',
    '1. Write a test that reproduces this finding and fails because of it. Commit it alone.',
    '2. Make that test pass. Commit the fix separately.',
    '3. Stop. The gate set is re-run from the deterministic tier by DeFlow, not by you.',
    '',
    'Repair only this finding. Do not touch the gate definition, the CI configuration, a ' +
      'lockfile or any test the plan marks as a contract — those are the check, and repairing ' +
      'the check is not repairing the code.',
  ].join('\n');
}

/** The files a finding names, which are the fix node's write scope. */
const filesOf = (finding: FindingV2): readonly string[] =>
  finding.location === undefined ? [] : [finding.location.file];

/**
 * AC1, AC2 — the fix nodes a verdict earns.
 *
 * `pass` earns none and says so; `needs-human` earns none and opens a human
 * node; `fail` earns exactly one per blocking finding, in the verdict's own
 * order.
 */
export function repairPatchesFor(verdict: VerdictV3, context: RepairContext): RepairDecision {
  if (verdict.outcome === 'pass') return { kind: 'none', why: 'gate-passed' };

  if (verdict.outcome === 'needs-human') {
    return {
      kind: 'human',
      why: 'gate-unverifiable',
      prompt: toSingleLine(
        `The ${verdict.gate} gate could not answer: ${verdict.summary}. A gate whose own tooling ` +
          'failed has not shown the work to be wrong, so there is nothing for a fix node to ' +
          'repair — repairing a missing binary is not a repair.',
      ),
      findings: [...verdict.findings],
    };
  }

  const floor = context.severityFloor ?? REPAIR_SEVERITY_FLOOR;
  const blocking = verdict.findings.filter((finding) => repairable(finding, floor));
  const unrepairable = blocking.filter((finding) => filesOf(finding).length === 0);
  const targets = blocking.filter((finding) => filesOf(finding).length > 0);

  if (targets.length === 0) {
    return {
      kind: 'human',
      why: 'no-actionable-finding',
      prompt: toSingleLine(
        `The ${verdict.gate} gate failed but reported nothing at or above ${floor} that names a ` +
          `file: ${verdict.summary}. A fix node with no file to scope is a wide node, which is ` +
          'the thing the one-finding rule exists to prevent.',
      ),
      findings: [...verdict.findings],
    };
  }

  const found: RepairTarget[] = targets.map((finding) => ({
    finding,
    node: fixNodeId(finding.id),
    patch: repairPatch(verdict, finding, context),
  }));

  return {
    kind: 'fix',
    patches: found.map((target) => target.patch),
    findings: found,
    unrepairable,
  };
}

/** One `PlanPatch { op: 'insert', nodes: ['fix-<findingId>'] }`, validated. */
function repairPatch(verdict: VerdictV3, finding: FindingV2, context: RepairContext): PlanPatch {
  const files = filesOf(finding);
  const permission = context.fixPermission ?? context.ambientPermission;
  const write = [...files, ...(context.testScopes ?? [])];

  // Parsed rather than cast, so `retry`, `budget` and `returns.maxTokens`
  // arrive at their documented defaults — including `retry.maxAttempts: 3`,
  // which is the same cap this module reads for the escalation.
  return PlanPatchSchema.parse({
    schemaId: 'DeFlow.planpatch.v1',
    id: repairPatchId(verdict.gate, finding.id),
    proposedBy: context.proposedBy,
    reason: repairReason(verdict.gate, finding.message),
    ops: [
      {
        op: 'insert-nodes',
        nodes: [
          {
            id: fixNodeId(finding.id),
            title: toSingleLine(`Repair ${verdict.gate} finding ${finding.id}`),
            type: 'agent',
            deps: [context.evaluatedNode],
            lifecycle: 'active',
            reads: [
              { kind: 'spec', section: 'criteria' },
              ...context.evidence.map((handle) => ({ kind: 'artifact', handle })),
            ],
            writes: [],
            permission,
            pathScopes: { write, read: write },
            returns: { schemaId: 'DeFlow.finding.v1' },
            brief: repairBrief(verdict.gate, finding),
            provider: { prefer: [...(context.fixProvider ?? [])], requires: [] },
            // AC6, and it is not a preference: `always-replay` is the only
            // resume shape that inherits nothing. A fresh node is at turn 0,
            // which is the whole point of spawning one.
            resume: 'always-replay',
          },
        ],
        edges: [{ from: context.evaluatedNode, to: fixNodeId(finding.id), kind: 'control' }],
      },
    ],
    policy: {
      estimatedCostDeltaUsd: context.estimatedCostDeltaUsd ?? 0,
      estimatedWallClockDeltaMs: context.estimatedWallClockDeltaMs ?? 0,
      blastRadius: { paths: [...write], nodeCount: 1 },
      replanDepth: context.replanDepth,
      escalatesPermission:
        permission === context.ambientPermission
          ? null
          : { from: context.ambientPermission, to: permission },
      addsWriteCapability: permission !== 'read',
    },
  });
}

// ── AC6: the fix node inherits nothing ───────────────────────────────────────

/**
 * A repair node asked to run inside the producer's own thread.
 *
 * The `AgentNode` schema cannot express a fork — `resume` is
 * `native-if-available | always-replay` and nothing else — so the plan is safe
 * by construction. This guard is for the *adapter-level* resume request, which
 * is a different shape reaching a different layer, and it fails closed for the
 * reason KAR-12.2's equivalent does: a repair inside the producing session is
 * asking the session that wrote the bug to disagree with itself, and the
 * measured cost is in §7 — omission compliance fell from 73% at turn 5 to 33%
 * at turn 16 while commission compliance held at 100%, which is an asymmetry
 * ordinary monitoring cannot see.
 */
export class RepairContextNotFresh extends NodeFailureError {
  readonly node: NodeId;
  readonly producer: NodeId;

  constructor(node: NodeId, producer: NodeId, resume: unknown) {
    super(
      `repair node ${node} asks to resume ${JSON.stringify(resume)}, which puts it inside ` +
        `producer node ${producer}'s thread. Fresh context is not optional for a repair: the ` +
        'producing session has already committed to the reasoning that produced the bug, and it ' +
        'is the session most likely to have compacted away the constraint the bug violates',
      {
        reason: 'gate.failed',
        class: 'gate',
        detail: { code: 'REPAIR_INHERITS_PRODUCER_CONTEXT', node, producer },
      },
    );
    this.name = 'RepairContextNotFresh';
    this.node = node;
    this.producer = producer;
  }

  get failureClass(): 'gate' {
    return 'gate';
  }
}

/** Whether the resume shape hands the producer's own thread to the repair. */
function inheritsFrom(resume: ResumeRequest | undefined, producer: NodeId): boolean {
  if (resume === undefined || typeof resume === 'string') return false;
  return resume.kind === 'fork' || resume.of === producer;
}

/** AC6 — refuses a repair that would resume or fork the producer. */
export function assertFreshRepairContext(
  node: { readonly id: NodeId; readonly resume?: ResumeRequest },
  producer: NodeId,
): void {
  if (inheritsFrom(node.resume, producer)) {
    throw new RepairContextNotFresh(node.id, producer, node.resume);
  }
}

// ── AC7: three attempts, then a human ────────────────────────────────────────

/** One completed repair attempt, as the loop remembers it. */
export interface RepairAttempt {
  /** 1-based, matching the number a person would say out loud. */
  readonly attempt: number;
  /** The diff this attempt produced. */
  readonly diff: Handle;
  /** The verdict the re-run gate returned, as stored. */
  readonly verdictHandle: Handle;
  /** The same verdict, in hand — what the next packet renders as findings. */
  readonly verdict: VerdictV3;
}

export interface RepairNextInput {
  readonly node: NodeId;
  readonly gate: GateId;
  /** The `Finding.id` this loop is repairing. */
  readonly finding: string;
  /** Every attempt that has already failed, in order. */
  readonly attempts: readonly RepairAttempt[];
}

export type RepairNext =
  | { readonly kind: 'attempt'; readonly attempt: number }
  | { readonly kind: 'escalate'; readonly request: EventPayloadOf<'human.requested'> };

/**
 * AC7 — the next thing the loop does: one more attempt, or a human.
 *
 * The comparison is `attempts.length >= REPAIR_ATTEMPT_CAP`, so the third
 * failure escalates and there is no fourth. Stating it against the cap rather
 * than against a literal is what EPIC-12-S32's third scenario asks for: change
 * `maxAttemptsPerNode` and this moves with it, which is the only way two caps
 * that are meant to be one number stay one number.
 */
export function repairNext(input: RepairNextInput): RepairNext {
  if (input.attempts.length < REPAIR_ATTEMPT_CAP) {
    return { kind: 'attempt', attempt: input.attempts.length + 1 };
  }

  return {
    kind: 'escalate',
    request: HumanRequestedSchema.parse({
      node: input.node,
      prompt: toSingleLine(
        `The ${input.gate} gate still fails on finding ${input.finding} after ` +
          `${input.attempts.length} repair attempts. Every attempt's diff and verdict is ` +
          'attached. A fourth attempt is not scheduled: a repair loop that has not converged in ' +
          'three is not one more attempt away from converging.',
      ),
      options: [
        { id: 'retry', label: 'Try once more with guidance', effect: 'inject' },
        { id: 'edit', label: 'Fix it myself', effect: 'edit' },
        { id: 'abandon', label: 'Abandon this branch', effect: 'reject' },
      ],
      repair: {
        gate: input.gate,
        finding: input.finding,
        attempts: input.attempts.map((attempt) => ({
          attempt: attempt.attempt,
          diff: attempt.diff,
          verdict: attempt.verdictHandle,
        })),
      },
    }),
  };
}

// ── AC11: what the diff view reads ───────────────────────────────────────────

/** One attempt, ready to render: its diff, its verdict and what it changed. */
export interface RepairAttemptRecord {
  readonly attempt: number;
  readonly diff: Handle;
  readonly verdict: Handle;
  readonly outcome: VerdictV3['outcome'];
  /** `fixed`, `introduced`, `remaining`, by stable `Finding.id`. */
  readonly delta: FindingDelta;
}

/**
 * AC11 — every attempt's diff, verdict and finding-id delta, precomputed.
 *
 * *"so the diff view can show 'attempt 2 fixed `a13f…` and introduced `9c02…`'
 * without recomputation."* The delta is against the previous attempt's
 * findings, and — for attempt 1 — against `before`, the ids the gate reported
 * when it failed. Without `before`, attempt 1 would always read as having
 * introduced everything it left behind and fixed nothing, which is the exact
 * opposite of what happened when it fixed two of three.
 */
export function repairAttemptProjection(
  attempts: readonly RepairAttempt[],
  before: readonly string[] = [],
): readonly RepairAttemptRecord[] {
  let previous = before;
  const records: RepairAttemptRecord[] = [];

  for (const attempt of attempts) {
    const current = attempt.verdict.findings.map((finding) => finding.id);
    records.push({
      attempt: attempt.attempt,
      diff: attempt.diff,
      verdict: attempt.verdictHandle,
      outcome: attempt.verdict.outcome,
      delta: findingDelta(previous, current),
    });
    previous = current;
  }

  return records;
}

// ── AC5: the re-run starts at the bottom of the ladder ───────────────────────

/**
 * AC5 — the gates to schedule once a fix node completes: the **deterministic
 * tier**, with every earlier outcome discarded.
 *
 * *"a fix that breaks typecheck is caught before the review is paid for
 * again."* Re-running from the failed gate is the natural implementation and it
 * is wrong in both directions: the new regression test is part of the
 * deterministic tier, so "fixed" would be asserted rather than demonstrated,
 * and a fix that broke a gate that had already passed would not be noticed
 * until the adversarial review had been bought.
 *
 * Expressed as `admitGates` against an empty outcome map rather than as a
 * filter on `kind`, so there is exactly one implementation of "which tier opens
 * next" in the system (`@DeFlow/core`'s ./gate-ladder.ts). Two orderings is how
 * the scheduler and the runner come to disagree about which gate ran first.
 */
export function gatesAfterRepair(gates: readonly LadderGate[]): readonly LadderGate[] {
  return admitGates(gates, new Map());
}
