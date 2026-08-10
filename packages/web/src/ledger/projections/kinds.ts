/**
 * KAR-16.3 — which projection consumes which event kind, as one total record.
 *
 * The two halves of EPIC-16-S11 pull in opposite directions and both are
 * required (docs/11-api-and-realtime.md §3.2, docs/12-frontend-architecture.md
 * §3.3):
 *
 * - **At runtime, an unknown kind is ignored.** A tab running an older build
 *   against a newer daemon must not throw, must not partially mutate, and must
 *   still advance its cursor. Every `apply<Name>` therefore returns silently on
 *   its `default` branch.
 * - **At compile time, a new kind must break the build.** The `Event` union is
 *   imported type-only from `@DeFlow/core`, so adding a kind on the backend
 *   *should* surface here in the same commit — and a `default: return` swallows
 *   exactly that.
 *
 * A `default` branch cannot do both. This record is how they coexist: it is
 * `satisfies Record<EventKind, …>`, so a kind added to `@DeFlow/core` fails to
 * compile **here** until somebody decides which views care about it, and each
 * projection's switch is then checked against its own slice of it by the
 * `ignored<'name'>(event)` call in its default branch. Missing a kind you claimed
 * is a type error; ignoring a kind you did not claim is the runtime contract.
 *
 * An empty array is a real answer and the commonest one: most of the ledger is
 * scheduler and workspace bookkeeping that no view projects. Writing it down is
 * the point — "no view needs this" is a decision, and the alternative is a
 * silent omission that reads identically.
 */
import type { Event, EventKind } from '@DeFlow/core';

/** The seven modules of docs/12-frontend-architecture.md §3.2. */
export const PROJECTION_NAMES = [
  'plan',
  'planHistory',
  'blackboard',
  'context',
  'gates',
  'cost',
  'timeline',
] as const;

export type ProjectionName = (typeof PROJECTION_NAMES)[number];

/**
 * Every event kind this build knows, and the projections that fold it.
 *
 * `satisfies` rather than a type annotation: the annotation would widen the
 * values to `readonly ProjectionName[]` and `KindsOwnedBy` below could no
 * longer read the literals back out, which is what makes the per-projection
 * exhaustiveness check possible at all.
 */
export const EVENT_KIND_OWNERS = {
  // ── intake and run lifecycle ───────────────────────────────────────────────
  'task.submitted': [],
  // Seeds the criteria board: F7.4 requires every acceptance criterion to map
  // to at least one gate, so a criterion no gate ever speaks to has to be
  // *visible* as `unverifiable` rather than absent (EPIC-16-S19).
  'run.created': ['gates'],
  'run.spec.approved': [],
  'spec.amended': [],
  'spec.pinned': [],
  'run.started': [],
  'run.paused': [],
  'run.resumed': [],
  'run.cancel.requested': [],
  'run.completed': [],
  'run.aborted': [],
  'run.stalled': [],
  'run.kill_failed': [],
  'run.needs_human': [],

  // ── planning ───────────────────────────────────────────────────────────────
  'plan.proposed': ['plan', 'planHistory'],
  'plan.validation_failed': ['planHistory'],
  // The *ops* live on the proposal and never on `plan.patched`, so both
  // projections have to see it: `plan.patched` names a `patchId` and nothing
  // else, and "which node did this patch abandon" is answerable only by
  // holding the proposal it refers to.
  'plan.patch.proposed': ['plan', 'planHistory'],
  'plan.patched': ['plan', 'planHistory'],
  'plan.patch.queued': ['planHistory'],
  'plan.patch.rejected': ['planHistory'],
  'policy.patch.loaded': [],
  'policy.patch.drifted': [],

  // ── node lifecycle ─────────────────────────────────────────────────────────
  'node.scheduled': ['plan'],
  'node.lock.acquired': [],
  'node.lock.released': [],
  'node.started': ['plan', 'timeline'],
  'node.progress': ['plan'],
  'node.completed': ['plan', 'timeline'],
  'node.failed': ['plan', 'timeline'],
  'node.retry.scheduled': ['plan'],
  'node.suspended': ['plan', 'timeline'],
  'node.blocked': ['plan'],
  'node.unschedulable': ['plan'],
  'node.cancelled': ['plan', 'timeline'],
  'node.cancel.stage': [],
  'node.cancel.failed': [],

  // ── safety and provisioning ────────────────────────────────────────────────
  'permission.denied': [],
  'permission.decided': [],
  'node.scope_warning': [],
  'env.declared': [],
  'provider.auth_mode': [],
  'provider.auth_shadow_stripped': [],
  'sandbox.degraded': [],

  // ── workspace ──────────────────────────────────────────────────────────────
  'workspace.worktree_created': [],
  'workspace.branch_occupied': [],
  'workspace.included_file': [],
  'workspace.setup_cache_hit': [],
  'workspace.dirty_on_remove': [],
  'workspace.wip_salvaged': [],
  'workspace.worktree_removed': [],
  'workspace.reconciled': [],
  'workspace.pid_recycled': [],
  'workspace.orphan_reaped': [],
  'workspace.merge_queue_reordered': [],

  // ── effects ────────────────────────────────────────────────────────────────
  'effect.started': [],
  'effect.completed': [],
  'effect.failed': [],
  'effect.cancelled': [],

  // ── context ────────────────────────────────────────────────────────────────
  'context.built': ['context'],
  'context.compacted': ['context'],
  'pin.integrity_violated': ['context'],

  // ── the blackboard ─────────────────────────────────────────────────────────
  'fact.written': ['blackboard'],
  'fact.read': ['blackboard'],
  'fact.invalidated': ['blackboard'],
  'handoff.oversize': [],

  // ── gates and humans ───────────────────────────────────────────────────────
  'gates.loaded': ['gates'],
  'gate.evaluated': ['gates'],
  'human.requested': ['gates'],
  // The timeline needs it to close a suspension: six idle hours and six busy
  // hours cost very different things, and the answer is what ends the idle one.
  'human.responded': ['gates', 'timeline'],
  'human.interjected': [],
  'human.interjection.delivered': [],

  // ── cost ───────────────────────────────────────────────────────────────────
  'budget.consumed': ['cost', 'timeline'],
  'budget.exceeded': ['cost'],
  'budget.ceiling.set': ['cost'],
  'provider.probed': [],
  'provider.rate_limited': ['cost'],
  'export.blocked': [],
} as const satisfies Record<EventKind, readonly ProjectionName[]>;

/** The kinds `name` claims. Derived, so the switch and the table cannot drift. */
export type KindsOwnedBy<Name extends ProjectionName> = {
  [K in EventKind]: Name extends (typeof EVENT_KIND_OWNERS)[K][number] ? K : never;
}[EventKind];

/**
 * The `default` branch of a projection's switch, as a type-level assertion.
 *
 * `Ignorable` is every event *except* the ones `Name` claims. After the switch
 * has handled all of them, `event` narrows to exactly that — so a claimed kind
 * left unhandled is not assignable and the file stops compiling, naming the
 * kind. At runtime this is a no-op: the caller returns immediately after it,
 * which is the forward-compatibility contract.
 */
export type Ignorable<Name extends ProjectionName> = Exclude<Event, { kind: KindsOwnedBy<Name> }>;

/**
 * Reads `event` and does nothing with it.
 *
 * The parameter is `Ignorable<Name>` and the call site passes the narrowed
 * `event` from a `default` branch; everything this function is for happens
 * during typechecking.
 */
export function ignored<Name extends ProjectionName>(event: Ignorable<Name>): void {
  void event;
}
