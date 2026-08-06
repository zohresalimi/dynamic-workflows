/**
 * KAR-06.3 AC7 — `request_hash`: what the effect journal remembers about
 * *what was asked for*, so a plan edit landing under a journaled effect cannot
 * hand back the memoised result of the operation it replaced.
 *
 * The failure this guards against is quiet and expensive. An `effect` row is
 * keyed by `(runId, nodeId, attempt, ordinal)` and nothing in that key says
 * anything about the work: a `PlanPatch` that changes `implement`'s permission
 * from `worktree` to `worktree+net`, or rewrites its brief, produces the same
 * ikey for the same attempt. Without a hash of the request, `durable()` reads
 * the `done` row and returns the previous operation's result as if it were the
 * new one — the run then continues on an answer to a question nobody asked.
 * With it, the mismatch is `effect.request-hash-mismatch`, class `permanent`
 * (see ./node-failure.ts): a hard error, never a warning and never a silently
 * stale result.
 *
 * Two decisions are load-bearing:
 *
 * 1. **The encoder is `canonicalJson`, never `ohash`.** `ohash`'s README
 *    promises only "best efforts" at stable serialisation, which is adequate
 *    for "did this object change since last render" in the UI and inadequate
 *    for a value that gates whether a side effect re-runs. A hash that is
 *    unstable across key insertion order raises a hard error on every restart;
 *    one that silently coerces raises none when it should.
 * 2. **The field list is closed and explicit.** `requestHash` reads the six
 *    things AC7 names off the descriptor and ignores everything else, so
 *    renaming a node's `title` — a change that cannot alter what the effect
 *    does — does not invalidate a memoised result (EPIC-06-S10 scenario 2).
 *    Widening it is a deliberate edit here, not an accident of passing a whole
 *    `PlanNode` in.
 *
 * Verifies: EPIC-06-S10 · AC7
 */
import { canonicalJson } from './canonical-json.ts';
import { sha256Hex } from './hash.ts';
import type { PathScope, PermissionLevel } from './plan-graph.ts';

/**
 * Everything about a node that changes *what the effect does*, and nothing
 * else.
 *
 * `provider` and `model` are nullable rather than optional because "no
 * provider was chosen" is a fact worth hashing — a node that later acquires
 * one is doing something different — and `null` survives the canonical
 * encoding, where `undefined` is omitted.
 */
export interface EffectRequest {
  /** The scoped instruction the packet builder assembles the prompt from. */
  readonly brief: string;
  /** The adapter resolved for this attempt, or `null` for a non-agent node. */
  readonly provider: string | null;
  readonly model: string | null;
  readonly permission: PermissionLevel;
  readonly pathScopes: PathScope;
  /** The node's declared reads, as authored. */
  readonly reads: readonly unknown[];
  /** The node's declared writes, as authored. */
  readonly writes: readonly unknown[];
}

/**
 * The six fields, in a fixed order.
 *
 * The order does not affect the digest — `canonicalJson` sorts keys at every
 * depth — but it is what makes the list readable as the answer to "what counts
 * as the same request".
 */
const HASHED_FIELDS = [
  'brief',
  'provider',
  'model',
  'permission',
  'pathScopes',
  'reads',
  'writes',
] as const satisfies readonly (keyof EffectRequest)[];

/**
 * `sha256-<64 hex>` over the canonical encoding of the six fields of
 * `request`.
 *
 * Formatted with the `sha256-` prefix because that is the shape
 * `EffectStartedSchema.requestHash` validates, and a bare digest and a
 * prefixed one are two spellings of the same value that would compare unequal
 * — which, for this value, means a spurious hard error on a correct restart.
 */
export async function requestHash(request: EffectRequest): Promise<string> {
  const subject: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) subject[field] = request[field];
  return `sha256-${await sha256Hex(canonicalJson(subject))}`;
}
