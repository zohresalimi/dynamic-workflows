/**
 * KAR-14.4 AC7 — a quota re-route is a visible plan patch, ruled on by the same
 * policy engine as everything else, and auto-applied only when it is genuinely
 * equivalent.
 *
 * The rule that makes the common case frictionless is one rule, and every one
 * of its four conditions is load-bearing. Drop `capabilitySuperset` and a node
 * that needs to resume is moved onto an adapter that cannot; drop
 * `permissionUnchanged` and the swap widens what the node may do without
 * anybody approving it; drop the op check and *any* auto-applied patch could
 * claim `cause: 'quota'`; drop the cause and every provider swap becomes
 * automatic, including the ones a planner proposed for its own reasons.
 *
 * Verifies: EPIC-14-S24 · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventSeq, NodeId, ProviderId, RunId } from './ids.ts';
import type { NodeFailure } from './node-failure.ts';
import { DEFAULT_PATCH_RULES, evaluatePatchPolicy, type PatchPolicyInput } from './patch-policy.ts';
import { isReroutePatch, type PlanPatch } from './plan-patch.ts';
import { QUOTA_CAUSE } from './rate-limit.ts';
import { reroutePatch } from './retry.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c' as RunId;
const NODE = 'impl-1' as NodeId;
const CODEX = 'codex' as ProviderId;

const limited: NodeFailure = {
  reason: 'provider.rate-limited',
  class: 'transient',
  message: 'claude: rate limited, reset time unknown',
  evidence: [],
  occurredAtEvent: 12 as EventSeq,
  attempt: 0,
};

const patch = (): PlanPatch =>
  reroutePatch({
    runId: RUN_ID,
    node: NODE,
    provider: CODEX,
    nextAttempt: 1,
    failure: limited,
    cause: QUOTA_CAUSE,
  });

/** Everything the F2.5 table asks about a reroute: nothing, essentially. */
const base: PatchPolicyInput = {
  estimate: {
    costUsdDelta: 0,
    blastRadiusFiles: 0,
    maxPermission: 'worktree',
    replanDepth: 0,
  },
  ambientPermission: 'worktree',
  elapsedBudgetFraction: 0.1,
};

const equivalent = (overrides: Partial<PatchPolicyInput['reroute'] & object> = {}) => ({
  ...base,
  reroute: {
    cause: QUOTA_CAUSE,
    onlyReroutes: true,
    capabilitySuperset: true,
    permissionUnchanged: true,
    ...overrides,
  },
});

suite('EPIC-14-S24 — the proposal itself', () => {
  it('AC7: is a replace-provider op naming the target, proposed by the scheduler', () => {
    expect(patch().ops).toEqual([{ op: 'replace-provider', node: NODE, provider: CODEX }]);
    expect(patch().proposedBy).toBe('scheduler');
    expect(isReroutePatch(patch())).toBe(true);
  });

  it('AC7: carries a reason rendered verbatim, naming the quota rather than summarising it', () => {
    const reason = patch().reason;
    expect(reason).toContain('quota');
    expect(reason).toContain(NODE);
    expect(reason).toContain(CODEX);
    // One line, because it is rendered in the scrubber as it stands.
    expect(reason).not.toContain('\n');
  });

  it('is the same patch when the same reroute is proposed twice after a crash', () => {
    expect(patch().id).toBe(patch().id);
  });

  it('a patch that inserts nodes is not a reroute, whatever it claims', () => {
    const inserting: PlanPatch = {
      ...patch(),
      ops: [
        ...patch().ops,
        {
          op: 'abandon-branch',
          root: 'other' as NodeId,
          reason: 'superseded by the reroute',
        },
      ],
    };
    expect(isReroutePatch(inserting)).toBe(false);
  });
});

suite('EPIC-14-S24 — quota-reroute-equivalent auto-applies, and only when it should', () => {
  it('auto-applies an equivalent swap, naming the rule that decided it', () => {
    expect(evaluatePatchPolicy(equivalent())).toEqual({
      decision: 'auto',
      ruleId: 'quota-reroute-equivalent',
    });
  });

  const rows: readonly [string, Record<string, unknown>][] = [
    ['the target is not a capability superset', { capabilitySuperset: false }],
    ['the permission level would change', { permissionUnchanged: false }],
    ['the patch does more than swap providers', { onlyReroutes: false }],
  ];

  for (const [label, overrides] of rows) {
    it(`falls through to a human when ${label}`, () => {
      expect(evaluatePatchPolicy(equivalent(overrides))).toEqual({
        decision: 'approve',
        ruleId: 'default',
      });
    });
  }

  it('does not fire for a patch with no reroute context at all', () => {
    expect(evaluatePatchPolicy(base).ruleId).not.toBe('quota-reroute-equivalent');
  });

  it('never overrides a permission escalation, however equivalent the caller claims it is', () => {
    // The rule is *added* to the table, not placed above it: the four safety
    // and stop rules are asked first, so no `cause: 'quota'` can smuggle a
    // patch past them.
    expect(
      evaluatePatchPolicy({
        ...equivalent(),
        estimate: { ...base.estimate, maxPermission: 'full' },
      }),
    ).toEqual({ decision: 'approve', ruleId: 'escalates-permission' });
  });

  it('never overrides the execution boundary', () => {
    expect(evaluatePatchPolicy({ ...equivalent(), touchesExecutionBoundary: true })).toEqual({
      decision: 'approve',
      ruleId: 'touches-execution-boundary',
    });
  });

  it('never overrides an exhausted budget or a runaway replan', () => {
    expect(evaluatePatchPolicy({ ...equivalent(), elapsedBudgetFraction: 1 })).toEqual({
      decision: 'reject',
      ruleId: 'budget-exhausted',
    });
    expect(
      evaluatePatchPolicy({
        ...equivalent(),
        estimate: { ...base.estimate, replanDepth: 4 },
      }),
    ).toEqual({ decision: 'reject', ruleId: 'replan-depth-exceeded' });
  });

  it('sits after every reject and escalate rule in the default table', () => {
    const ids = DEFAULT_PATCH_RULES.map((rule) => rule.id);
    const quota = ids.indexOf('quota-reroute-equivalent');
    expect(quota).toBeGreaterThan(ids.indexOf('escalates-permission'));
    expect(quota).toBeGreaterThan(ids.indexOf('touches-execution-boundary'));
    expect(quota).toBeGreaterThan(ids.indexOf('replan-depth-exceeded'));
    expect(quota).toBeGreaterThan(ids.indexOf('budget-exhausted'));
    expect(quota).toBeLessThan(ids.indexOf('default'));
  });
});
