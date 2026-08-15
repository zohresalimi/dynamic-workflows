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
