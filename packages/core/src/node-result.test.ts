/**
 * KAR-02.10 — `NodeResult`, the four ways a node can stop
 * (docs/04-domain-model.md §8).
 *
 * The point of the union is that a stopped node is a value: `failed` carries a
 * `NodeFailure` rather than an `Error`, `suspended` says what it is waiting
 * for, and `cancelled` says who cancelled it. All four survive the ledger and
 * a daemon restart.
 *
 * Verifies: EPIC-02-S27 · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { NodeResultSchema } from './node-result.ts';

const HANDLE = `artifact://${'c'.repeat(64)}`;
const FACT_ID = `fact_${'a'.repeat(26)}`;

const completed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.implReport.v1',
  usage: { inputTokens: 100, outputTokens: 20, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [FACT_ID],
  artifacts: [HANDLE],
  ...overrides,
});

const failed = {
  status: 'failed',
  failure: {
    reason: 'timeout',
    class: 'transient',
    message: 'no frame for 900s',
    evidence: [HANDLE],
    occurredAtEvent: 12,
    attempt: 1,
  },
};

suite('NodeResult union', () => {
  it.each([
    ['completed', completed()],
    ['failed', failed],
    ['suspended', { status: 'suspended', until: { kind: 'human' } }],
    [
      'suspended with a wake time',
      {
        status: 'suspended',
        until: { kind: 'wake', wakeAt: '2026-08-04T14:11:33.000Z' },
      },
    ],
    ['cancelled', { status: 'cancelled', by: 'user' }],
  ])('%s parses and round-trips through JSON', (_label, value) => {
    const parsed = NodeResultSchema.parse(value);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });

  it('is closed: an unknown status is rejected', () => {
    expect(NodeResultSchema.safeParse({ status: 'flaky', by: 'user' }).success).toBe(false);
  });

  it('rejects a completed result with no usage: a node that ran spent tokens', () => {
    const { usage: _dropped, ...withoutUsage } = completed();
    expect(NodeResultSchema.safeParse(withoutUsage).success).toBe(false);
  });

  it('rejects a negative cost', () => {
    expect(NodeResultSchema.safeParse(completed({ costUsd: -1 })).success).toBe(false);
  });

  it('rejects a failed result carrying an Error instead of a NodeFailure', () => {
    expect(
      NodeResultSchema.safeParse({ status: 'failed', failure: new Error('boom') }).success,
    ).toBe(false);
  });

  it('rejects a failed result whose failure breaks the gate-only rule', () => {
    expect(
      NodeResultSchema.safeParse({
        status: 'failed',
        failure: { ...failed.failure, reason: 'budget.cost-exceeded', class: 'permanent' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['human', true],
    ['wake', true],
    ['external', true],
    ['forever', false],
  ])('suspended until kind %s -> ok=%s', (kind, ok) => {
    expect(NodeResultSchema.safeParse({ status: 'suspended', until: { kind } }).success).toBe(ok);
  });

  it.each([
    ['user', true],
    ['policy', true],
    ['parent', true],
    ['vibes', false],
  ])('cancelled by %s -> ok=%s', (by, ok) => {
    expect(NodeResultSchema.safeParse({ status: 'cancelled', by }).success).toBe(ok);
  });
});
