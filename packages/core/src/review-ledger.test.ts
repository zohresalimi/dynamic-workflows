/**
 * KAR-12.2 AC1, AC7 — independence and weakening are ledger facts, not
 * in-memory ones.
 *
 * NF10 is the reason both are payload changes rather than fields on a service:
 * *any state in the UI must trace to specific ledger events*, and "this review
 * was independent" and "this review was weakened" are exactly such states. A
 * test that could only ask a running scheduler would prove nothing about a run
 * somebody reads back next week.
 *
 * Verifies: EPIC-12-S11 (second scenario), EPIC-12-S14 (second scenario) ·
 * AC1, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { acceptanceBoard } from './acceptance-board.ts';
import {
  EVENT_SCHEMAS,
  GateEvaluatedSchema,
  NodeFailedSchema,
  NodeStartedSchema,
} from './event-payloads.ts';
import type { CriterionId, EventSeq, GateId, Handle, NodeId, ProviderId } from './ids.ts';
import { SchedulingRefused } from './independent-review.ts';
import { toNodeFailure } from './node-failure.ts';
import { VERDICT_V4_SCHEMA_ID, type VerdictV4 } from './verdict.ts';

const binary = { path: '/opt/agents/claude', version: '2.1.220', sha256: 'a'.repeat(64) };

const started = (node: string, session: string, origin: 'minted' | 'session/new') => ({
  node,
  attempt: 0,
  ikey: `run_20260802T141133Z_9f2a1c/${node}/0/0`,
  binary,
  session: { id: session, origin },
});

const SPEC_HASH = `sha256-${'b'.repeat(64)}`;

const AC3 = 'ac-3' as CriterionId;

const verdict = (weakened?: 'same-provider'): VerdictV4 => ({
  schemaId: VERDICT_V4_SCHEMA_ID as VerdictV4['schemaId'],
  outcome: 'pass',
  gate: 'design-review' as GateId,
  evaluatedNode: 'implement-1' as NodeId,
  by: { node: 'review-1' as NodeId, provider: 'the-other-one' as ProviderId, model: 'a-model' },
  specHash: SPEC_HASH,
  criteria: [{ id: AC3, status: 'satisfied' }],
  findings: [],
  summary: 'Every criterion this gate speaks to is satisfied.',
  cost: { durationMs: 4200 },
  ...(weakened === undefined ? {} : { weakened }),
});

suite('independence is checkable from two node.started payloads alone (AC1)', () => {
  it('carries the resolved session id on node.started', () => {
    const producer = NodeStartedSchema.parse(started('implement-1', 'p-session', 'session/new'));
    const review = NodeStartedSchema.parse(started('review-1', 'r-session', 'session/new'));

    // The whole assertion AC1 asks for, and it needs nothing but the two rows.
    expect(review.session?.id).not.toBe(producer.session?.id);
  });

  it('records which mechanism produced the id, because the two paths differ', () => {
    // The shim path mints the uuid before spawn; the ACP path learns it from
    // `session/new`. A reader auditing *when* the check could have run needs to
    // know which of the two this was.
    const minted = NodeStartedSchema.parse(started('review-1', 'r-session', 'minted'));
    expect(minted.session?.origin).toBe('minted');
    expect(() =>
      NodeStartedSchema.parse({ ...started('review-1', 'r', 'minted'), session: { id: 'r' } }),
    ).toThrow();
  });

  it('stays legal without a session, for every node that has none', () => {
    const { session: _none, ...withoutSession } = started('build-1', 'x', 'minted');
    expect(() => NodeStartedSchema.parse(withoutSession)).not.toThrow();
  });

  it('is a version bump, so a daemon that predates the field refuses it', () => {
    expect(EVENT_SCHEMAS['node.started'].v).toBe(2);
  });
});

suite('a refused schedule is a typed node failure (AC2)', () => {
  it('carries the refusal code in detail, on a gate-classed node.failed', () => {
    const refusal = new SchedulingRefused(
      'REVIEW_SESSION_NOT_INDEPENDENT',
      'review-1' as NodeId,
      'implement-1' as NodeId,
      'review node review-1 resolved to the session implement-1 ran on',
    );
    const failure = toNodeFailure(refusal, {
      occurredAtEvent: 41 as EventSeq,
      attempt: 0,
      captureEvidence: () => `artifact://${'0'.repeat(64)}` as Handle,
    });

    const failed = NodeFailedSchema.parse({ node: 'review-1', attempt: 0, failure });

    // `gate`, so the scheduler suspends for a human rather than retrying a
    // schedule that cannot be made possible (EPIC-12-S12, second scenario).
    expect(failed.failure.class).toBe('gate');
    expect(failed.failure.detail?.code).toBe('REVIEW_SESSION_NOT_INDEPENDENT');
    expect(failed.failure.detail?.producer).toBe('implement-1');
  });
});

suite('the weakening marker travels to everything that renders it (AC7)', () => {
  it('is carried on the verdict inside gate.evaluated', () => {
    const evaluated = GateEvaluatedSchema.parse({
      gate: 'design-review',
      node: 'implement-1',
      verdict: verdict('same-provider'),
    });
    expect(evaluated.verdict.weakened).toBe('same-provider');
    expect(EVENT_SCHEMAS['gate.evaluated'].v).toBe(4);
  });

  it('is absent when the reviewer ran on a different provider', () => {
    const evaluated = GateEvaluatedSchema.parse({
      gate: 'design-review',
      node: 'implement-1',
      verdict: verdict(),
    });
    expect(evaluated.verdict.weakened).toBeUndefined();
  });

  it('reaches the criteria projection without a join', () => {
    const [row] = acceptanceBoard({
      criteria: [{ id: AC3, statement: 'the guard rejects an expired token' }],
      constraints: [],
      verdicts: [verdict('same-provider')],
      specHash: SPEC_HASH,
    });

    expect(row?.status).toBe('satisfied');
    // The marker a board and a diff view render, on the row itself: a marker
    // stored but not projected is a marker nobody sees.
    expect(row?.weakened).toBe('same-provider');
  });

  it('leaves the row unmarked when the verdict was not weakened', () => {
    const [row] = acceptanceBoard({
      criteria: [{ id: AC3, statement: 'the guard rejects an expired token' }],
      constraints: [],
      verdicts: [verdict()],
      specHash: SPEC_HASH,
    });
    expect(row?.weakened).toBeNull();
  });

  it('refuses a weakening value nobody defined', () => {
    expect(() => verdictOf('sort-of')).toThrow();
  });
});

function verdictOf(weakened: string): unknown {
  return GateEvaluatedSchema.parse({
    gate: 'design-review',
    node: 'implement-1',
    verdict: { ...verdict(), weakened },
  });
}
