/**
 * KAR-06.2 — which resources a node needs before it may run, and who is
 * holding them (docs/05-durable-execution.md §10.2).
 *
 * F5.2 is "serialise writes, parallelise reads", and the reason it is three
 * semaphores rather than one number is that the constraints are not fungible:
 *
 * | Class                       | Default | What actually limits it                    |
 * | --------------------------- | ------- | ------------------------------------------ |
 * | Global agent slots          | 3       | Laptop RAM and vendor rate limits          |
 * | Per-repository write lock   | 1       | Git index contention                       |
 * | Per-worktree exclusive lock | 1       | One agent per worktree, always             |
 *
 * The first is a count in `RunState.policy`. The other two are **locks in the
 * ledger** — `node.lock.acquired` / `node.lock.released` — and this module is
 * the only place that says what a node claims. It holds no state of its own:
 * every function here is a projection of the `RunState` it is handed, so the
 * answer after a crash is the answer before it. That is not a stylistic
 * preference. An in-memory lock evaporates on restart, and the first thing
 * that happens after a crash is that several nodes resume at once — precisely
 * the moment the lock matters most.
 *
 * There is deliberately no bypass. A "just this once" flag would be set, and
 * the failure it produces — two agents' conflicting decisions committed to the
 * same branch — surfaces hours later as a merge problem rather than
 * immediately as a scheduling problem.
 *
 * Verifies: EPIC-06-S5, EPIC-06-S6, EPIC-06-S7 · AC2, AC3, AC6, AC7
 */
import type { NodeId } from './ids.ts';
import type { PlanNode } from './plan-graph.ts';
import { initialNodeState, lockKey, type RunState } from './run-state.ts';

/** One resource a node must hold exclusively before it may start. */
export interface LockClaim {
  readonly lock: 'repo' | 'worktree';
  readonly key: string;
}

/**
 * The repository write lock's key, over a repository root.
 *
 * Prefixed rather than bare so the key is self-describing wherever it is read
 * — in a timeline row, in a `node.lock.acquired` payload, in a bug report —
 * and so it can never collide with a worktree path that happens to be the
 * repository root itself. A `repo` lock and a `worktree` lock over one path
 * are two different locks, and `RunState.locks` keys them apart by kind.
 */
export const repoLockKey = (repoRoot: string): string => `repo:${repoRoot}`;

/** The key `claim` is held under in `RunState.locks`. */
export const claimId = (claim: LockClaim): string => lockKey(claim.lock, claim.key);

/**
 * Everything `node` must hold before it may start, in a fixed order so a
 * command list is stable across runs.
 *
 * Two rules, and the interesting part of both is what they exclude:
 *
 * 1. **A read-only node claims no write lock at all** (AC6). `permission` is
 *    the safety ladder (F5.4), and a node at `read` cannot write the
 *    repository whatever its path scopes say — so an arbitrary number of
 *    analysis nodes run in parallel, bounded only by the global slot count.
 *    That is the "parallelise reads" half of F5.2, and getting it wrong costs
 *    the whole point of running several agents.
 * 2. **A node claims the repository only if it declares a write into it.**
 *    `pathScopes.write` is F5.3's positive write scope; a planning or
 *    summarising node above `read` that writes no path contends with nothing.
 *
 * The worktree claim is independent of both: it comes from the assignment the
 * ledger recorded in `node.scheduled`, and two nodes sharing a checkout are
 * serialised even when neither touches the git index.
 */
export function lockClaims(state: RunState, node: PlanNode): LockClaim[] {
  const claims: LockClaim[] = [];

  if (writesRepository(node) && state.repoRoot !== null) {
    claims.push({ lock: 'repo', key: repoLockKey(state.repoRoot) });
  }

  const worktree = (state.nodes[node.id] ?? initialNodeState()).worktree;
  if (worktree !== null) claims.push({ lock: 'worktree', key: worktree });

  return claims;
}

/**
 * Whether the plan says this node writes the repository.
 *
 * `permission` first, because it is the claim the safety model enforces and a
 * `read` node with a write scope is a contradiction the schema does not
 * forbid — the ladder has to win, or a plan bug becomes a permission
 * escalation.
 */
const writesRepository = (node: PlanNode): boolean =>
  node.permission !== 'read' && node.pathScopes.write.length > 0;

/**
 * The node currently holding `claim`, or `null` if it is free.
 *
 * Read straight out of the reduced ledger — there is no other copy, and this
 * function is the only reader.
 */
export function lockHolder(state: RunState, claim: LockClaim): NodeId | null {
  return state.locks[claimId(claim)]?.node ?? null;
}
