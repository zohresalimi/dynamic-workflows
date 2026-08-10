/**
 * KAR-12.3 — the verdict a gate actually returns: findings anchored to a blob,
 * a criteria list nobody can leave a hole in, and a cost that is absent rather
 * than zero.
 *
 * Verifies: EPIC-12-S22, EPIC-12-S23 (the schema half), EPIC-12-S26 (first
 * scenario) · AC5, AC6, AC7, AC8
 * · test plan #4, #5
 */
import { expect, it, describe as suite } from 'vitest';
import { CriterionIdSchema } from './ids.ts';
import type { TokenUsage } from './token-usage.ts';
import type { VerdictCriterion } from './verdict.ts';
import {
  FindingV2Schema,
  materialiseCriteria,
  VERDICT_V3_SCHEMA_ID,
  VerdictV3Schema,
  verdictCost,
} from './verdict.ts';

const HANDLE = `artifact://${'b'.repeat(64)}`;
const BLOB = 'a'.repeat(40);

/** A criterion as the reviewer reported it, with the branded id parsed once. */
const said = (id: string, status: VerdictCriterion['status']): VerdictCriterion => ({
  id: CriterionIdSchema.parse(id),
  status,
});

const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a13f0c2b91e4',
  severity: 'blocker',
  message: 'no-floating-promises: the returned promise is never awaited',
  evidence: [HANDLE],
  location: { file: 'src/api/client.ts', line: 42, blobSha: BLOB },
  ...overrides,
});

const verdict = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaId: VERDICT_V3_SCHEMA_ID,
  outcome: 'fail',
  gate: 'review-auth',
  evaluatedNode: 'impl-session',
  by: { node: 'review-auth', provider: 'claude-code', model: 'claude-sonnet-4-5' },
  criteria: [{ id: 'c-secure-cookie', status: 'unsatisfied' }],
  findings: [finding()],
  summary: 'one blocker on cookie flags',
  cost: { durationMs: 4_120 },
  ...overrides,
});

suite('every anchored finding names the blob its range refers to (AC6)', () => {
  it('accepts a location carrying a blobSha', () => {
    expect(FindingV2Schema.safeParse(finding()).success).toBe(true);
  });

  it('rejects a location without one: a line number with no blob is not an anchor', () => {
    const result = FindingV2Schema.safeParse(
      finding({ location: { file: 'src/api/client.ts', line: 42 } }),
    );

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('blobSha');
  });

  it('rejects a blobSha that is not a git object name', () => {
    for (const blobSha of ['', 'HEAD', 'a'.repeat(39), `${'a'.repeat(40)} `]) {
      expect(
        FindingV2Schema.safeParse(finding({ location: { file: 'a.ts', line: 1, blobSha } }))
          .success,
        blobSha,
      ).toBe(false);
    }
  });

  it('accepts a sha256 object name, because a repository may be sha256', () => {
    expect(
      FindingV2Schema.safeParse(
        finding({ location: { file: 'a.ts', line: 1, blobSha: 'c'.repeat(64) } }),
      ).success,
    ).toBe(true);
  });

  it('accepts a finding with no location at all: nothing to anchor, nothing to lie about', () => {
    const { location: _dropped, ...rest } = finding();
    expect(FindingV2Schema.safeParse(rest).success).toBe(true);
  });
});

suite('DeFlow.verdict.v3 (AC9)', () => {
  it('accepts the shape a gate seals', () => {
    const result = VerdictV3Schema.safeParse(verdict());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('carries findings that are objects, never prose', () => {
    expect(VerdictV3Schema.safeParse(verdict({ findings: ['it looks wrong'] })).success).toBe(
      false,
    );
  });

  it('requires the criteria array', () => {
    const { criteria: _dropped, ...rest } = verdict();
    expect(VerdictV3Schema.safeParse(rest).success).toBe(false);
  });

  it('refuses an unanchored finding inside an otherwise valid verdict', () => {
    const result = VerdictV3Schema.safeParse(
      verdict({ findings: [finding({ location: { file: 'a.ts', line: 3 } })] }),
    );
    expect(result.success).toBe(false);
  });

  it('leaves cost optional, so a v2 payload can upcast without one being invented', () => {
    const { cost: _dropped, ...rest } = verdict();
    expect(VerdictV3Schema.safeParse(rest).success).toBe(true);
  });

  it('requires durationMs of any cost that is present (AC8)', () => {
    expect(VerdictV3Schema.safeParse(verdict({ cost: { usd: 0.02 } })).success).toBe(false);
  });

  it('rejects an extra property', () => {
    expect(VerdictV3Schema.safeParse(verdict({ confidence: 0.8 })).success).toBe(false);
  });
});

suite('a criterion the reviewer omitted is unverifiable, never satisfied (AC7)', () => {
  it('materialises every declared criterion, in the order the gate declared them', () => {
    expect(materialiseCriteria(['ac-1', 'ac-2', 'ac-3'], [said('ac-3', 'satisfied')])).toEqual([
      said('ac-1', 'unverifiable'),
      said('ac-2', 'unverifiable'),
      said('ac-3', 'satisfied'),
    ]);
  });

  it('keeps what the reviewer did say about each one', () => {
    expect(
      materialiseCriteria(
        ['ac-1', 'ac-2'],
        [said('ac-1', 'unsatisfied'), said('ac-2', 'satisfied')],
      ),
    ).toEqual([said('ac-1', 'unsatisfied'), said('ac-2', 'satisfied')]);
  });

  it('is non-empty whenever the gate declared anything', () => {
    expect(materialiseCriteria(['ac-1'], [])).toEqual([said('ac-1', 'unverifiable')]);
  });

  it('calls a criterion the reviewer contradicted itself about unverifiable', () => {
    expect(
      materialiseCriteria(['ac-1'], [said('ac-1', 'satisfied'), said('ac-1', 'unsatisfied')]),
    ).toEqual([said('ac-1', 'unverifiable')]);
  });

  it('keeps a criterion the reviewer named but the gate did not declare', () => {
    expect(materialiseCriteria(['ac-1'], [said('ac-9', 'unsatisfied')])).toEqual([
      said('ac-1', 'unverifiable'),
      said('ac-9', 'unsatisfied'),
    ]);
  });
});

suite('Verdict.cost is blank rather than zero (AC8)', () => {
  const usage: TokenUsage = { inputTokens: 1_200, outputTokens: 340, source: 'vendor-reported' };

  it('records durationMs on every adapter, whatever it can count', () => {
    for (const accounting of ['exact', 'estimated', 'none'] as const) {
      expect(verdictCost({ accounting, durationMs: 4_120 }).durationMs).toBe(4_120);
    }
  });

  it("takes the vendor's figures when the adapter counts exactly", () => {
    expect(
      verdictCost({
        accounting: 'exact',
        durationMs: 4_120,
        reported: { usage, usd: 0.021 },
      }),
    ).toEqual({ durationMs: 4_120, tokens: usage, usd: 0.021 });
  });

  it('labels a Tier-2 count as estimated and never as vendor-reported', () => {
    expect(
      verdictCost({
        accounting: 'estimated',
        durationMs: 900,
        estimated: { inputTokens: 800, outputTokens: 120 },
      }),
    ).toEqual({
      durationMs: 900,
      tokens: { inputTokens: 800, outputTokens: 120, source: 'estimated' },
    });
  });

  it('omits tokens and usd entirely on an adapter that accounts for nothing', () => {
    const cost = verdictCost({
      accounting: 'none',
      durationMs: 900,
      reported: { usage, usd: 0.021 },
      estimated: { inputTokens: 800, outputTokens: 120 },
    });

    expect(cost).toEqual({ durationMs: 900 });
    expect('tokens' in cost).toBe(false);
    expect('usd' in cost).toBe(false);
  });

  it('never substitutes an estimate for the exact figure the vendor did not send', () => {
    const cost = verdictCost({
      accounting: 'exact',
      durationMs: 900,
      estimated: { inputTokens: 800, outputTokens: 120 },
    });

    expect(cost).toEqual({ durationMs: 900 });
  });

  it('produces a cost the schema accepts', () => {
    const cost = verdictCost({ accounting: 'exact', durationMs: 4_120, reported: { usage } });
    expect(VerdictV3Schema.safeParse(verdict({ cost })).success).toBe(true);
  });
});
