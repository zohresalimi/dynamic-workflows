/**
 * KAR-28.2 AC1, AC2, AC4 — the agent list's rows, as a total function of the
 * shared bodies and the run's own spans.
 *
 * Verifies: EPIC-28-S07, EPIC-28-S08, EPIC-28-S09, EPIC-28-S12 · AC1, AC2, AC4
 *
 * > **Red when:** a retried step collapses back into one row, a map fan-out's
 * > children read as siblings of the node that spawned them, or a row formats
 * > a duration or a price the graph formats differently.
 *
 * Pure, like `../components/graph/node-body.ts` beside it and for the same
 * reason: *"is the failed first attempt still on the list once the second one
 * passed"* is a question about a function, and a question about a function that
 * can only be asked by mounting a page is a question nobody asks twice.
 *
 * The one thing worth stating up front is what this file does **not** test:
 * it never builds a `NodeBodyVM` of its own arithmetic. Every body below comes
 * out of `toNodeBody` — the very function the graph draws through — so a row
 * that agreed with a hand-written expectation while disagreeing with the graph
 * would fail here rather than pass twice.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  formatElapsed,
  formatSpend,
  NOT_PRICED,
  type NodeBodyVM,
  toNodeBody,
} from '../components/graph/node-body.ts';
import type { CostFigures, PlanNodeVM, TimelineSpanVM } from '../ledger/vm.ts';
import { agentRows, parentOf, UNFINISHED } from './agent-rows.ts';

const T0 = 1_786_000_000_000;
/** The tab's clock, well past every span below, so nothing is measured to it. */
const NOW = T0 + 600_000;

function node(over: Partial<PlanNodeVM> = {}): PlanNodeVM {
  return {
    id: 'impl-signup',
    title: 'Migrate the signup view',
    type: 'agent',
    lifecycle: 'active',
    status: 'running',
    state: 'running',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    permission: 'worktree',
    pathScopes: null,
    worktree: null,
    binary: null,
    attempt: 0,
    phase: null,
    progressMessage: null,
    result: null,
    failure: null,
    failures: [],
    suspendedUntil: null,
    blocked: null,
    retry: null,
    unschedulable: null,
    ...over,
  };
}

function span(over: Partial<TimelineSpanVM> = {}): TimelineSpanVM {
  return {
    nodeId: 'impl-signup',
    attempt: 0,
    lane: 0,
    startSeq: 10,
    startTs: T0,
    endSeq: 20,
    endTs: T0 + 3000,
    open: false,
    outcome: 'passed',
    suspensions: [],
    suspendedMs: null,
    costUsd: { vendorReported: null, estimated: null, unaccounted: [] },
    ...over,
  };
}

const money = (over: Partial<CostFigures> = {}): CostFigures => ({
  vendorReported: null,
  estimated: null,
  subscription: null,
  apiKey: null,
  ...over,
});

/** The shared map, in the plan's own order, built the way the graph builds it. */
function bodiesOf(
  entries: readonly {
    node: PlanNodeVM;
    span?: TimelineSpanVM | null;
    spend?: CostFigures | null;
  }[],
): ReadonlyMap<string, NodeBodyVM> {
  return new Map(
    entries.map((entry) => [
      entry.node.id,
      toNodeBody({
        node: entry.node,
        span: entry.span ?? null,
        verdict: null,
        spend: entry.spend ?? null,
        now: NOW,
      }),
    ]),
  );
}

suite('EPIC-28-S07 — one row per agent, carrying the facts an operator acts on', () => {
  it('renders a row per node, in the plan’s own order', () => {
    const bodies = bodiesOf([
      { node: node({ id: 'recon', title: 'Read the auth surface' }) },
      { node: node({ id: 'impl-signup' }) },
      { node: node({ id: 'gate-typecheck', title: 'Typecheck', type: 'gate' }) },
    ]);

    expect(agentRows({ bodies, spans: [] }).map((row) => row.nodeId)).toEqual([
      'recon',
      'impl-signup',
      'gate-typecheck',
    ]);
  });

  it('takes every fact off the shared body rather than deriving one of its own', () => {
    const one = node({ id: 'impl-signup' });
    const bodies = bodiesOf([
      { node: one, span: span({ endTs: T0 + 4200 }), spend: money({ vendorReported: 0.42 }) },
    ]);
    const body = bodies.get('impl-signup') as NodeBodyVM;

    const [row] = agentRows({ bodies, spans: [span({ endTs: T0 + 4200 })] });

    // AC4 with teeth: not "equal to the body", **the body**. A row holding a
    // copy would agree today and drift the first time either side is patched.
    expect(row?.body).toBe(body);
    expect(row?.title).toBe(body.title);
    expect(row?.state).toBe(body.state);
    expect(row?.stateLabel).toBe(body.stateLabel);
    expect(row?.provider).toBe(body.provider);
    expect(row?.model).toBe(body.model);
    expect(row?.permission).toBe(body.permission);
    expect(row?.elapsed).toBe(body.elapsed);
    expect(row?.cost).toBe(body.cost);
    expect(row?.type).toBe(body.type);
    expect(row?.current).toBe(true);
  });

  it('gives a node that never started its own row, not an absence', () => {
    const bodies = bodiesOf([
      { node: node({ id: 'smoke-tests', status: 'scheduled', state: 'pending' }) },
    ]);

    const rows = agentRows({ bodies, spans: [] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('pending');
    expect(rows[0]?.cost).toBe(NOT_PRICED);
    // And no attempt label, because there is no second attempt to tell it from.
    expect(rows[0]?.title).toBe('Migrate the signup view');
  });
});

suite('EPIC-28-S08 — a retry is its own row, and the failed one stays legible', () => {
  const retried = () => {
    const one = node({
      id: 'impl-logout',
      title: 'Migrate the logout view',
      attempt: 1,
      status: 'completed',
      state: 'passed',
    });
    const first = span({
      nodeId: 'impl-logout',
      attempt: 0,
      startTs: T0,
      endTs: T0 + 90_000,
      outcome: 'failed',
      costUsd: { vendorReported: 0.11, estimated: null, unaccounted: [] },
    });
    const second = span({
      nodeId: 'impl-logout',
      attempt: 1,
      startTs: T0 + 120_000,
      endTs: T0 + 124_000,
      outcome: 'passed',
    });
    const bodies = bodiesOf([{ node: one, span: second, spend: money({ vendorReported: 0.3 }) }]);
    // Deliberately out of order: the projection's map is keyed, not sorted.
    return { bodies, rows: agentRows({ bodies, spans: [second, first] }) };
  };

  it('renders one row per attempt, oldest first, labelled by attempt', () => {
    const { rows } = retried();

    expect(rows.map((row) => row.key)).toEqual(['impl-logout#0', 'impl-logout#1']);
    expect(rows.map((row) => row.title)).toEqual([
      'Migrate the logout view — try #1',
      'Migrate the logout view — try #2',
    ]);
  });

  it('keeps the failed attempt readable after the successful one', () => {
    const { rows } = retried();

    // The first row is still `failed` — this is the whole story. An attempt
    // history that collapses into one row shows `passed` and loses the minute
    // and a half that was spent finding out it would not work.
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.stateLabel).toBe('Failed');
    expect(rows[0]?.elapsed).toBe(formatElapsed(90_000));
    expect(rows[0]?.cost).toBe(formatSpend(money({ vendorReported: 0.11 })));
    expect(rows[0]?.current).toBe(false);

    // And the row that *is* the node carries the node's own figures — the ones
    // the graph is drawing in this same tick.
    const body = (rows[1] as { body: NodeBodyVM }).body;
    expect(rows[1]?.state).toBe('passed');
    expect(rows[1]?.elapsed).toBe(body.elapsed);
    expect(rows[1]?.cost).toBe(body.cost);
    expect(rows[1]?.current).toBe(true);
  });

  it('says an attempt is unfinished rather than calling it "not started"', () => {
    const one = node({ id: 'impl-logout', attempt: 1 });
    const stale = span({
      nodeId: 'impl-logout',
      attempt: 0,
      endSeq: null,
      endTs: null,
      open: true,
      outcome: null,
    });
    const live = span({
      nodeId: 'impl-logout',
      attempt: 1,
      endSeq: null,
      endTs: null,
      open: true,
      outcome: null,
    });
    const bodies = bodiesOf([{ node: one, span: live }]);

    const rows = agentRows({ bodies, spans: [stale, live] });

    // An attempt the ledger never closed did start, so `not started` would be
    // a lie and `0.0 s` would be a measurement nobody took.
    expect(rows[0]?.elapsed).toBe(UNFINISHED);
    expect(rows[0]?.state).toBe('running');
  });

  it('leaves a single-attempt step’s title alone', () => {
    const one = node({ id: 'recon', title: 'Read the auth surface' });
    const bodies = bodiesOf([{ node: one, span: span({ nodeId: 'recon' }) }]);

    const rows = agentRows({ bodies, spans: [span({ nodeId: 'recon' })] });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Read the auth surface');
    expect(rows[0]?.tryNumber).toBe(1);
  });
});

suite('EPIC-28-S09 — a sub-agent reads as subordinate to the node that spawned it', () => {
  it('nests a fan-out’s children under the node that materialised them', () => {
    const bodies = bodiesOf([
      { node: node({ id: 'plan-migration', title: 'Plan the migration' }) },
      { node: node({ id: 'migrate-views', title: 'Migrate every view', type: 'map' }) },
      { node: node({ id: 'migrate-views--01bf9ce0', title: 'Migrate LoginView' }) },
      { node: node({ id: 'migrate-views--020bfc3c', title: 'Migrate SignupView' }) },
    ]);

    const rows = agentRows({ bodies, spans: [] });

    expect(rows.map((row) => [row.nodeId, row.depth, row.parentId])).toEqual([
      ['plan-migration', 0, null],
      ['migrate-views', 0, null],
      ['migrate-views--01bf9ce0', 1, 'migrate-views'],
      ['migrate-views--020bfc3c', 1, 'migrate-views'],
    ]);
  });

  it('keeps a child directly under its parent even when the plan lists it elsewhere', () => {
    const bodies = bodiesOf([
      { node: node({ id: 'migrate-views', type: 'map' }) },
      { node: node({ id: 'gate-typecheck', type: 'gate' }) },
      { node: node({ id: 'migrate-views--01bf9ce0' }) },
    ]);

    // A child that renders after an unrelated node is a child nobody can see
    // is a child. Order is the hierarchy's, within the parents' own order.
    expect(agentRows({ bodies, spans: [] }).map((row) => row.nodeId)).toEqual([
      'migrate-views',
      'migrate-views--01bf9ce0',
      'gate-typecheck',
    ]);
  });

  it('nests a grandchild under the nearest parent the plan actually has', () => {
    const bodies = bodiesOf([
      { node: node({ id: 'fan', type: 'map' }) },
      { node: node({ id: 'fan--a', type: 'map' }) },
      { node: node({ id: 'fan--a--b' }) },
    ]);

    expect(agentRows({ bodies, spans: [] }).map((row) => [row.nodeId, row.depth])).toEqual([
      ['fan', 0],
      ['fan--a', 1],
      ['fan--a--b', 2],
    ]);
  });

  it('invents no hierarchy for a run that has none', () => {
    const bodies = bodiesOf([
      { node: node({ id: 'recon' }) },
      // A name that merely *contains* the separator is not a child: nothing in
      // this plan is called `orphan`, so claiming a parent would be a guess.
      { node: node({ id: 'orphan--child' }) },
    ]);

    const rows = agentRows({ bodies, spans: [] });

    expect(rows.every((row) => row.depth === 0)).toBe(true);
    expect(rows.every((row) => row.parentId === null)).toBe(true);
  });

  it('answers the parent question on its own, over a set of ids', () => {
    const ids = new Set(['fan', 'fan--a', 'fan--a--b']);

    expect(parentOf('fan--a--b', ids)).toBe('fan--a');
    expect(parentOf('fan--a', ids)).toBe('fan');
    expect(parentOf('fan', ids)).toBeNull();
    expect(parentOf('orphan--child', ids)).toBeNull();
  });
});

suite('EPIC-28-S12 — one model, and one way of printing a duration or a price', () => {
  it('formats a superseded attempt through the very functions the graph uses', () => {
    const one = node({ id: 'impl-logout', attempt: 1 });
    const first = span({
      nodeId: 'impl-logout',
      attempt: 0,
      startTs: T0,
      endTs: T0 + 61_500,
      outcome: 'failed',
      costUsd: { vendorReported: null, estimated: 0.07, unaccounted: [] },
    });
    const bodies = bodiesOf([{ node: one, span: span({ nodeId: 'impl-logout', attempt: 1 }) }]);

    const rows = agentRows({ bodies, spans: [first, span({ nodeId: 'impl-logout', attempt: 1 })] });

    // `1m 01s` and `~$0.07` are `node-body.ts`'s answers, not this module's.
    expect(rows[0]?.elapsed).toBe(formatElapsed(61_500));
    expect(rows[0]?.cost).toBe(formatSpend(money({ estimated: 0.07 })));
  });

  it('reports a cancelled attempt as abandoned, in the palette’s own vocabulary', () => {
    const one = node({ id: 'impl-logout', attempt: 1 });
    const first = span({ nodeId: 'impl-logout', attempt: 0, outcome: 'cancelled' });
    const bodies = bodiesOf([{ node: one, span: span({ nodeId: 'impl-logout', attempt: 1 }) }]);

    const rows = agentRows({ bodies, spans: [first, span({ nodeId: 'impl-logout', attempt: 1 })] });

    // The domain's `cancelled` is `abandoned` on every other surface — an
    // operator's kill switch must not read as an incident (see
    // `./state-palette.ts`'s note on `NODE_STATUS_DISPLAY`).
    expect(rows[0]?.state).toBe('abandoned');
    expect(rows[0]?.stateLabel).toBe('Abandoned');
  });

  it('ignores a span belonging to a node the plan no longer holds', () => {
    const bodies = bodiesOf([{ node: node({ id: 'recon' }) }]);

    // A replan can abandon a node the timeline still has spans for. A row for
    // a node with no body would have no title, no agent and no model.
    const rows = agentRows({ bodies, spans: [span({ nodeId: 'deleted-by-replan' })] });

    expect(rows.map((row) => row.nodeId)).toEqual(['recon']);
  });
});
