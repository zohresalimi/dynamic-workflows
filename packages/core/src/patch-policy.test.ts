/**
 * KAR-14.3 — the estimate driving the F2.5 rule table.
 *
 * The three worked examples are transcribed from
 * docs/06-planning-and-replanning.md §4.3 rather than invented, so a change to
 * the default table shows up here as a failing example row rather than as a
 * subtly different production behaviour nobody notices (EPIC-14-S16).
 *
 * Verifies: EPIC-14-S16, EPIC-14-S17, EPIC-14-S18 · KAR-14.3 AC5, AC6, AC7 ·
 * test plan #4, #5, #6
 */
import { expect, it, describe as suite } from 'vitest';
import type { Ceiling } from './budget-ceiling.ts';
import { type CostRollup, emptyCostRollup } from './cost-rollup.ts';
import {
  compilePatchRules,
  DEFAULT_PATCH_RULE_SPECS,
  DEFAULT_PATCH_RULES,
  elapsedBudgetFraction,
  evaluatePatchPolicy,
  type PatchPolicyInput,
  PatchPolicyTableSchema,
  patchDecisionOutcome,
  patchPolicyHash,
} from './patch-policy.ts';
import type { PermissionLevel } from './plan-graph.ts';

const NO_CEILING: Ceiling = { costUsd: null, wallclockMs: null };

/** A rollup that spent `costUsd` on the subscription substance. */
function spent(costUsd: number | null): CostRollup {
  const empty = emptyCostRollup();
  return {
    ...empty,
    costUsd: { ...empty.costUsd, subscription: costUsd, estimated: costUsd },
  };
}

interface Case {
  readonly name: string;
  readonly cost: number | null;
  readonly files: number;
  readonly perm: PermissionLevel;
  readonly depth: number;
  readonly ambient: PermissionLevel;
  readonly elapsed: number;
  readonly decision: 'auto' | 'approve' | 'reject';
  readonly rule: string;
}

/** EPIC-14-S16's Examples table, column for column. */
const WORKED_EXAMPLES: readonly Case[] = [
  {
    name: 'recon adds analysis',
    cost: 0.4,
    files: 0,
    perm: 'read',
    depth: 1,
    ambient: 'read',
    elapsed: 0.12,
    decision: 'auto',
    rule: 'read-only-analysis',
  },
  {
    name: 'review adds a codemod',
    cost: 6.2,
    files: 140,
    perm: 'worktree',
    depth: 2,
    ambient: 'read',
    elapsed: 0.3,
    decision: 'approve',
    rule: 'escalates-permission',
  },
  {
    name: 'fourth replan of a hunt',
    cost: 1.1,
    files: 4,
    perm: 'worktree',
    depth: 4,
    ambient: 'worktree',
    elapsed: 0.55,
    decision: 'reject',
    rule: 'replan-depth-exceeded',
  },
];

const ruleOn = (example: Omit<Case, 'name' | 'decision' | 'rule'>) =>
  evaluatePatchPolicy({
    estimate: {
      costUsdDelta: example.cost,
      blastRadiusFiles: example.files,
      maxPermission: example.perm,
      replanDepth: example.depth,
    },
    ambientPermission: example.ambient,
    elapsedBudgetFraction: example.elapsed,
  });

suite('the three worked examples reproduce exactly (S16 · test plan #4)', () => {
  for (const example of WORKED_EXAMPLES) {
    it(`${example.name} → ${example.decision} via ${example.rule}`, () => {
      expect(ruleOn(example)).toEqual({ decision: example.decision, ruleId: example.rule });
    });
  }

  it('keeps the table ordered exactly as 06 §4.3 states it', () => {
    expect(DEFAULT_PATCH_RULES.map((rule) => rule.id)).toEqual([
      'escalates-permission',
      'touches-execution-boundary',
      'replan-depth-exceeded',
      'budget-exhausted',
      // §4.4's added rule (KAR-14.4), and its position is the claim: below
      // every escalate and reject arm above it, so a `cause: 'quota'` cannot
      // carry a patch past a permission escalation or an exhausted budget.
      'quota-reroute-equivalent',
      'expensive',
      'wide-blast-radius',
      'read-only-analysis',
      'default',
    ]);
  });

  it('maps an approval to the queue rather than to an application', () => {
    expect(patchDecisionOutcome('auto')).toBe('auto');
    expect(patchDecisionOutcome('approve')).toBe('queued');
    expect(patchDecisionOutcome('reject')).toBe('rejected');
  });
});

suite('elapsedBudgetFraction: the larger dimension wins (AC6 · test plan #5)', () => {
  it('takes the greater of the cost and wall-clock fractions, never their mean', () => {
    const fraction = elapsedBudgetFraction(spent(9), { costUsd: 10, wallclockMs: 10_000 }, 4_000);
    expect(fraction).toBeCloseTo(0.9, 10);
  });

  it('is zero for a run with no ceiling at all: unbounded is never exhausted', () => {
    expect(elapsedBudgetFraction(spent(9999), NO_CEILING, 9_999_999)).toBe(0);
  });

  it('ignores a dimension whose ceiling is absent rather than treating it as spent', () => {
    expect(elapsedBudgetFraction(spent(9), { costUsd: null, wallclockMs: 10_000 }, 4_000)).toBe(
      0.4,
    );
  });

  it('is zero for an unmeasurable rollup: a blank cell is not a full budget', () => {
    expect(elapsedBudgetFraction(spent(null), { costUsd: 10, wallclockMs: null }, null)).toBe(0);
  });

  it('reaches 1.016 for EPIC-14-S17’s run: 25.40 spent against a 25.00 ceiling', () => {
    const fraction = elapsedBudgetFraction(spent(25.4), { costUsd: 25, wallclockMs: null }, null);
    expect(fraction).toBeCloseTo(1.016, 10);
    expect(
      evaluatePatchPolicy({
        estimate: {
          costUsdDelta: 0.5,
          blastRadiusFiles: 0,
          maxPermission: 'read',
          replanDepth: 1,
        },
        ambientPermission: 'read',
        elapsedBudgetFraction: fraction,
      }),
    ).toEqual({ decision: 'reject', ruleId: 'budget-exhausted' });
  });

  it('fires at exactly 1.0, not only past it', () => {
    expect(
      evaluatePatchPolicy({
        estimate: {
          costUsdDelta: 0.1,
          blastRadiusFiles: 0,
          maxPermission: 'read',
          replanDepth: 1,
        },
        ambientPermission: 'read',
        elapsedBudgetFraction: 1,
      }).ruleId,
    ).toBe('budget-exhausted');
  });
});

/**
 * EPIC-14-S18's second half. The whole failure chain is one coercion: `null → 0`
 * makes `costDeltaUsd <= 5.00` true, which matches `read-only-analysis`, which
 * is `auto` — so the most expensive class of patch auto-applies on exactly the
 * providers DeFlow cannot meter.
 */
suite('null never reads as cheap (S18 · test plan #6)', () => {
  const unpriceable = {
    estimate: {
      costUsdDelta: null,
      blastRadiusFiles: 0,
      maxPermission: 'read' as PermissionLevel,
      replanDepth: 1,
    },
    ambientPermission: 'read' as PermissionLevel,
    elapsedBudgetFraction: 0.1,
  };

  it('falls through to the default arm, which is approve and never auto', () => {
    expect(evaluatePatchPolicy(unpriceable)).toEqual({ decision: 'approve', ruleId: 'default' });
  });

  it('matches neither the read-only-analysis rule nor the expensive one', () => {
    const named = (id: string) => DEFAULT_PATCH_RULES.find((rule) => rule.id === id);
    const readOnly = named('read-only-analysis');
    const expensive = named('expensive');
    if (readOnly === undefined || expensive === undefined) throw new Error('missing rule');
    expect(readOnly.matches(unpriceable)).toBe(false);
    expect(expensive.matches(unpriceable)).toBe(false);
  });

  it('and a priced 0.40 read-only patch does match, so the rule is not simply dead', () => {
    expect(
      DEFAULT_PATCH_RULES.find((rule) => rule.id === 'read-only-analysis')?.matches({
        ...unpriceable,
        estimate: { ...unpriceable.estimate, costUsdDelta: 0.4 },
      }),
    ).toBe(true);
  });
});

suite('the rules that only fire on their own', () => {
  const base = {
    estimate: {
      costUsdDelta: 1,
      blastRadiusFiles: 0,
      maxPermission: 'read' as PermissionLevel,
      replanDepth: 1,
    },
    ambientPermission: 'full' as PermissionLevel,
    elapsedBudgetFraction: 0,
  };

  it('queues a patch that touches the execution boundary', () => {
    expect(evaluatePatchPolicy({ ...base, touchesExecutionBoundary: true })).toEqual({
      decision: 'approve',
      ruleId: 'touches-execution-boundary',
    });
  });

  it('queues an expensive patch even at the run’s own ambient permission', () => {
    expect(
      evaluatePatchPolicy({
        ...base,
        estimate: { ...base.estimate, costUsdDelta: 5.01 },
      }),
    ).toEqual({ decision: 'approve', ruleId: 'expensive' });
  });

  it('queues a wide blast radius', () => {
    expect(
      evaluatePatchPolicy({ ...base, estimate: { ...base.estimate, blastRadiusFiles: 26 } }),
    ).toEqual({ decision: 'approve', ruleId: 'wide-blast-radius' });
  });

  it('does not call a de-escalation an escalation', () => {
    // `worktree` from an ambient `full` is a *reduction* in capability, and a
    // bare level compared against a threshold would read it as a rise. It still
    // does not auto-apply — `read-only-analysis` means read-only — but the
    // reason it goes to a human is the default arm, not an escalation.
    expect(
      evaluatePatchPolicy({
        ...base,
        estimate: { ...base.estimate, maxPermission: 'worktree' },
      }),
    ).toEqual({ decision: 'approve', ruleId: 'default' });
    expect(
      evaluatePatchPolicy({
        ...base,
        ambientPermission: 'read',
        estimate: { ...base.estimate, maxPermission: 'worktree' },
      }),
    ).toEqual({ decision: 'approve', ruleId: 'escalates-permission' });
  });

  it('auto-applies only a read-only, cheap, shallow, in-budget patch', () => {
    expect(evaluatePatchPolicy(base)).toEqual({
      decision: 'auto',
      ruleId: 'read-only-analysis',
    });
  });

  it('rejects depth 4 before it ever asks what the patch costs', () => {
    expect(
      evaluatePatchPolicy({
        ...base,
        estimate: { ...base.estimate, costUsdDelta: null, replanDepth: 4 },
      }),
    ).toEqual({ decision: 'reject', ruleId: 'replan-depth-exceeded' });
  });
});

/**
 * KAR-11.4 AC3, AC10 — the table as *data*.
 *
 * 06 §4.3 states the rule table as YAML in `.DeFlow/config.yaml`, and that
 * matters twice over: an operator has to be able to read the rules their run is
 * playing by, and the table has to be **hashable** so a mid-run edit of the file
 * cannot silently change them. Neither is possible while a rule is a closure, so
 * the specs are the source of truth and the matchers are compiled from them.
 */
suite('the rule table is declarative data (AC3, AC10 · KAR-11.4)', () => {
  it('states the default table in 06 §4.3’s own order, as data', () => {
    expect(DEFAULT_PATCH_RULE_SPECS.map((rule) => `${rule.id}:${rule.decision}`)).toEqual([
      'escalates-permission:approve',
      'touches-execution-boundary:approve',
      'replan-depth-exceeded:reject',
      'budget-exhausted:reject',
      'quota-reroute-equivalent:auto',
      'expensive:approve',
      'wide-blast-radius:approve',
      'read-only-analysis:auto',
      'default:approve',
    ]);
  });

  it('compiles to the same table the shipped default already is', () => {
    expect(compilePatchRules(DEFAULT_PATCH_RULE_SPECS).map((rule) => rule.id)).toEqual(
      DEFAULT_PATCH_RULES.map((rule) => rule.id),
    );
  });

  it('states its thresholds exactly as 06 §4.3 writes them', () => {
    const when = Object.fromEntries(DEFAULT_PATCH_RULE_SPECS.map((rule) => [rule.id, rule.when]));
    expect(when['replan-depth-exceeded']).toEqual({ replanDepth: '> 3' });
    expect(when['budget-exhausted']).toEqual({ elapsedBudgetFraction: '>= 1.0' });
    expect(when.expensive).toEqual({ costDeltaUsd: '> 5.00' });
    expect(when['wide-blast-radius']).toEqual({ blastRadiusFiles: '> 25' });
    expect(when['read-only-analysis']).toEqual({
      maxPermission: 'read',
      costDeltaUsd: '<= 5.00',
    });
    // The last arm has no `when` at all: it matches everything, which is what
    // makes "anything the rules do not recognise goes to a human" total.
    expect(when.default).toBeUndefined();
  });

  it('refuses a comparison it cannot evaluate rather than matching nothing quietly', () => {
    expect(() =>
      PatchPolicyTableSchema.parse([
        { id: 'nope', when: { costDeltaUsd: 'cheap' }, decision: 'auto' },
      ]),
    ).toThrow();
  });

  it('refuses a rule whose predicate this build has never heard of', () => {
    expect(() =>
      PatchPolicyTableSchema.parse([{ id: 'nope', when: { vibes: '> 3' }, decision: 'auto' }]),
    ).toThrow();
  });

  it('hashes the table by value, not by the order somebody wrote the keys in', async () => {
    const reordered = DEFAULT_PATCH_RULE_SPECS.map((rule) =>
      rule.when === undefined
        ? { decision: rule.decision, id: rule.id }
        : {
            decision: rule.decision,
            when: Object.fromEntries(Object.entries(rule.when).toReversed()),
            id: rule.id,
          },
    );
    expect(await patchPolicyHash(reordered as never)).toBe(
      await patchPolicyHash(DEFAULT_PATCH_RULE_SPECS),
    );
  });

  it('gives a raised cost threshold a different hash — that is the whole point', async () => {
    const raised = DEFAULT_PATCH_RULE_SPECS.map((rule) =>
      rule.id === 'expensive' ? { ...rule, when: { costDeltaUsd: '> 50.00' } } : rule,
    );
    expect(await patchPolicyHash(raised as never)).not.toBe(
      await patchPolicyHash(DEFAULT_PATCH_RULE_SPECS),
    );
  });
});

suite('a compiled table honours the comparison it was given', () => {
  const rule = (when: unknown) =>
    compilePatchRules(PatchPolicyTableSchema.parse([{ id: 'r', when, decision: 'auto' }]));

  const input = (over: Partial<PatchPolicyInput> = {}): PatchPolicyInput => ({
    estimate: {
      costUsdDelta: 5,
      blastRadiusFiles: 25,
      maxPermission: 'read',
      replanDepth: 3,
    },
    ambientPermission: 'read',
    elapsedBudgetFraction: 0.5,
    ...over,
  });

  it('reads "> 3" as strictly greater', () => {
    expect(rule({ replanDepth: '> 3' })[0]?.matches(input())).toBe(false);
    expect(
      rule({ replanDepth: '> 3' })[0]?.matches(
        input({
          estimate: {
            costUsdDelta: 5,
            blastRadiusFiles: 25,
            maxPermission: 'read',
            replanDepth: 4,
          },
        }),
      ),
    ).toBe(true);
  });

  it('reads ">= 1.0" as inclusive', () => {
    expect(rule({ elapsedBudgetFraction: '>= 1.0' })[0]?.matches(input())).toBe(false);
    expect(
      rule({ elapsedBudgetFraction: '>= 1.0' })[0]?.matches(input({ elapsedBudgetFraction: 1 })),
    ).toBe(true);
  });

  it('answers false for an unpriceable patch on both sides of the cost comparison', () => {
    const unpriced = input({
      estimate: {
        costUsdDelta: null,
        blastRadiusFiles: 0,
        maxPermission: 'read',
        replanDepth: 1,
      },
    });
    expect(rule({ costDeltaUsd: '> 5.00' })[0]?.matches(unpriced)).toBe(false);
    expect(rule({ costDeltaUsd: '<= 5.00' })[0]?.matches(unpriced)).toBe(false);
  });
});
