/**
 * KAR-12.3 AC5, AC6 — what the diff surface and the repair loop read off a
 * sequence of attempts: one annotation per stable id, each either drawn against
 * the revision it was measured on or marked stale.
 *
 * Verifies: EPIC-12-S22, EPIC-12-S23 · AC5, AC6
 */
import type { GateId, NodeId, VerdictV3 } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { findingDelta, projectFindings } from './projection.ts';

const OLD = 'b'.repeat(40);
const NEW = 'c'.repeat(40);

const finding = (
  id: string,
  overrides: Record<string, unknown> = {},
): VerdictV3['findings'][number] =>
  ({
    id,
    severity: 'blocker',
    message: `no-floating-promises: ${id}`,
    evidence: [],
    location: { file: 'src/App.vue', line: 42, blobSha: OLD },
    ...overrides,
  }) as VerdictV3['findings'][number];

const verdict = (findings: readonly unknown[]): VerdictV3 =>
  ({
    schemaId: 'DeFlow.verdict.v3',
    outcome: 'fail',
    gate: 'lint' as GateId,
    evaluatedNode: 'impl' as NodeId,
    by: { node: 'lint-gate', provider: 'deflow', model: 'deterministic-gate' },
    criteria: [{ id: 'ac-1', status: 'unsatisfied' }],
    findings,
    summary: 'one blocker',
    cost: { durationMs: 10 },
  }) as unknown as VerdictV3;

suite('findingDelta across attempts (EPIC-12-S22, fourth scenario)', () => {
  it('reports what was fixed, what remains and what the attempt introduced', () => {
    expect(findingDelta(['a13f', '55c1'], ['55c1', '9c02'])).toEqual({
      fixed: ['a13f'],
      remaining: ['55c1'],
      introduced: ['9c02'],
    });
  });

  it('sees a recurrence as the same finding rather than three distinct failures', () => {
    const first = findingDelta(['a13f'], ['a13f']);
    const second = findingDelta(['a13f'], ['a13f']);

    expect(first.remaining).toEqual(['a13f']);
    expect(second.introduced).toEqual([]);
  });

  it('is stable in order, so two runs of the same attempts read the same', () => {
    expect(findingDelta(['b', 'a'], ['c', 'a'])).toEqual({
      fixed: ['b'],
      remaining: ['a'],
      introduced: ['c'],
    });
  });

  it('counts nothing twice when an attempt repeats a finding', () => {
    expect(findingDelta(['a'], ['a', 'a'])).toEqual({
      fixed: [],
      remaining: ['a'],
      introduced: [],
    });
  });
});

suite('projectFindings against a rendered revision (EPIC-12-S23)', () => {
  it('marks a finding whose blob is not the rendered one stale, with its attempt', () => {
    const projected = projectFindings(
      [{ attempt: 2, verdict: verdict([finding('a13f')]) }],
      () => NEW,
    );

    expect(projected.length).toBe(1);
    expect(projected[0]?.stale).toBe(true);
    expect(projected[0]?.fromAttempt).toBe(2);
    expect(projected[0]?.location?.line).toBe(42);
  });

  it('does not mark a finding whose blob is the rendered one', () => {
    const projected = projectFindings(
      [{ attempt: 3, verdict: verdict([finding('a13f')]) }],
      () => OLD,
    );

    expect(projected[0]?.stale).toBe(false);
    expect(projected[0]?.fromAttempt).toBe(3);
  });

  it('deduplicates the same id across attempts to one annotation, the newest', () => {
    const projected = projectFindings(
      [
        { attempt: 1, verdict: verdict([finding('55c1')]) },
        { attempt: 2, verdict: verdict([finding('55c1', { location: undefined })]) },
      ],
      () => OLD,
    );

    expect(projected.length).toBe(1);
    expect(projected[0]?.fromAttempt).toBe(2);
  });

  it('keeps every distinct id, whichever attempt produced it', () => {
    const projected = projectFindings(
      [
        { attempt: 2, verdict: verdict([finding('a13f'), finding('55c1')]) },
        { attempt: 3, verdict: verdict([finding('55c1', { location: undefined })]) },
      ],
      (file) => (file === 'src/App.vue' ? NEW : undefined),
    );

    expect(projected.map((one) => one.id).sort()).toEqual(['55c1', 'a13f']);
    expect(projected.find((one) => one.id === 'a13f')?.stale).toBe(true);
    expect(projected.find((one) => one.id === 'a13f')?.fromAttempt).toBe(2);
  });

  it('never marks a finding with no location stale: there is no line to misdraw', () => {
    const projected = projectFindings(
      [{ attempt: 1, verdict: verdict([finding('9c02', { location: undefined })]) }],
      () => NEW,
    );

    expect(projected[0]?.stale).toBe(false);
  });

  it('treats a file the renderer cannot resolve as a different revision', () => {
    // The rendered tree does not contain the file at all — the attempt that
    // produced the finding was looking at something this revision does not
    // have, which is exactly what stale means.
    const projected = projectFindings(
      [{ attempt: 2, verdict: verdict([finding('a13f')]) }],
      () => undefined,
    );

    expect(projected[0]?.stale).toBe(true);
  });
});
