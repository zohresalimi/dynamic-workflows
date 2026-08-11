/**
 * KAR-18.3 AC6 / EPIC-18-S23 — the exit code is a closed contract.
 *
 * The scenario is a `Scenario Outline` "driven by a table of reduced `RunState`
 * values", so that is literally what this spec is: reduced states in, one code
 * out, and no database anywhere near it. The whole point of AC6 is that the
 * code is derived in **one** place — the red the epic's test plan names is
 * *"exit code is derived at three call sites and they disagree on `paused`"* —
 * so the table below is the only description of the mapping there is.
 *
 * Verifies: EPIC-18-S23 · AC6 · test plan #6
 */
import type { GateId, NodeId, RunState } from '@DeFlow/core';
import { initialRunState } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { classifyRun, RUN_EXIT_CODES } from './exit-codes.ts';

const completed = (): RunState => ({
  ...initialRunState(),
  status: 'completed',
  outcome: 'succeeded',
});

const withGate = (state: RunState, outcome: 'pass' | 'fail' | 'needs-human'): RunState => ({
  ...state,
  gateVerdicts: {
    'gate-node': {
      gate: 'typecheck' as GateId,
      outcome,
      seq: 12,
      summary: `the typecheck gate ${outcome}ed`,
      findings: [],
    },
  },
});

const withNode = (state: RunState, status: 'completed' | 'failed'): RunState => ({
  ...state,
  nodes: {
    impl: {
      status,
      attempt: 2,
      attempts: 3,
      provider: null,
      model: null,
      permission: null,
      worktree: null,
      result: null,
      failure: null,
      suspension: null,
      requestHash: null,
      wakeAt: null,
      startedTs: 0,
      updatedSeq: 9,
    },
  },
  nodeIds: { active: ['impl' as NodeId], retired: [] },
});

suite('EPIC-18-S23 — the exit code is a closed contract (AC6)', () => {
  it('is exactly seven codes, and nothing else', () => {
    expect(Object.values(RUN_EXIT_CODES).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 130]);
  });

  it('completed with all gates passed exits 0', () => {
    const verdict = classifyRun(withGate(completed(), 'pass'), { noWait: false });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 0 });
    expect(verdict.reason).toBe('completed — every gate passed');
  });

  it('completed with one gate failed exits 1', () => {
    const verdict = classifyRun(withGate(completed(), 'fail'), { noWait: false });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 1 });
    expect(verdict.reason).toBe('completed — the typecheck gate failed');
  });

  it('a node that failed after exhausting its retries exits 1', () => {
    const verdict = classifyRun(withNode({ ...completed(), outcome: 'failed' }, 'failed'), {
      noWait: false,
    });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 1 });
    expect(verdict.reason).toBe('completed — node impl failed');
  });

  it('paused on a run budget ceiling exits 3, not 1', () => {
    const state: RunState = {
      ...initialRunState(),
      status: 'paused',
      budget: {
        ...initialRunState().budget,
        breaches: [{ scope: 'run', dimension: 'cost', limit: 5, actual: 5.4, seq: 40 }],
      },
    };
    const verdict = classifyRun(state, { noWait: false });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 3 });
    expect(verdict.reason).toBe('paused — the run cost ceiling of 5 was reached at 5.4');
  });

  it('paused by a person is not terminal: the CLI keeps watching for the resume', () => {
    expect(
      classifyRun({ ...initialRunState(), status: 'paused' }, { noWait: false }),
    ).toMatchObject({ terminal: false });
  });

  it('awaiting a human gate under --no-wait exits 4', () => {
    const state: RunState = { ...initialRunState(), status: 'awaiting-spec-approval' };
    const verdict = classifyRun(state, { noWait: true });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 4 });
    expect(verdict.reason).toBe('waiting — the spec approval gate is open and --no-wait was given');
  });

  it('awaiting a human gate without --no-wait waits, and exits 0 once it resolves', () => {
    const waiting: RunState = { ...initialRunState(), status: 'awaiting-spec-approval' };
    expect(classifyRun(waiting, { noWait: false })).toMatchObject({ terminal: false });

    // …and the code the outline's second human-gate row names is the code of
    // whatever the run resolved to, which for an approved spec that ran clean
    // is 0.
    expect(classifyRun(withGate(completed(), 'pass'), { noWait: false })).toMatchObject({
      terminal: true,
      exitCode: 0,
    });
  });

  it('needs-human under --no-wait exits 4 and names the reason', () => {
    const state: RunState = {
      ...initialRunState(),
      status: 'needs-human',
      needsHuman: { reason: 'churn', detail: 'three framing attempts were rejected', seq: 22 },
    };
    const verdict = classifyRun(state, { noWait: true });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 4 });
    expect(verdict.reason).toBe('waiting — the run needs a human (churn)');
  });

  it('aborted by the operator exits 130', () => {
    const state: RunState = { ...initialRunState(), status: 'aborted', outcome: 'failed' };
    const verdict = classifyRun(state, { noWait: false });
    expect(verdict).toMatchObject({ terminal: true, exitCode: 130 });
    expect(verdict.reason).toBe('aborted — the run was cancelled');
  });

  it('leaves a run that is still going alone', () => {
    for (const status of ['created', 'spec-approved', 'running', 'cancelling'] as const) {
      expect(classifyRun({ ...initialRunState(), status }, { noWait: true }), status).toMatchObject(
        {
          terminal: false,
        },
      );
    }
  });

  it('every reason is one sentence: no newline, no trailing full stop', () => {
    const verdicts = [
      classifyRun(withGate(completed(), 'pass'), { noWait: false }),
      classifyRun(withGate(completed(), 'fail'), { noWait: false }),
      classifyRun({ ...initialRunState(), status: 'aborted' }, { noWait: false }),
      classifyRun({ ...initialRunState(), status: 'needs-human' }, { noWait: true }),
    ];
    for (const verdict of verdicts) {
      expect(verdict.reason).not.toContain('\n');
      expect(verdict.reason.endsWith('.')).toBe(false);
    }
  });
});
