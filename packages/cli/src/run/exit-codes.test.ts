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
import { initialRunState, NodeFailureSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { classifyRun, EX_USAGE, RUN_EXIT_CODES, rejectionExitCode } from './exit-codes.ts';

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

/**
 * KAR-19.2 AC5 — a submission the daemon *admitted nothing* for.
 *
 * Exit `5` and not `1`: `1` is "the run failed", and a client — or a CI job —
 * that saw one would go looking at the task. Nothing about the task was wrong.
 * `5` is already documented as *"this machine cannot host a run"* and is
 * already what `DeFlow run` exits when git is too old, which is the same class
 * of fact discovered one step earlier.
 */
suite('EPIC-19-S10 — a machine that cannot host a run exits 5 (KAR-19.2 AC5)', () => {
  it('maps both admission refusals to environmentUnusable', () => {
    expect(rejectionExitCode('no_usable_provider')).toBe(RUN_EXIT_CODES.environmentUnusable);
    expect(rejectionExitCode('provider_handshake_failed')).toBe(RUN_EXIT_CODES.environmentUnusable);
  });

  it('leaves every other refusal at EX_USAGE, which is not in the table', () => {
    expect(rejectionExitCode('invalid_request')).toBe(EX_USAGE);
    expect(rejectionExitCode(null)).toBe(EX_USAGE);
    expect(Object.values(RUN_EXIT_CODES)).not.toContain(EX_USAGE);
  });

  it('adds no eighth code', () => {
    expect(Object.values(RUN_EXIT_CODES).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 130]);
  });
});

/**
 * KAR-19.9 AC5 / EPIC-19-S58, EPIC-19-S62 — a run that **gave up** is not a run
 * somebody **stopped**.
 *
 * Both end at `run.aborted { outcome: 'failed' }`, which is why one arm answered
 * for both until this story: `status === 'aborted'` was read as *"the operator
 * pressed Ctrl-C"* and exited `130`. On 2026-08-13 the operator's run never got
 * that far — it retried for ever and had to be killed — but the moment the
 * retry was bounded, the code it would have exited with was `130`, which tells a
 * CI job the build was interrupted when in fact it failed.
 *
 * The discriminator is the projection's own, and it is deliberately not a new
 * field: a run that ended with a failed node or a failed gate **failed**, and a
 * run that ended with neither was stopped by a person — an abandon at the F1.3
 * gate, or `DeFlow cancel`. Nothing about the exit code is derived anywhere but
 * here, which `test/one-run-verdict.test.ts` is the standing guard for.
 */
suite('EPIC-19-S58 — a run that gave up exits 1, not 130 (KAR-19.9 AC5)', () => {
  const failedFraming = (): RunState => ({
    ...initialRunState(),
    status: 'aborted',
    outcome: 'failed',
    nodes: {
      framing: {
        status: 'failed',
        attempt: 2,
        attempts: 3,
        provider: null,
        model: null,
        permission: null,
        worktree: null,
        result: null,
        // Parsed rather than cast, so the fixture is a real member of
        // KAR-02.10's closed taxonomy and cannot drift from it silently.
        failure: NodeFailureSchema.parse({
          reason: 'agent.nonzero-exit',
          class: 'transient',
          message: 'claude exited 1: Invalid session ID',
          attempt: 2,
          occurredAtEvent: 7,
          evidence: [],
          detail: { exitCode: 1 },
        }),
        suspension: null,
        requestHash: null,
        wakeAt: null,
        startedTs: 0,
        updatedSeq: 9,
      },
    },
    nodeIds: { active: ['framing' as NodeId], retired: [] },
  });

  it('exits 1 when the run ended on a node that spent its attempts', () => {
    const verdict = classifyRun(failedFraming(), { noWait: false });
    expect(verdict).toMatchObject({ terminal: true, exitCode: RUN_EXIT_CODES.failed });
  });

  it('names the node and the typed reason, in one sentence', () => {
    const verdict = classifyRun(failedFraming(), { noWait: false });
    expect(verdict.reason).toBe('aborted — node framing failed (agent.nonzero-exit)');
    expect(verdict.reason).not.toContain('\n');
    expect(verdict.reason.endsWith('.')).toBe(false);
  });

  it('exits 1 when the run ended on a failed gate rather than a node', () => {
    const state = withGate({ ...initialRunState(), status: 'aborted', outcome: 'failed' }, 'fail');
    const verdict = classifyRun(state, { noWait: false });
    expect(verdict).toMatchObject({ terminal: true, exitCode: RUN_EXIT_CODES.failed });
    expect(verdict.reason).toBe('aborted — the typecheck gate failed');
  });

  it('still exits 130 for the operator stop, which has neither', () => {
    const stopped: RunState = { ...initialRunState(), status: 'aborted', outcome: 'failed' };
    expect(classifyRun(stopped, { noWait: false })).toMatchObject({
      terminal: true,
      exitCode: RUN_EXIT_CODES.interrupted,
      reason: 'aborted — the run was cancelled',
    });
  });

  it('adds no eighth code for either', () => {
    expect(Object.values(RUN_EXIT_CODES).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 130]);
  });
});
