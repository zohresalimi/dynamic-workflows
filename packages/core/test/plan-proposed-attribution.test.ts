/**
 * KAR-11.1 AC6 — the measurement fields, recorded from day one.
 *
 * 06 §6 is explicit that *"which model plans?"* is **Unverified — a proposal
 * with a measurement plan attached, not a finding"*, and that the measurement
 * is a join of `planner.model` / `planner.effort` / `planner.tier` against the
 * cross-run dashboard. EPIC-11-S1's third scenario says the same thing from the
 * other end: *"recording them now costs a field; adding them later costs an
 * upcaster"*.
 *
 * So the assertions here are about the *shape being available*, not about any
 * tier policy — this story deliberately builds no tier-switching logic.
 *
 * The second suite is the other half of the same decision: `plan.proposed` v1
 * had no such field, so widening it is a version bump with an **identity**
 * upcaster. A v1 payload genuinely does not know which model planned, and an
 * upcaster that invented one would be worse than the gap it filled.
 *
 * Verifies: EPIC-11-S1 (third scenario), EPIC-11-S5 (second scenario) · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { parseEvent } from '../src/events.ts';
import {
  EVENT_SCHEMAS,
  PLAN_DIAGNOSTIC_CODES,
  PLANNER_TIERS,
  RUN_NEEDS_HUMAN_REASONS,
} from '../src/index.ts';
import { PAYLOADS, RUN_ID } from './support/event-payloads.fixture.ts';

const envelope = (kind: string, v: number, payload: unknown): Record<string, unknown> => ({
  seq: 1,
  runId: RUN_ID,
  ts: 1_754_313_093_000,
  kind,
  v,
  epoch: 1,
  payload,
});

suite('AC6 — plan.proposed carries planner.model, planner.effort and planner.tier', () => {
  it('is at v2, because widening a shipped payload is a version bump', () => {
    expect(EVENT_SCHEMAS['plan.proposed'].v).toBe(2);
  });

  it('accepts a proposal carrying the three measurement fields', () => {
    const proposed = PAYLOADS['plan.proposed'] as Record<string, unknown>;
    const result = parseEvent(
      envelope('plan.proposed', 2, {
        ...proposed,
        planner: { model: 'claude-opus-4-9', effort: 'max', tier: 'strongest' },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
  });

  it('accepts a null effort, which is what an adapter with no such control has', () => {
    const proposed = PAYLOADS['plan.proposed'] as Record<string, unknown>;
    const result = parseEvent(
      envelope('plan.proposed', 2, {
        ...proposed,
        planner: { model: 'some-model', effort: null, tier: 'strongest' },
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
  });

  it('refuses a tier outside the closed vocabulary rather than recording it', () => {
    const proposed = PAYLOADS['plan.proposed'] as Record<string, unknown>;
    const result = parseEvent(
      envelope('plan.proposed', 2, {
        ...proposed,
        planner: { model: 'some-model', effort: 'max', tier: 'whatever-is-cheapest' },
      }),
    );

    expect(result.status).toBe('invalid-payload');
  });

  it('names both tiers 06 §6 proposes, and no third', () => {
    expect([...PLANNER_TIERS]).toEqual(['strongest', 'cheap']);
  });

  it('lifts a v1 proposal without inventing a model for it', () => {
    // A genuine v1 payload: written before the field existed, so it has none.
    const { planner: _added, ...v1 } = PAYLOADS['plan.proposed'] as Record<string, unknown>;
    const result = parseEvent(envelope('plan.proposed', 1, v1));

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.event.payload).not.toHaveProperty('planner');
  });
});

suite('EPIC-11-S5 — a failing plan version is an event, not an exception', () => {
  it('registers plan.validation_failed as a kind of its own', () => {
    // v2 since KAR-11.2: `diagnostics[].node` widened from `NodeId` to a plain
    // non-empty string, because `INVALID_NODE_ID` reports an id the charset
    // refuses and `CRITERION_UNCOVERED` names the document rather than a node.
    // v3 since KAR-12.4: `diagnostics[].code` widened by two members,
    // `CRITERION_UNVERIFIABLE_NO_REASON` and `COVERED_BY_GATES_MISMATCH`.
    // v4 since KAR-23.9: two more, `NODE_TYPE_UNPERFORMABLE` and
    // `TOOL_KIND_UNPERFORMABLE` — the check that was missing on 2026-08-24,
    // when a plan validated with seven nodes nothing could perform.
    expect(EVENT_SCHEMAS['plan.validation_failed'].v).toBe(4);
  });

  it('accepts the diagnostics verbatim, with the version and the rejected hash', () => {
    const result = parseEvent(
      envelope('plan.validation_failed', 1, {
        version: 1,
        planHash: `sha256-${'c'.repeat(64)}`,
        by: 'planner',
        attempt: 0,
        diagnostics: [
          {
            severity: 'error',
            code: 'READ_UNREACHABLE',
            node: 'implement',
            key: 'finding/db-schema',
            message:
              "node 'implement' reads 'finding/db-schema' but no ancestor writes it and it is " +
              'not in the pinned spec',
          },
        ],
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
  });

  it('refuses a diagnostic code outside the closed set', () => {
    const result = parseEvent(
      envelope('plan.validation_failed', 1, {
        version: 1,
        planHash: `sha256-${'c'.repeat(64)}`,
        by: 'planner',
        attempt: 0,
        diagnostics: [
          {
            severity: 'error',
            code: 'PLAN_LOOKS_ODD',
            node: 'implement',
            key: 'x',
            message: 'the plan looks odd',
          },
        ],
      }),
    );

    expect(result.status).toBe('invalid-payload');
  });

  it('knows READ_UNREACHABLE is one of the codes it may carry', () => {
    expect([...PLAN_DIAGNOSTIC_CODES]).toContain('READ_UNREACHABLE');
  });
});

suite('the second failure escalates, and the vocabulary says why', () => {
  it('has a plan-invalid reason for run.needs_human', () => {
    expect([...RUN_NEEDS_HUMAN_REASONS]).toContain('plan-invalid');
  });

  it('was versioned past v2 when the vocabulary widened, because that is a shape change', () => {
    // Not pinned to an exact number: KAR-11.4 widened the same vocabulary again
    // (`patch-rejected`, v4), and a test that pinned v3 would fail on the next
    // honest widening while proving nothing about this one. What matters here
    // is that `plan-invalid` arrived *with* a version, and that a v3 payload
    // carrying it still parses — which the scenario below asserts.
    expect(EVENT_SCHEMAS['run.needs_human'].v).toBeGreaterThanOrEqual(3);
  });

  it('accepts a plan-invalid escalation', () => {
    const result = parseEvent(
      envelope('run.needs_human', 3, {
        reason: 'plan-invalid',
        detail: 'two planner attempts produced a plan whose declared reads no ancestor writes',
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
  });

  it('still lifts a v2 escalation', () => {
    const result = parseEvent(
      envelope('run.needs_human', 2, {
        reason: 'spec-revalidation',
        detail: 'the amended spec adds a criterion the plan does not cover',
      }),
    );

    expect(result.status, JSON.stringify(result, null, 2)).toBe('ok');
  });
});
