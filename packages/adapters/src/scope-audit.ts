/**
 * KAR-08.7 AC3, AC5 — the completion-time scope backstop, at the one moment it
 * can run: after the agent has stopped writing and before DeFlow says the node
 * is done.
 *
 * The *decision* is not here and cannot be: answering "what changed in this
 * worktree" means spawning `git`, and `packages/daemon/src/git/run-git.ts` is
 * the only place in DeFlow allowed to do that (docs/09-workspace-and-safety.md
 * §11.4, enforced by test/one-kill-site.test.ts). So the daemon supplies a
 * `ScopeAudit` and this module owns the two things the daemon cannot own from
 * over there: **when** the check runs, and **what** the ledger ends up holding
 * because of it.
 *
 * That split is the whole point of the file existing at all. A backstop that
 * lives in a well-tested module nobody calls is not a backstop — it is a
 * library — and the write it exists to catch (an allowlisted `terminal/create`
 * command, or a vendor that never populates `ToolCallLocation`) is precisely
 * the one no request-time check ever saw. `test/scope-audit-chokepoint.test.ts`
 * is what keeps a future node runner from appending `node.completed` without
 * coming through here.
 *
 * A **warning**, never a gate (D14, §6.3): the node completes, no gate is
 * created, and `git merge-tree --write-tree` remains the only thing a merge
 * depends on. Declared scope is a prediction; this is the record of the
 * prediction failing to hold.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5
 */
import { type Clock, type EventPayloadOf, NodeFailureError, type NodeId } from '@DeFlow/core';
import type { LedgerSink } from './ports.ts';

/** The `node.scope_warning` payload, as @DeFlow/core's schema defines it —
 * never a shape this package invented, because the daemon writes it and the
 * inspector reads it. */
export type NodeScopeWarning = EventPayloadOf<'node.scope_warning'>;

/** What the auditor is asked about: one node's attempt, its worktree, and the
 * globs the plan declared for it. */
export interface ScopeAuditRequest {
  readonly node: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly worktree: string;
  /** The node's declared write globs, verbatim. Never empty — the caller
   * skips the audit entirely for a node that declared nothing. */
  readonly declared: readonly string[];
  /**
   * KAR-23.11 — the commit the worktree was provisioned from, so
   * `commitsAhead` below can be counted.
   *
   * Optional, and the optionality is honest rather than convenient: a caller
   * that cannot resolve the base (a scene with no git at all) leaves it out and
   * gets `commitsAhead: 0`, which is what `git status` alone can prove.
   */
  readonly baseOid?: string | undefined;
}

/**
 * What one attempt actually left in its worktree.
 *
 * The diff was already being computed for the scope check; before KAR-23.11 the
 * half that answers *"did this node do anything at all"* was computed and
 * thrown away.
 */
export interface ScopeAuditResult {
  /** Every changed, renamed or untracked path, worktree-relative. */
  readonly changed: readonly string[];
  /**
   * Commits on this node's branch since `baseOid`.
   *
   * Not redundant with `changed`, and this is the sentence that keeps the
   * work-product check from being a false-positive machine: DeFlow's model is
   * that a node's work sits **dirty** and is salvage-committed at teardown, so
   * `git status` is normally the whole answer — but an agent that commits its
   * own work leaves a *clean* status, and failing that node would be the worst
   * outcome available. `0` when no `baseOid` was supplied.
   */
  readonly commitsAhead: number;
  /** The out-of-scope warning, or `null` when every change stayed inside. */
  readonly warning: NodeScopeWarning | null;
}

/**
 * Diffs the worktree and reports what it holds: what changed, how many commits
 * it is ahead, and the warning its changes deserve.
 *
 * A port, for the reason every port in ./ports.ts is one: the implementation
 * spawns `git` and lives in @DeFlow/daemon (`services/scope-diff.ts`), and
 * this package depends on @DeFlow/core alone (docs/16-repo-layout.md R2).
 */
export type ScopeAudit = (request: ScopeAuditRequest) => Promise<ScopeAuditResult>;

/** What the audit needs of the world, which is the clock and the ledger the
 * node runner already has. */
export interface ScopeAuditPorts {
  readonly clock: Clock;
  readonly ledger: LedgerSink;
  readonly scopeAudit?: ScopeAudit;
}

/** The node the audit is about, as the runner knows it. */
export interface ScopeAuditSubject {
  readonly node: NodeId;
  readonly attempt: number;
  readonly worktree: string;
  /** `AcpNodeRequest.pathScope`. Absent for a node that declared none. */
  readonly declared: readonly string[] | undefined;
  /** KAR-23.11 — the commit the worktree was provisioned from. */
  readonly baseOid?: string | undefined;
  /** KAR-23.11 — how many artifacts the turn produced. Recorded in the
   * failure's `detail` so the record is complete; **never** consulted by the
   * predicate. See {@link workProductRefusal}. */
  readonly artifacts?: number | undefined;
}

/** What `auditCompletionScope` answers with: the warning it filed, and the
 * refusal the runner must act on before it completes the node. */
export interface CompletionAudit {
  readonly warning: NodeScopeWarning | null;
  /**
   * KAR-23.11's verdict, or `null` when the node left evidence of work.
   *
   * **Returned rather than thrown**, which keeps this module's *"the decision
   * is not here"* posture: the runner owns what a failure costs (a
   * `budget.consumed` in the same transaction, its own outcome shape), and a
   * returned value makes *ignoring* it a visible act a chokepoint test can
   * forbid. A throw from inside a backstop would also unwind past the very
   * completion transaction it exists to guard.
   */
  readonly refusal: NodeFailureError | null;
}

/**
 * KAR-23.11 — the honesty check: a node that promised to change files and
 * changed none.
 *
 * **The rule.** A node whose plan-declared `pathScopes.write` is non-empty must,
 * at the moment its turn ends cleanly, have left at least one changed, renamed
 * or untracked path **or** at least one commit on its branch since the commit
 * it was provisioned from. If neither, the attempt is a `node.failed`.
 *
 * **Derived from the node's own declared contract**, and from nothing else.
 * `pathScopes.write` is F5.3's positive statement — *"you may write these
 * paths"* — which is the plan asserting that this node changes files. It is the
 * same predicate that already forces a scope auditor to be wired
 * ({@link scopeAuditRefusal}: *"a declared scope with nothing behind it reads
 * exactly like an agent that behaved"*). This is the mirror sentence: a declared
 * scope with nothing **in** it reads exactly like an agent that behaved.
 *
 * **A legitimately-empty node is never asked.** A reviewer, a verification
 * agent, a node that only returns a document declares `pathScopes.write: []`,
 * and {@link auditCompletionScope} returns early for exactly that — no new code
 * path, no exemption to maintain. The planner packet's `plan-rules` brief states
 * that as a plan-authoring rule up front, which is what converts the one
 * realistic false-positive class (an idempotent write node that finds nothing to
 * do) into something the planner is told before it costs a turn.
 *
 * **Two exemptions considered and rejected.** A `permission: 'read'` node with a
 * non-empty write scope is *structurally* incapable of the work the plan
 * promised, so failing it blames the right thing and exempting it would reopen
 * the defect through a second door. And a non-empty `artifacts` array does not
 * exonerate: on both routes `artifacts` is transcript spillage — oversized tool
 * results plus the turn's own text when that spilled — so a chatty agent whose
 * apology crossed `OUTPUT_INLINE_LIMIT_BYTES` would launder an empty node. The
 * predicate keys on the diff, which is the only evidence of *work*; the artifact
 * count travels in `detail` so the record is still complete.
 *
 * `permanent` rather than `transient`: an agent that ran twenty-two minutes and
 * wrote nothing writes nothing again, and re-running four of them is
 * eighty-eight minutes for the same zero. The repair is a replan or a human, and
 * a permanent failure reaches both.
 */
export function workProductRefusal(
  subject: ScopeAuditSubject,
  audit: ScopeAuditResult,
): NodeFailureError | null {
  const declared = subject.declared;
  if (declared === undefined || declared.length === 0) return null;
  if (audit.changed.length > 0 || audit.commitsAhead > 0) return null;
  return new NodeFailureError(
    `node '${subject.node}' declared write scope ${declared.join(', ')} and finished its turn ` +
      'having changed no file and made no commit in its worktree: DeFlow records what a node ' +
      'produced, not what it said it did',
    {
      reason: 'contract.no-work-product',
      class: 'permanent',
      detail: {
        declared: [...declared],
        changed: audit.changed.length,
        commitsAhead: audit.commitsAhead,
        artifacts: subject.artifacts ?? 0,
      },
    },
  );
}

/**
 * Refuses, **before a process exists**, a node that declares a path scope with
 * no auditor behind it.
 *
 * The alternative is the failure mode this story was repaired for: a node that
 * declares `src/**`, writes wherever it likes, completes cleanly, and produces
 * no warning — because the backstop was never wired, which is indistinguishable
 * from an agent that behaved. Refusing at the top of the turn is how
 * `run-node.ts` already treats an impossible frame cap and a moving recording
 * key: DeFlow's own misconfiguration, found before a quota is spent rather than
 * an hour in.
 *
 * `internal`/`permanent` for that reason — nothing the agent did, and nothing
 * that fixes itself on the next attempt.
 */
export function scopeAuditRefusal(
  declared: readonly string[] | undefined,
  audit: ScopeAudit | undefined,
): NodeFailureError | null {
  if (declared === undefined || declared.length === 0) return null;
  if (audit !== undefined) return null;
  return new NodeFailureError(
    `the node declares a path scope (${declared.join(', ')}) but no scope auditor is wired, so ` +
      'the completion-time backstop of KAR-08.7 AC3 could never fire. A declared scope with ' +
      'nothing behind it reads exactly like an agent that behaved, so DeFlow refuses the node ' +
      'rather than completing it with a check that does not exist.',
    { reason: 'internal', class: 'permanent', detail: { declared: [...declared] } },
  );
}

/** Nothing to say about a node the audit never ran for. */
const NOTHING: CompletionAudit = { warning: null, refusal: null };

/**
 * Runs the backstop and, if the worktree left the declared scope, appends the
 * one `node.scope_warning` that records it. Resolves with that warning and with
 * KAR-23.11's work-product verdict.
 *
 * Called immediately **before** `node.completed`, not after: `node.completed`
 * is the node's terminal record, and a warning filed behind it is one every
 * reader — and every fold that stops at the terminal event — meets after the
 * node is already done. The same ordering `run-node.ts` uses for
 * `node.unschedulable` before `node.failed`. It is also the one moment the
 * work-product check can run: the child has exited, so the worktree is final,
 * and the node has not been declared done yet.
 *
 * A node that declared no scope costs nothing here, and an *empty* declared
 * scope is not this function's business either: AC1 makes that a plan-validation
 * failure, and treating it as "matches nothing" would turn every write a
 * mis-planned node made into a warning nobody can act on. That early return is
 * also, unchanged, what keeps a reviewer or a verification node out of the
 * work-product check entirely.
 */
export async function auditCompletionScope(
  subject: ScopeAuditSubject,
  ports: ScopeAuditPorts,
): Promise<CompletionAudit> {
  const declared = subject.declared;
  if (declared === undefined || declared.length === 0) return NOTHING;
  const audit = ports.scopeAudit;
  if (audit === undefined) return NOTHING;

  const result = await audit({
    node: subject.node,
    attempt: subject.attempt,
    worktree: subject.worktree,
    declared,
    ...(subject.baseOid === undefined ? {} : { baseOid: subject.baseOid }),
  });

  const refusal = workProductRefusal(subject, result);
  const warning = result.warning;
  if (warning === null) return { warning: null, refusal };

  await ports.ledger.append({
    kind: 'node.scope_warning',
    v: 1,
    ts: ports.clock.now(),
    nodeId: subject.node,
    attempt: subject.attempt,
    payload: warning,
  });
  return { warning, refusal };
}
