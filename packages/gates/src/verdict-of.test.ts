/**
 * KAR-12.3 AC9 — a deterministic gate seals the same document an adversarial
 * reviewer returns: `DeFlow.verdict.v3`, blob-anchored findings, a cost.
 *
 * If the two tiers diverged, EPIC-17 grows two renderers and the repair loop
 * grows two readers, and they drift.
 *
 * Verifies: EPIC-12-S23 (third scenario) · AC6, AC7, AC8, AC9
 */
import type { GateId, NodeId } from '@DeFlow/core';
import { CriterionIdSchema, VERDICT_V3_SCHEMA_ID, VerdictV3Schema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import type { GateFinding } from './finding.ts';
import { sealVerdict } from './verdict-of.ts';

const BLOB = 'e'.repeat(40);
const SPEC_HASH = `sha256-${'2'.repeat(64)}`;

const finding = (overrides: Partial<GateFinding> = {}): GateFinding => ({
  id: 'a13f0c2b91e4',
  severity: 'error',
  file: 'src/api/client.ts',
  rule: 'no-floating-promises',
  message: 'the returned promise is never awaited',
  range: { startLine: 42, endLine: 44 },
  blobSha: BLOB,
  ...overrides,
});

const seal = (overrides: Record<string, unknown> = {}) =>
  sealVerdict({
    gate: 'lint' as GateId,
    node: 'lint-gate' as NodeId,
    evaluatedNode: 'impl' as NodeId,
    outcome: 'fail',
    specHash: SPEC_HASH,
    criteria: ['ac-1'].map((id) => CriterionIdSchema.parse(id)),
    findings: [finding()],
    evidence: [],
    summary: 'lint failed with 1 finding(s)',
    durationMs: 2_400,
    ...overrides,
  });

suite('a deterministic verdict is a DeFlow.verdict.v3 (AC9)', () => {
  it('validates against the shipped document', () => {
    const verdict = seal();

    expect(verdict.schemaId).toBe(VERDICT_V3_SCHEMA_ID);
    expect(VerdictV3Schema.safeParse(verdict).success).toBe(true);
  });

  it('anchors every located finding to the blob the gate read (AC6)', () => {
    expect(seal().findings[0]?.location).toEqual({
      file: 'src/api/client.ts',
      line: 42,
      endLine: 44,
      blobSha: BLOB,
    });
  });

  it('records no location for a finding whose file could not be read', () => {
    const { blobSha: _unanchored, ...rest } = finding();
    const verdict = seal({ findings: [rest] });

    expect(verdict.findings.length).toBe(1);
    expect(verdict.findings[0]?.location).toBeUndefined();
    expect(VerdictV3Schema.safeParse(verdict).success).toBe(true);
  });

  it('records the duration it measured, and no tokens it cannot count (AC8)', () => {
    // A deterministic gate ran a process, not a model. `tokenAccounting` for
    // the runner is `none`, so the cost is a duration and two blanks.
    expect(seal().cost).toEqual({ durationMs: 2_400 });
  });

  it('materialises every declared criterion (AC7)', () => {
    expect(seal({ criteria: ['ac-1', 'ac-2'], outcome: 'pass', findings: [] }).criteria).toEqual([
      { id: 'ac-1', status: 'satisfied' },
      { id: 'ac-2', status: 'satisfied' },
    ]);
  });

  it('calls every criterion unverifiable when the gate could not answer', () => {
    expect(seal({ outcome: 'needs-human', findings: [] }).criteria).toEqual([
      { id: 'ac-1', status: 'unverifiable' },
    ]);
  });
});
