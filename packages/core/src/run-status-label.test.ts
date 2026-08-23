/**
 * KAR-19.1 AC6 — one status string, three surfaces.
 *
 * On 2026-08-12 the CLI said `task submitted`, `deflow status` said
 * `created — no nodes yet` and the UI said `No plan yet`, about the same run at
 * the same instant, and each was locally defensible. Three independently
 * defensible descriptions of one state is how an operator concludes the problem
 * is somewhere they have not looked.
 *
 * The table below is therefore the whole of the vocabulary: every `RunStatus`
 * has exactly one label, no two statuses share one, and no surface is allowed
 * to compose its own. `test/one-status-label.test.ts` is the guard that keeps
 * the second half true.
 *
 * Verifies: EPIC-19-S7 · KAR-19.1 AC6 · test plan #6
 */
import { expect, test as it, describe as suite } from 'vitest';
import type { PreExecutionTurnState } from './pre-execution-turn.ts';
import { initialRunState, RUN_STATUSES, type RunState, type RunStatus } from './run-state.ts';
import { RUN_STATUS_LABELS, runStatusLabel } from './run-status-label.ts';

const at = (status: RunStatus): RunState => ({ ...initialRunState(), status });

suite('runStatusLabel (AC6)', () => {
  it('has a label for every RunStatus and no status without one', () => {
    expect(Object.keys(RUN_STATUS_LABELS).toSorted()).toEqual([...RUN_STATUSES].toSorted());
  });

  it('gives each status its own label, so two states never read alike', () => {
    const labels = Object.values(RUN_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it.each([
    ['created', 'submitted — waiting to be framed'],
    ['awaiting-spec-approval', 'awaiting spec approval'],
    ['spec-approved', 'planning'],
    ['running', 'running'],
    ['paused', 'paused'],
    ['needs-human', 'needs a decision'],
    ['cancelling', 'cancelling'],
    ['completed', 'completed'],
    ['aborted', 'aborted'],
  ] as const)('renders %s as "%s"', (status, label) => {
    expect(runStatusLabel(at(status))).toBe(label);
  });

  it('never renders the empty string, whatever the state', () => {
    for (const status of RUN_STATUSES) {
      expect(runStatusLabel(at(status)).trim().length).toBeGreaterThan(0);
    }
  });

  it('reports a stalled run as stalled rather than as running (EPIC-19-S4)', () => {
    const stalled: RunState = { ...at('running'), stalledAtSeq: 12, watermarkSeq: 12 };

    expect(runStatusLabel(stalled)).toBe('running — stalled');
  });

  it('drops the stalled suffix again once the projection moves past the episode', () => {
    const moved: RunState = { ...at('running'), stalledAtSeq: 12, watermarkSeq: 19 };

    expect(runStatusLabel(moved)).toBe('running');
  });

  it('does not call an ended run stalled, whatever episode it last reported', () => {
    const ended: RunState = { ...at('completed'), stalledAtSeq: 12, watermarkSeq: 12 };

    expect(runStatusLabel(ended)).toBe('completed');
  });
});

/**
 * KAR-27.3 AC1 — the label a run wears while a pre-execution turn is actually
 * running.
 *
 * On 2026-08-23 a framing turn spent minutes making Linear queries and reading
 * the repository, and every surface said *submitted — waiting to be framed* the
 * whole time: `created` is the run's status until `run.created` lands, and
 * nothing consulted the `provider.session_opened` sitting in the ledger. The
 * operator could not tell an interrogation from a wedge.
 *
 * Verifies: EPIC-27-S15, EPIC-27-S16 · KAR-27.3 AC1
 */
const SINCE = 1_756_000_000_000;
const ISO = new Date(SINCE).toISOString();

/** A `created` run whose framing turn is in flight, as the reducer folds one. */
const framing = (turn: Partial<PreExecutionTurnState> = {}): RunState => ({
  ...at('created'),
  preExecution: {
    framing: { running: true, sessions: 1, failures: 0, sinceTs: SINCE, maxAttempts: 3, ...turn },
  },
});

suite('runStatusLabel — a pre-execution turn in flight (AC1)', () => {
  it('names the node, that it is running, the attempt and the since-instant', () => {
    expect(runStatusLabel(framing())).toBe(`framing — running · attempt 1 of 3 · since ${ISO}`);
  });

  it('never reads as waiting while an attempt is in flight (EPIC-27-S15)', () => {
    expect(runStatusLabel(framing())).not.toContain('waiting to be framed');
  });

  it('counts the attempt from the failures the ledger records, not from the sessions', () => {
    // A repair opens a second session inside one attempt: two sessions, no
    // failure, and the operator is still on attempt 1 of 3.
    expect(runStatusLabel(framing({ sessions: 2 }))).toContain('attempt 1 of 3');
    expect(runStatusLabel(framing({ sessions: 2, failures: 1 }))).toContain('attempt 2 of 3');
  });

  it('reads the ceiling off the record rather than re-deriving it', () => {
    expect(runStatusLabel(framing({ failures: 1, maxAttempts: 5 }))).toContain('attempt 2 of 5');
  });

  it('never claims an attempt beyond the ceiling', () => {
    expect(runStatusLabel(framing({ failures: 7 }))).toContain('attempt 3 of 3');
  });

  it('names recon and the planner the same way', () => {
    const planning: RunState = {
      ...at('spec-approved'),
      preExecution: {
        planner: { running: true, sessions: 1, failures: 0, sinceTs: SINCE, maxAttempts: 3 },
      },
    };

    expect(runStatusLabel(planning)).toBe(`planner — running · attempt 1 of 3 · since ${ISO}`);
  });

  it('still says stalled when the projection has not moved since the report', () => {
    const stuck: RunState = { ...framing(), stalledAtSeq: 4, watermarkSeq: 4 };

    expect(runStatusLabel(stuck)).toBe(
      `framing — running · attempt 1 of 3 · since ${ISO} — stalled`,
    );
  });
});

suite('runStatusLabel — "waiting to be framed" is reserved for waiting (EPIC-27-S16)', () => {
  it('reads as waiting when no session has been opened at all', () => {
    expect(runStatusLabel(at('created'))).toBe('submitted — waiting to be framed');
  });

  it('reads as waiting again once the attempt concluded and a retry is pending', () => {
    const between: RunState = {
      ...at('created'),
      preExecution: {
        framing: { running: false, sessions: 1, failures: 1, sinceTs: SINCE, maxAttempts: 3 },
      },
    };

    expect(runStatusLabel(between)).toBe('submitted — waiting to be framed');
  });

  it('leaves a run that has stopped for a person alone, whatever the record says', () => {
    const asking: RunState = { ...framing(), status: 'awaiting-spec-approval' };

    expect(runStatusLabel(asking)).toBe('awaiting spec approval');
  });
});
