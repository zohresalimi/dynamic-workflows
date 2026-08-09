/**
 * KAR-11.4 — the patch policy engine's one entry point
 * (docs/06-planning-and-replanning.md §4.3, §7).
 *
 * The order of the two halves of `decidePatch` is the whole story, and it is
 * the thing the natural implementation gets backwards: check the rule table
 * first and the churn circuit breaker second, and you have built a system whose
 * answer to *"three replans moved nothing"* is a fourth replan. So the test that
 * matters most here does not merely assert a rejected decision — a patch that
 * would have been rejected anyway proves nothing about ordering. It hands
 * `decidePatch` a patch that **would auto-apply** with the breaker clear, and an
 * instrumented rule table that records every predicate it is asked, and asserts
 * both the decision *and* that the table was never consulted.
 *
 * Verifies: EPIC-11-S19 (unit half), EPIC-11-S22, EPIC-11-S23 (unit half) ·
 * KAR-11.4 AC1, AC2, AC4, AC6, AC7, AC8, AC9, AC11 · test plan #1–#7, #11
 */
import { expect, it, describe as suite } from 'vitest';
import {
  circuitBreakerOf,
  decidePatch,
  PATCH_CIRCUIT_BREAKER_RULE,
  type PatchDecisionState,
} from './decide-patch.ts';
import {
  compilePatchRules,
  DEFAULT_PATCH_RULE_SPECS,
  type PatchRule,
  type RulablePatchEstimate,
} from './patch-policy.ts';
import type { PermissionLevel } from './plan-graph.ts';
import { type PlanPatch, PlanPatchSchema } from './plan-patch.ts';
import { initialRunState, type RunState } from './run-state.ts';

const NODE = (id: string, permission: PermissionLevel = 'read'): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission,
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  model: 'claude-sonnet-4-5',
  resume: 'always-replay',
});

/**
 * EPIC-11-S19's patch, policy block and all: *"recon discovers three more
 * packages"*. The `reason` is 06 §4.3's own sentence, because AC4 requires it
 * to be recorded verbatim rather than summarised.
 */
const RECON_PATCH: PlanPatch = PlanPatchSchema.parse({
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-recon-1',
  proposedBy: 'n-recon',
  reason: 'recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API',
  ops: [
    {
      op: 'insert-nodes',
      nodes: [NODE('n-analyse-ui'), NODE('n-analyse-forms'), NODE('n-analyse-charts')],
      edges: [],
    },
  ],
  policy: {
    estimatedCostDeltaUsd: 0.4,
    estimatedWallClockDeltaMs: 0,
    blastRadius: { paths: [], nodeCount: 3 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
});

const humanPatch = (patch: PlanPatch): PlanPatch => ({ ...patch, proposedBy: 'human' });

/** The estimate DeFlow's own estimator produces for the patch above — the five
 * dimensions §4.3's table predicates over. */
const RECON_ESTIMATE: RulablePatchEstimate = {
  costUsdDelta: 0.4,
  blastRadiusFiles: 0,
  maxPermission: 'read',
  replanDepth: 1,
};

const state = (over: Partial<PatchDecisionState> = {}): PatchDecisionState => ({
  circuitBreaker: 'clear',
  ambientPermission: 'read',
  elapsedBudgetFraction: 0.12,
  estimate: RECON_ESTIMATE,
  rules: compilePatchRules(DEFAULT_PATCH_RULE_SPECS),
  ...over,
});

/** Recursively freezes `value`, so a callee that mutates an input throws in
 * module (strict-mode) code rather than passing quietly. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

/** A copy of `rules` that records every rule it is asked about, so a test can
 * assert the table was *not consulted* rather than only that the answer was a
 * rejection. */
function spyRules(rules: readonly PatchRule[]): {
  readonly rules: readonly PatchRule[];
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    rules: rules.map((rule) => ({
      ...rule,
      matches: (input) => {
        asked.push(rule.id);
        return rule.matches(input);
      },
    })),
  };
}

suite('decidePatch is pure (S22 fourth scenario · AC1 · test plan #1)', () => {
  it('returns deeply equal decisions for two calls on deep-frozen inputs', () => {
    const patch = deepFreeze(structuredClone(RECON_PATCH));
    const frozen = deepFreeze({ ...state(), rules: state().rules });

    const first = decidePatch(patch, frozen);
    const second = decidePatch(patch, frozen);

    expect(first).toEqual(second);
    expect(first).toEqual({ decision: 'auto', ruleId: 'read-only-analysis' });
  });

  it('leaves the patch it was given untouched', () => {
    const patch = structuredClone(RECON_PATCH);
    const before = structuredClone(patch);
    decidePatch(patch, state());
    expect(patch).toEqual(before);
  });
});

suite('the three worked examples, by ruleId (S19, S20, S21 · AC2 · test plan #2)', () => {
  it('auto-applies the read-only analysis insert at 12% of budget', () => {
    expect(decidePatch(RECON_PATCH, state())).toEqual({
      decision: 'auto',
      ruleId: 'read-only-analysis',
    });
  });

  it('queues the codemod on escalates-permission, before expensive or blast radius', () => {
    expect(
      decidePatch(
        RECON_PATCH,
        state({
          estimate: {
            costUsdDelta: 6.2,
            blastRadiusFiles: 140,
            maxPermission: 'worktree',
            replanDepth: 2,
          },
          ambientPermission: 'read',
          elapsedBudgetFraction: 0.3,
        }),
      ),
    ).toEqual({ decision: 'approve', ruleId: 'escalates-permission' });
  });

  it('rejects the fourth replan of a bug hunt', () => {
    expect(
      decidePatch(
        RECON_PATCH,
        state({
          estimate: {
            costUsdDelta: 1.1,
            blastRadiusFiles: 4,
            maxPermission: 'worktree',
            replanDepth: 4,
          },
          ambientPermission: 'worktree',
          elapsedBudgetFraction: 0.55,
        }),
      ),
    ).toEqual({ decision: 'reject', ruleId: 'replan-depth-exceeded' });
  });

  it('keeps read-only-analysis at exactly 5.00, because expensive fires on "> 5.00"', () => {
    expect(
      decidePatch(RECON_PATCH, state({ estimate: { ...RECON_ESTIMATE, costUsdDelta: 5 } })),
    ).toEqual({ decision: 'auto', ruleId: 'read-only-analysis' });
  });

  it('and hands 5.01 to a human', () => {
    expect(
      decidePatch(RECON_PATCH, state({ estimate: { ...RECON_ESTIMATE, costUsdDelta: 5.01 } })),
    ).toEqual({ decision: 'approve', ruleId: 'expensive' });
  });
});

suite('the table is ordered and first match wins (S22 · test plan #3)', () => {
  const threeWays = state({
    estimate: {
      costUsdDelta: 6.2,
      blastRadiusFiles: 140,
      maxPermission: 'worktree',
      replanDepth: 2,
    },
    ambientPermission: 'read',
  });

  it('reports the first of the three rules the patch satisfies', () => {
    expect(decidePatch(RECON_PATCH, threeWays).ruleId).toBe('escalates-permission');
  });

  it('changes its answer when the same rules are shuffled, proving order is honoured', () => {
    const shuffled = compilePatchRules(
      [...DEFAULT_PATCH_RULE_SPECS].toSorted((left, right) =>
        left.id === 'expensive' ? -1 : right.id === 'expensive' ? 1 : 0,
      ),
    );
    expect(decidePatch(RECON_PATCH, { ...threeWays, rules: shuffled }).ruleId).toBe('expensive');
  });

  it('sends an unrecognised patch to a human via default, never to auto (AC7 · #6)', () => {
    const unrecognised = decidePatch(
      RECON_PATCH,
      state({
        // Not read-only, not expensive, not wide, not deep, in budget: nothing
        // in the table recognises it.
        estimate: {
          costUsdDelta: 1,
          blastRadiusFiles: 2,
          maxPermission: 'worktree',
          replanDepth: 1,
        },
        ambientPermission: 'worktree',
      }),
    );
    expect(unrecognised).toEqual({ decision: 'approve', ruleId: 'default' });
  });

  it('queues a cheap patch that touches the execution boundary (AC9 · #7)', () => {
    expect(
      decidePatch(
        RECON_PATCH,
        state({
          estimate: { ...RECON_ESTIMATE, costUsdDelta: 0.1, blastRadiusFiles: 0 },
          touchesExecutionBoundary: true,
        }),
      ),
    ).toEqual({ decision: 'approve', ruleId: 'touches-execution-boundary' });
  });
});

suite('the churn circuit breaker short-circuits the table (S23 · AC8 · test plan #4)', () => {
  it('rejects a patch that would otherwise auto-apply, without consulting the rules', () => {
    const spy = spyRules(compilePatchRules(DEFAULT_PATCH_RULE_SPECS));

    const ruling = decidePatch(RECON_PATCH, state({ circuitBreaker: 'tripped', rules: spy.rules }));

    expect(ruling).toEqual({ decision: 'reject', ruleId: PATCH_CIRCUIT_BREAKER_RULE });
    // The half that catches the mis-ordering: a table consulted first would
    // have matched `read-only-analysis` and auto-applied it.
    expect(spy.asked).toEqual([]);
  });

  it('and the same patch auto-applies the moment the breaker is clear', () => {
    expect(decidePatch(RECON_PATCH, state({ circuitBreaker: 'clear' }))).toEqual({
      decision: 'auto',
      ruleId: 'read-only-analysis',
    });
  });

  const PROPOSERS = ['planner', 'scheduler', 'n-hunt-3'] as const;

  for (const proposer of PROPOSERS) {
    it(`short-circuits a patch proposed by ${proposer}`, () => {
      const patch = PlanPatchSchema.parse({ ...RECON_PATCH, proposedBy: proposer });
      expect(decidePatch(patch, state({ circuitBreaker: 'tripped' }))).toEqual({
        decision: 'reject',
        ruleId: PATCH_CIRCUIT_BREAKER_RULE,
      });
    });
  }

  it('evaluates a human-authored patch normally — that is how the run is rescued (#5)', () => {
    const spy = spyRules(compilePatchRules(DEFAULT_PATCH_RULE_SPECS));

    const ruling = decidePatch(
      humanPatch(RECON_PATCH),
      state({ circuitBreaker: 'tripped', rules: spy.rules }),
    );

    expect(ruling).toEqual({ decision: 'auto', ruleId: 'read-only-analysis' });
    expect(spy.asked).toContain('read-only-analysis');
  });

  it('does not exempt a human patch from the rules it genuinely breaks', () => {
    expect(
      decidePatch(
        humanPatch(RECON_PATCH),
        state({
          circuitBreaker: 'tripped',
          estimate: { ...RECON_ESTIMATE, replanDepth: 4 },
        }),
      ),
    ).toEqual({ decision: 'reject', ruleId: 'replan-depth-exceeded' });
  });
});

suite('the breaker is read off the projection, never off a flag', () => {
  const churning = (over: Partial<RunState> = {}): RunState => ({
    ...initialRunState(),
    ...over,
  });

  it('is tripped exactly when the run is asking for a human about churn', () => {
    expect(
      circuitBreakerOf(
        churning({ needsHuman: { reason: 'churn', detail: 'three replans moved nothing' } }),
      ),
    ).toBe('tripped');
  });

  it('is clear while nothing has asked', () => {
    expect(circuitBreakerOf(churning())).toBe('clear');
  });

  it('is clear for an escalation that is not churn — a budget pause is not a livelock', () => {
    expect(
      circuitBreakerOf(churning({ needsHuman: { reason: 'budget', detail: 'ceiling reached' } })),
    ).toBe('clear');
  });
});

suite('the policy block is mandatory, not advisory (AC11 · test plan #11)', () => {
  const withoutPolicy = (drop: string): unknown => {
    const patch = structuredClone(RECON_PATCH) as unknown as {
      policy: Record<string, unknown>;
    };
    delete patch.policy[drop];
    return patch;
  };

  for (const field of ['estimatedCostDeltaUsd', 'replanDepth'] as const) {
    it(`refuses a patch missing ${field} at the schema boundary`, () => {
      const parsed = PlanPatchSchema.safeParse(withoutPolicy(field));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain(
        `policy.${field}`,
      );
    });
  }
});
