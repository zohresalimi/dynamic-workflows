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
}

/**
 * Diffs the worktree and returns the warning its changes deserve, or `null`
 * when everything landed inside the declared scope.
 *
 * A port, for the reason every port in ./ports.ts is one: the implementation
 * spawns `git` and lives in @DeFlow/daemon (`services/scope-diff.ts`), and
 * this package depends on @DeFlow/core alone (docs/16-repo-layout.md R2).
 */
export type ScopeAudit = (request: ScopeAuditRequest) => Promise<NodeScopeWarning | null>;

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

/**
 * Runs the backstop and, if the worktree left the declared scope, appends the
 * one `node.scope_warning` that records it. Resolves with the warning, or
 * `null` when there is nothing to warn about.
 *
 * Called immediately **before** `node.completed`, not after: `node.completed`
 * is the node's terminal record, and a warning filed behind it is one every
 * reader — and every fold that stops at the terminal event — meets after the
 * node is already done. The same ordering `run-node.ts` uses for
 * `node.unschedulable` before `node.failed`.
 *
 * A node that declared no scope costs nothing here, and an *empty* declared
 * scope is not this function's business either: AC1 makes that a plan-validation
 * failure, and treating it as "matches nothing" would turn every write a
 * mis-planned node made into a warning nobody can act on.
 */
export async function auditCompletionScope(
  subject: ScopeAuditSubject,
  ports: ScopeAuditPorts,
): Promise<NodeScopeWarning | null> {
  const declared = subject.declared;
  if (declared === undefined || declared.length === 0) return null;
  const audit = ports.scopeAudit;
  if (audit === undefined) return null;

  const warning = await audit({
    node: subject.node,
    attempt: subject.attempt,
    worktree: subject.worktree,
    declared,
  });
  if (warning === null) return null;

  await ports.ledger.append({
    kind: 'node.scope_warning',
    v: 1,
    ts: ports.clock.now(),
    nodeId: subject.node,
    attempt: subject.attempt,
    payload: warning,
  });
  return warning;
}
