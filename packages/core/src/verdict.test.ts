/**
 * KAR-02.10 — `Verdict` and `Finding` (docs/04-domain-model.md §7).
 *
 * `needs-human` is a first-class outcome, not a failure mode: it is what an
 * adversarial reviewer returns on a genuine judgement call and what a
 * deterministic gate returns when its own tooling broke. Conflating it with
 * `fail` sends work into the repair loop that no repair will fix. And a
 * finding's evidence is always a `Handle` — inline test output cannot be
 * attached to a diff line (F7.7) and bloats the ledger.
 *
 * Verifies: EPIC-02-S27 (shape), EPIC-02-S28 (shape) · AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { FindingSchema, VerdictSchema } from './verdict.ts';

const HANDLE = `artifact://${'b'.repeat(64)}`;
const FILE_HANDLE = 'file://src/auth/session.ts#L12-L40';

const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'f1',
  severity: 'blocker',
  message: 'the session cookie is written without the Secure attribute',
  evidence: [HANDLE],
  ...overrides,
});

const verdict = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaId: 'DeFlow.verdict.v1',
  outcome: 'fail',
  gate: 'review-auth',
  evaluatedNode: 'impl-session',
  by: { node: 'review-auth', provider: 'claude-code', model: 'claude-sonnet-4-5' },
  criteria: [{ id: 'c-secure-cookie', status: 'unsatisfied' }],
  findings: [finding()],
  summary: 'one blocker on cookie flags',
  ...overrides,
});

suite('Verdict.outcome (AC8)', () => {
  it.each([
    ['pass', true],
    ['fail', true],
    ['needs-human', true],
    ['maybe', false],
    ['error', false],
  ])('%s -> ok=%s', (outcome, ok) => {
    expect(VerdictSchema.safeParse(verdict({ outcome })).success).toBe(ok);
  });

  it('accepts needs-human with no findings at all: the tooling, not the work, failed', () => {
    const result = VerdictSchema.safeParse(
      verdict({
        outcome: 'needs-human',
        findings: [],
        criteria: [{ id: 'c-secure-cookie', status: 'unverifiable' }],
        summary: 'the test runner exited 127; nothing was judged',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('requires a one-line summary: it is a board cell, not the evidence', () => {
    expect(VerdictSchema.safeParse(verdict({ summary: 'line one\nline two' })).success).toBe(false);
    expect(VerdictSchema.safeParse(verdict({ summary: '' })).success).toBe(false);
  });

  it('records per-criterion conclusions (F7.4)', () => {
    const parsed = VerdictSchema.parse(
      verdict({
        criteria: [
          { id: 'c-one', status: 'satisfied' },
          { id: 'c-two', status: 'unverifiable' },
        ],
      }),
    );
    expect(parsed.criteria.map((c) => c.status)).toEqual(['satisfied', 'unverifiable']);
  });

  it('survives a JSON round trip', () => {
    const parsed = VerdictSchema.parse(verdict());
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
  });
});

suite('Finding.evidence is Handle[] (AC8)', () => {
  it('accepts both handle forms', () => {
    expect(FindingSchema.safeParse(finding({ evidence: [HANDLE, FILE_HANDLE] })).success).toBe(
      true,
    );
  });

  it('refuses inlined evidence', () => {
    expect(
      FindingSchema.safeParse(finding({ evidence: ['FAIL src/auth/session.test.ts:12'] })).success,
    ).toBe(false);
    expect(FindingSchema.safeParse(finding({ evidence: [{ stdout: 'FAIL' }] })).success).toBe(
      false,
    );
  });

  it('requires evidence to be present, even if empty', () => {
    const { evidence: _dropped, ...withoutEvidence } = finding();
    expect(FindingSchema.safeParse(withoutEvidence).success).toBe(false);
  });

  it('carries an optional diff location for F7.7', () => {
    const parsed = FindingSchema.parse(
      finding({ location: { file: 'src/auth/session.ts', line: 12, endLine: 40 } }),
    );
    expect(parsed.location).toEqual({ file: 'src/auth/session.ts', line: 12, endLine: 40 });
  });

  it.each([
    ['blocker', true],
    ['major', true],
    ['minor', true],
    ['info', true],
    ['nit', false],
  ])('severity %s -> ok=%s', (severity, ok) => {
    expect(FindingSchema.safeParse(finding({ severity })).success).toBe(ok);
  });
});
