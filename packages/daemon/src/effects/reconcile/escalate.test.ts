/**
 * KAR-06.4 — the shape of the `unknown` escalation's evidence
 * (EPIC-06-S15, roadmap risk A1-5).
 *
 * "The operator is given evidence, not a message." The operator answering this
 * at 3 a.m. on a nine-hour run has to choose between "it ran" and "it didn't"
 * for a migration nobody can see, and a prose sentence gives them nothing to
 * choose *with*. So both halves of the escalation are asserted here: the
 * structured `detail` on the `NodeFailure`, which the node inspector renders in
 * full, and the single line `run.needs_human` carries, which is what a board
 * cell and a notification show.
 *
 * The single line is a real constraint and not a style: `RunNeedsHumanSchema`'s
 * `detail` is `singleLine()`, capped at `SINGLE_LINE_MAX`. Four `sha256-…`
 * values spelled out in full are 284 characters before a single label, so the
 * line carries **short digests** and the full hashes live on the `node.failed`
 * payload and the effect row. `RunNeedsHumanSchema.parse` is asserted here so
 * that a future field cannot quietly push the line past the cap and turn the
 * escalation itself into an unhandled schema error.
 *
 * Verifies: EPIC-06-S15 · AC10
 */
import {
  ikey,
  NodeFailureSchema,
  NodeIdSchema,
  RunIdSchema,
  RunNeedsHumanSchema,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { reconcileUnknownDetail, reconcileUnknownFailure, shortDigest } from './escalate.ts';

const EVIDENCE = {
  // Built through the only legal constructor, so the value under test is the
  // shape the journal really writes.
  ikey: ikey(
    RunIdSchema.parse('run_20260805T090000Z_5c1d2e'),
    NodeIdSchema.parse('db-migrate'),
    0,
    0,
  ),
  kind: 'shell' as const,
  requestHash: `sha256-${'a'.repeat(64)}`,
  before: `sha256-${'1'.repeat(64)}`,
  after: `sha256-${'2'.repeat(64)}`,
  observed: `sha256-${'3'.repeat(64)}`,
};

suite('reconcileUnknownDetail (EPIC-06-S15, AC10)', () => {
  it('names the ikey and the effect kind in full', () => {
    const detail = reconcileUnknownDetail(EVIDENCE);
    expect(detail).toContain(EVIDENCE.ikey);
    expect(detail).toContain('shell');
  });

  it('names all four hashes, as digests short enough to fit on one line', () => {
    const detail = reconcileUnknownDetail(EVIDENCE);
    for (const hash of [EVIDENCE.requestHash, EVIDENCE.before, EVIDENCE.after, EVIDENCE.observed]) {
      expect(detail).toContain(shortDigest(hash));
    }
    // Distinguishable from each other, which is the only thing the operator
    // reads them for.
    expect(
      new Set([EVIDENCE.before, EVIDENCE.after, EVIDENCE.observed].map(shortDigest)).size,
    ).toBe(3);
  });

  it('survives RunNeedsHumanSchema, which is where a too-long line would fail', () => {
    expect(() =>
      RunNeedsHumanSchema.parse({
        reason: 'reconcile-unknown',
        detail: reconcileUnknownDetail(EVIDENCE),
      }),
    ).not.toThrow();
  });

  it('says so explicitly when a hash was never journalled', () => {
    expect(reconcileUnknownDetail({ ...EVIDENCE, after: null })).toContain(
      'after=<never journalled>',
    );
  });
});

suite('reconcileUnknownFailure (EPIC-06-S15, AC10)', () => {
  it('is a gate — the taxonomy refuses any other class for this reason', () => {
    const failure = reconcileUnknownFailure(EVIDENCE, { occurredAtEvent: 12, attempt: 0 });
    expect(failure.reason).toBe('effect.reconcile-unknown');
    expect(failure.class).toBe('gate');
    expect(NodeFailureSchema.parse(failure)).toEqual(failure);
  });

  it('carries the evidence as structured fields in full, not as prose', () => {
    const failure = reconcileUnknownFailure(EVIDENCE, { occurredAtEvent: 12, attempt: 0 });
    expect(failure.detail).toMatchObject({
      ikey: EVIDENCE.ikey,
      kind: 'shell',
      requestHash: EVIDENCE.requestHash,
      before: EVIDENCE.before,
      after: EVIDENCE.after,
      observed: EVIDENCE.observed,
    });
  });

  it('keeps a hash that was never journalled as null rather than dropping the key', () => {
    // An absent key reads as "we did not tell you", a null reads as "there was
    // nothing to tell". The operator is choosing between double-applying a
    // migration and dropping it; the difference matters.
    const failure = reconcileUnknownFailure(
      { ...EVIDENCE, after: null },
      { occurredAtEvent: 12, attempt: 0 },
    );
    expect(failure.detail).toHaveProperty('after', null);
  });
});
