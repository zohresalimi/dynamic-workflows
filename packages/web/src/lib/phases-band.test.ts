/**
 * KAR-28.6 — the phases band's arithmetic.
 *
 * Verifies: EPIC-28-S23, EPIC-28-S24 · AC1, AC2, AC4
 *
 * Two claims are worth the file, and neither of them is about markup:
 *
 * 1. **The band folds the same rule the daemon does.** Membership arrives from
 *    `runPhases()` over the wire; the counts beside it are folded here off the
 *    stream, and the two agreeing is the whole reason `foldPhaseItems` is
 *    exported from `@DeFlow/core` rather than restated in a component. The
 *    precedence table below is the same one `packages/core/src/run-phases.test.ts`
 *    asserts against a real ledger — run here against the tab's own statuses, so
 *    a divergence shows up as a red test rather than as `3/7` beside four passed
 *    rows.
 * 2. **"The current phase" is a fact, not a preference** (AC2). A run
 *    mid-execution lands on what is running; a finished one lands where it
 *    ended; one that has not started lands on its first step.
 */

import type { NodeStatus } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import type { NodeBodyVM } from '../components/graph/node-body.ts';
import {
  currentPhaseId,
  type PhaseShape,
  phaseRows,
  phaseWork,
  readPhases,
} from './phases-band.ts';

/** A phase as `GET /api/runs/:id` answers it — the membership, in plan order. */
const phase = (id: string, nodes: readonly string[], title?: string): PhaseShape => ({
  id,
  title: title ?? `step ${id}`,
  type: 'agent',
  nodes,
});

const statusesOf = (
  entries: Readonly<Record<string, NodeStatus>>,
): readonly { readonly id: string; readonly status: NodeStatus }[] =>
  Object.entries(entries).map(([id, status]) => ({ id, status }));

/** A body carrying only the four fields the band reads off one. */
const body = (id: string, over: Partial<NodeBodyVM> = {}): NodeBodyVM =>
  ({
    id,
    title: `the ${id} step`,
    type: 'agent',
    state: 'pending',
    stateLabel: 'Pending',
    elapsed: '4 s',
    ...over,
  }) as NodeBodyVM;

suite('AC1 — a phase counts the work items the daemon says it contains', () => {
  it('reports completed over total, in node ids and never a percentage', () => {
    const rows = phaseRows(
      [phase('verify', ['verify--0', 'verify--1', 'verify--2', 'verify--3'])],
      statusesOf({
        'verify--0': 'completed',
        'verify--1': 'completed',
        'verify--2': 'running',
        'verify--3': 'scheduled',
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.completed).toBe(2);
    expect(rows[0]?.total).toBe(4);
    expect(rows[0]?.counts).toBe('2/4');
    // The denominator is the membership the daemon sent, never a width this
    // file guessed at from anything else.
    expect(rows[0]?.nodes).toEqual(['verify--0', 'verify--1', 'verify--2', 'verify--3']);
  });

  it("uses the plan node's own title and type, composing neither", () => {
    const rows = phaseRows([phase('scope', ['scope'], 'Frame the task')], statusesOf({}));

    expect(rows[0]?.title).toBe('Frame the task');
    expect(rows[0]?.type).toBe('agent');
  });

  it('counts a work item the tab has never seen as not done, rather than dropping it', () => {
    // An inline subgraph's leaf that has not run yet: the plan document names
    // it, the tab's flat plan projection does not hold it, and the honest
    // answer is the one `runPhases` itself gives for a node with no events.
    const rows = phaseRows(
      [phase('build', ['build--a', 'build--b'])],
      statusesOf({ 'build--a': 'completed' }),
    );

    expect(rows[0]?.counts).toBe('1/2');
    expect(rows[0]?.state).toBe('running');
  });

  it('carries no token, throughput or cost figure at all (AC4)', () => {
    const rows = phaseRows([phase('scope', ['scope'])], statusesOf({ scope: 'completed' }));

    // The blueprint's band reads `Verify 31/75 · 12k tok/s`. Two of those three
    // are facts DeFlow holds; the third is the standing rule's subject.
    expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
      'completed',
      'counts',
      'display',
      'id',
      'nodes',
      'state',
      'stateLabel',
      'title',
      'total',
      'type',
    ]);
  });
});

suite("AC1 — a phase's state is the daemon's own precedence, folded live", () => {
  const cases: readonly {
    readonly name: string;
    readonly statuses: readonly NodeStatus[];
    readonly state: string;
    readonly display: string;
  }[] = [
    {
      name: 'anything in flight wins',
      statuses: ['completed', 'running', 'failed'],
      state: 'running',
      display: 'running',
    },
    {
      name: 'every item completed is complete',
      statuses: ['completed', 'completed'],
      state: 'complete',
      display: 'passed',
    },
    {
      name: 'a failure with nothing live is failed',
      statuses: ['completed', 'failed'],
      state: 'failed',
      display: 'failed',
    },
    {
      name: 'a cancellation is its own answer, never a failure',
      statuses: ['completed', 'cancelled'],
      state: 'cancelled',
      display: 'abandoned',
    },
    {
      name: 'some work done and nothing live is still running',
      statuses: ['completed', 'scheduled'],
      state: 'running',
      display: 'running',
    },
  ];

  for (const item of cases) {
    it(item.name, () => {
      const ids = item.statuses.map((_, at) => `n${at}`);
      const rows = phaseRows(
        [phase('p', ids)],
        statusesOf(Object.fromEntries(ids.map((id, at) => [id, item.statuses[at] as NodeStatus]))),
      );

      expect(rows[0]?.state).toBe(item.state);
      expect(rows[0]?.display).toBe(item.display);
      // Colour is never the only carrier: the word rides with it.
      expect(rows[0]?.stateLabel).not.toBe('');
    });
  }

  it('reports a phase nothing has touched as pending, not as anything more confident', () => {
    const rows = phaseRows([phase('later', ['later'])], statusesOf({}));

    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.counts).toBe('0/1');
  });
});

suite('AC2 — the current phase is where the run is', () => {
  const three = [phase('a', ['a']), phase('b', ['b']), phase('c', ['c'])];

  it('selects the phase with work in flight', () => {
    const rows = phaseRows(three, statusesOf({ a: 'completed', b: 'running' }));
    expect(currentPhaseId(rows)).toBe('b');
  });

  it('selects the last phase anything happened to when nothing is running', () => {
    const rows = phaseRows(three, statusesOf({ a: 'completed', b: 'completed', c: 'completed' }));
    expect(currentPhaseId(rows)).toBe('c');
  });

  it('selects where a failed run stopped', () => {
    const rows = phaseRows(three, statusesOf({ a: 'completed', b: 'failed' }));
    expect(currentPhaseId(rows)).toBe('b');
  });

  it('selects the first phase on a run that has not started anything', () => {
    expect(currentPhaseId(phaseRows(three, statusesOf({})))).toBe('a');
  });

  it('selects nothing when the run has no phases', () => {
    expect(currentPhaseId([])).toBeNull();
  });
});

suite("AC1 — the work in a phase is the shared bodies', in plan order", () => {
  it('reads each item off the body the list and the canvas draw', () => {
    const bodies = new Map<string, NodeBodyVM>([
      ['b', body('b', { title: 'Run the suite', state: 'running', stateLabel: 'Running' })],
      ['a', body('a', { title: 'Read the spec', state: 'passed', stateLabel: 'Passed' })],
    ]);

    const work = phaseWork(['a', 'b'], bodies);

    expect(work.map((row) => row.id)).toEqual(['a', 'b']);
    expect(work[0]?.title).toBe('Read the spec');
    expect(work[0]?.stateLabel).toBe('Passed');
    expect(work[1]?.state).toBe('running');
    expect(work[1]?.elapsed).toBe('4 s');
  });

  it('still lists a work item the tab has no body for, under the id the plan gave it', () => {
    const work = phaseWork(['a', 'ghost'], new Map([['a', body('a')]]));

    expect(work.map((row) => row.id)).toEqual(['a', 'ghost']);
    expect(work[1]?.title).toBe('ghost');
    // Nothing is claimed about a node nothing has reported on.
    expect(work[1]?.elapsed).toBeNull();
    expect(work[1]?.state).toBe('pending');
  });
});

suite('AC1 — the wire answer is read, never guessed at', () => {
  it("reads the run summary's phases field", () => {
    const answer = readPhases({
      runId: 'run_20260826T090000Z_1c2d3e',
      phases: {
        basis: 'plan',
        phases: [
          { id: 'scope', title: 'Frame', type: 'agent', state: 'complete', nodes: ['scope'] },
        ],
      },
    });

    expect(answer?.basis).toBe('plan');
    expect(answer?.phases).toEqual([
      { id: 'scope', title: 'Frame', type: 'agent', nodes: ['scope'] },
    ]);
  });

  it('carries a run with no plan through as the honest empty shape', () => {
    expect(readPhases({ phases: { basis: 'no-plan', phases: [] } })).toEqual({
      basis: 'no-plan',
      phases: [],
    });
  });

  it('answers null for a body that carries no phases at all', () => {
    expect(readPhases({ runId: 'run_x' })).toBeNull();
    expect(readPhases(null)).toBeNull();
    expect(readPhases({ phases: { basis: 'invented', phases: [] } })).toBeNull();
  });

  it('skips a phase it cannot read rather than inventing fields for it', () => {
    const answer = readPhases({
      phases: {
        basis: 'plan',
        phases: [
          { id: 'ok', title: 'Fine', type: 'agent', nodes: ['ok'] },
          { id: 'broken', type: 'agent', nodes: ['broken'] },
        ],
      },
    });

    expect(answer?.phases.map((each) => each.id)).toEqual(['ok']);
  });
});
