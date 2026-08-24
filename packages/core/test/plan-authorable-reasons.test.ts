/**
 * KAR-23.11 — the seam that lets `NodeFailureReason` grow without republishing
 * two document schemas.
 *
 * `RetryPolicySchema.onFailure[].when` is embedded in `DeFlow.plangraph.v1` and
 * `DeFlow.planpatch.v1`, whose bytes are hash-pinned by
 * `./schemas-append-only.test.ts`. Before this story it read the live taxonomy,
 * which meant every new failure reason DeFlow learned to *report* was also a
 * shape change to a published, append-only document — a `plangraph.v2` per
 * incident.
 *
 * So the two lists are separated: the taxonomy is what DeFlow may record, and
 * `PLAN_AUTHORABLE_FAILURE_REASONS` is what a *plan document* may name. The
 * second is frozen at what v1 shipped with.
 *
 * Verifies: KAR-23.11
 */
import { expect, it, describe as suite } from 'vitest';
import { NODE_FAILURE_REASONS, type NodeFailureReason } from '../src/node-failure.ts';
import { PLAN_AUTHORABLE_FAILURE_REASONS, RetryPolicySchema } from '../src/plan-graph.ts';

const retry = (when: string) => ({
  maxAttempts: 3,
  backoff: { base: 2000, cap: 300_000, jitter: 'full' },
  onFailure: [{ when, action: 'retry' }],
});

suite('the plan-authorable set is a subset of the taxonomy', () => {
  it('names only reasons the taxonomy still has', () => {
    const taxonomy: readonly string[] = NODE_FAILURE_REASONS;
    expect(PLAN_AUTHORABLE_FAILURE_REASONS.filter((one) => !taxonomy.includes(one))).toEqual([]);
  });

  it('is held to that by the compiler, not by this test alone', () => {
    // `as const satisfies readonly NodeFailureReason[]` in plan-graph.ts is the
    // real guard: deleting a reason from the taxonomy fails `tsc`, where a
    // string list would keep compiling and quietly publish a dead enum member.
    const authorable: readonly NodeFailureReason[] = PLAN_AUTHORABLE_FAILURE_REASONS;
    expect(authorable.length).toBeGreaterThan(20);
  });

  it('accepts every reason that existed when DeFlow.plangraph.v1 shipped', () => {
    for (const when of PLAN_AUTHORABLE_FAILURE_REASONS) {
      expect(RetryPolicySchema.safeParse(retry(when)).success, when).toBe(true);
    }
  });
});

suite('a reason added after v1 shipped is not plan-authorable', () => {
  it("refuses a retry policy naming 'contract.no-work-product'", () => {
    // Deliberate, not a gap. `contract.no-work-product` is DeFlow's own verdict
    // on a node that promised to write files and wrote none; its class is
    // `permanent` by construction, so there is nothing for a retry policy to
    // decide. **Admitting it here would require publishing
    // `DeFlow.plangraph.v2`** — the enum is embedded in the shipped document —
    // which is a decision for EPIC-11, not for an incident fix.
    expect(RetryPolicySchema.safeParse(retry('contract.no-work-product')).success).toBe(false);
  });

  it('but DeFlow may still record it: the two lists answer different questions', () => {
    const taxonomy: readonly string[] = NODE_FAILURE_REASONS;
    expect(taxonomy).toContain('contract.no-work-product');
    expect(PLAN_AUTHORABLE_FAILURE_REASONS as readonly string[]).not.toContain(
      'contract.no-work-product',
    );
  });

  it('still refuses a reason that is in neither list', () => {
    expect(RetryPolicySchema.safeParse(retry('vibes.bad')).success).toBe(false);
  });
});
