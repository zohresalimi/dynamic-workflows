/**
 * KAR-12.3 — the adversarial half: the return contract a gate node is held to,
 * and the admission that turns a reviewer's structured return into the same
 * `Verdict` a deterministic gate seals.
 *
 * The validation itself is Ajv's, against the document on disk, and is
 * exercised in ../test/integration/gate-verdict-contract.test.ts. What is here
 * is what DeFlow does with a return that already validated: stamp the facts it
 * owns, complete the criteria, and refuse to let the reviewer's own account of
 * the invocation stand in for DeFlow's.
 *
 * Verifies: EPIC-12-S18, EPIC-12-S21, EPIC-12-S22, EPIC-12-S26 (first
 * scenario) · AC4, AC7, AC8, AC9
 */
import type { GateId, NodeId } from '@DeFlow/core';
import { CriterionIdSchema, VERDICT_V3_SCHEMA_ID, VerdictV3Schema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { admitVerdict, GATE_RETURN_BUDGET, gateVerdictContract } from './agent-verdict.ts';

const SPEC_HASH = `sha256-${'1'.repeat(64)}`;
const BLOB = 'd'.repeat(40);

const invocation = {
  gate: 'review-auth' as GateId,
  node: 'review-auth' as NodeId,
  evaluatedNode: 'impl-session' as NodeId,
  specHash: SPEC_HASH,
  provider: 'claude-code',
  model: 'claude-sonnet-4-5',
  declaredCriteria: ['ac-1', 'ac-2'].map((id) => CriterionIdSchema.parse(id)),
  cost: { durationMs: 4_120 },
};

/** What the reviewer sent back, validated against the on-disk document. */
const returned = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaId: VERDICT_V3_SCHEMA_ID,
  outcome: 'fail',
  gate: 'review-auth',
  evaluatedNode: 'impl-session',
  by: { node: 'review-auth', provider: 'claude-code', model: 'claude-sonnet-4-5' },
  criteria: [{ id: 'ac-1', status: 'unsatisfied' }],
  findings: [
    {
      id: 'a13f0c2b91e4',
      severity: 'blocker',
      message: 'the session cookie is written without the Secure attribute',
      evidence: [],
      location: { file: 'src/auth/session.ts', line: 12, blobSha: BLOB },
    },
  ],
  summary: 'one blocker on cookie flags',
  ...overrides,
});

suite('the gate return contract (AC4)', () => {
  it('is 600 tokens, the headroom docs/10-verification-gates.md §4 sets', () => {
    expect(GATE_RETURN_BUDGET).toBe(600);
  });

  it('names the verdict document and the budget together', () => {
    expect(gateVerdictContract()).toEqual({
      schemaId: VERDICT_V3_SCHEMA_ID,
      maxTokens: GATE_RETURN_BUDGET,
    });
  });
});

suite('admitting a reviewer verdict (AC7, AC9)', () => {
  it('produces a verdict the schema accepts', () => {
    const verdict = admitVerdict({ ...invocation, returned: returned() });

    expect(VerdictV3Schema.safeParse(verdict).success).toBe(true);
    expect(verdict.schemaId).toBe(VERDICT_V3_SCHEMA_ID);
  });

  it('materialises a criterion the reviewer omitted as unverifiable, never satisfied', () => {
    const verdict = admitVerdict({ ...invocation, returned: returned() });

    expect(verdict.criteria).toEqual([
      { id: 'ac-1', status: 'unsatisfied' },
      { id: 'ac-2', status: 'unverifiable' },
    ]);
  });

  it('is non-empty for a gate that declared criteria', () => {
    const verdict = admitVerdict({
      ...invocation,
      returned: returned({ criteria: [], outcome: 'pass', findings: [] }),
    });

    expect(verdict.criteria.length).toBe(2);
    expect(verdict.criteria.every((one) => one.status === 'unverifiable')).toBe(true);
  });

  it('stamps the invocation DeFlow ran, not the one the reviewer described', () => {
    const verdict = admitVerdict({
      ...invocation,
      returned: returned({
        gate: 'some-other-gate',
        evaluatedNode: 'some-other-node',
        by: { node: 'elsewhere', provider: 'codex', model: 'a-model-that-never-ran' },
        specHash: `sha256-${'9'.repeat(64)}`,
      }),
    });

    expect(verdict.gate).toBe('review-auth');
    expect(verdict.evaluatedNode).toBe('impl-session');
    expect(verdict.by).toEqual({
      node: 'review-auth',
      provider: 'claude-code',
      model: 'claude-sonnet-4-5',
    });
    expect(verdict.specHash).toBe(SPEC_HASH);
  });

  it('keeps the judgement itself: outcome, findings and summary are the reviewer’s', () => {
    const verdict = admitVerdict({ ...invocation, returned: returned() });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.findings.length).toBe(1);
    expect(verdict.findings[0]?.location?.blobSha).toBe(BLOB);
    expect(verdict.summary).toBe('one blocker on cookie flags');
  });

  it('stamps the cost DeFlow measured (AC8)', () => {
    const verdict = admitVerdict({
      ...invocation,
      cost: {
        durationMs: 4_120,
        tokens: { inputTokens: 1_200, outputTokens: 340, source: 'vendor-reported' },
        usd: 0.021,
      },
      returned: returned(),
    });

    expect(verdict.cost).toEqual({
      durationMs: 4_120,
      tokens: { inputTokens: 1_200, outputTokens: 340, source: 'vendor-reported' },
      usd: 0.021,
    });
  });

  it('refuses a return that does not parse rather than repairing it here', () => {
    expect(() =>
      admitVerdict({ ...invocation, returned: returned({ outcome: 'ok' }) }),
    ).toThrowError();
  });

  it('refuses a finding whose line names no blob', () => {
    expect(() =>
      admitVerdict({
        ...invocation,
        returned: returned({
          findings: [
            {
              id: 'a13f0c2b91e4',
              severity: 'blocker',
              message: 'the session cookie is written without the Secure attribute',
              evidence: [],
              location: { file: 'src/auth/session.ts', line: 12 },
            },
          ],
        }),
      }),
    ).toThrowError();
  });
});
