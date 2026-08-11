/**
 * KAR-17.1 test plan row 1 — `toNodeBody` maps every state and never yields
 * `undefined`.
 *
 * Verifies: EPIC-17-S1 (the node-body clause), EPIC-17-S2 · AC2, AC4
 *
 * > **Red when:** a state added to the domain silently renders as pending.
 *
 * The node body is where F10.1's *"one glance tells me what is running, what is
 * blocked, what failed and what is waiting on me"* is either true or a lie, and
 * the way it becomes a lie is always the same: a field that is absent renders
 * as the empty string, and an empty string on a status board reads as *"there
 * is nothing to say here"* rather than as *"nobody has said yet"*. So the whole
 * of this mapping is total — every field of the returned record is present, and
 * the two nullable ones are `null` on purpose and are named in the assertions
 * below rather than left to be discovered.
 *
 * Pure, and deliberately so: the mapping is a function of the four view models
 * the projections already produce, so the component that renders it has no
 * branch of its own to test. It runs in the browser project only because that
 * is where `packages/web/src/**` outside the projections lives (docs/14 §13,
 * `test/web-suite-split.test.ts`); nothing in it needs a DOM.
 */
import { expect, it, describe as suite } from 'vitest';
import type { CostFigures, GateAttemptVM, PlanNodeVM, TimelineSpanVM } from '../../ledger/vm.ts';
import { DISPLAY_STATES, type DisplayState, STATE_LABELS } from '../../lib/state-palette.ts';
import { formatElapsed, formatSpend, NOT_PRICED, toNodeBody, UNKNOWN } from './node-body.ts';

const T0 = 1_786_000_000_000;

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
    attempt: 1,
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
    attempt: 1,
    lane: 0,
    startSeq: 10,
    startTs: T0,
    endSeq: null,
    endTs: null,
    open: true,
    outcome: null,
    suspensions: [],
    suspendedMs: null,
    // KAR-17.8 — what this one attempt spent. `null` is "nothing has landed",
    // never zero: the node body renders a blank cell for it rather than $0.00.
    costUsd: { vendorReported: null, estimated: null, unaccounted: [] },
    ...over,
  };
}

const figures = (over: Partial<CostFigures> = {}): CostFigures => ({
  vendorReported: null,
  estimated: null,
  subscription: null,
  apiKey: null,
  ...over,
});

const attempt = (outcome: GateAttemptVM['outcome']): GateAttemptVM => ({
  gate: 'gate-typecheck',
  attempt: 1,
  outcome,
  seq: 40,
});

/** Every own value of `body`, so "no field is undefined" is one assertion. */
const values = (body: object): unknown[] => Object.values(body);

suite('AC2 — every display state maps, and maps to itself', () => {
  it.each(DISPLAY_STATES)('renders %s under its own label, not under pending', (state) => {
    const body = toNodeBody({
      node: node({ state }),
      span: null,
      verdict: null,
      spend: null,
      now: T0,
    });

    expect(body.state).toBe(state);
    // The red this row names: a mapping that fell through to `pending` would
    // still produce a body, and every state would still render — as the wrong
    // one. Comparing against the palette's own label is what catches it.
    expect(body.stateLabel).toBe(STATE_LABELS[state]);
  });

  it('covers the seven and no more, so an eighth is a compile error upstream', () => {
    const labelled = DISPLAY_STATES.map(
      (state) =>
        toNodeBody({ node: node({ state }), span: null, verdict: null, spend: null, now: T0 })
          .stateLabel,
    );
    expect(new Set(labelled).size).toBe(DISPLAY_STATES.length);
  });

  it('is `abandoned` rather than `failed` for a branch the planner gave up on', () => {
    const abandoned: DisplayState = 'abandoned';
    const body = toNodeBody({
      node: node({ state: abandoned, lifecycle: 'abandoned', status: 'cancelled' }),
      span: null,
      verdict: null,
      spend: null,
      now: T0,
    });

    expect(body.state).toBe('abandoned');
    expect(body.stateLabel).toBe('Abandoned');
    expect(body.stateLabel).not.toBe(STATE_LABELS.failed);
  });
});

suite('AC4 — a body says what a node is, and says so about what it does not know', () => {
  it('never yields undefined for any field, on the emptiest node there is', () => {
    const body = toNodeBody({
      node: node({
        type: null,
        provider: null,
        model: null,
        permission: null,
        state: 'pending',
        status: 'scheduled',
      }),
      span: null,
      verdict: null,
      spend: null,
      now: T0,
    });

    expect(values(body)).not.toContain(undefined);
    // And what it does not know is said in words. A body that rendered the
    // empty string here would be announcing "provider: " to a screen reader.
    expect(body.provider).toBe(UNKNOWN.provider);
    expect(body.model).toBe(UNKNOWN.model);
    expect(body.permission).toBe(UNKNOWN.permission);
    expect(body.type).toBe(UNKNOWN.type);
  });

  it('never yields undefined for any field on a fully populated one either', () => {
    const body = toNodeBody({
      node: node({ phase: 'editing', progressMessage: 'rewriting the signup form' }),
      span: span({ endSeq: 90, endTs: T0 + 12_000, open: false, outcome: 'passed' }),
      verdict: attempt('pass'),
      spend: figures({ vendorReported: 0.42 }),
      now: T0 + 30_000,
    });

    expect(values(body)).not.toContain(undefined);
    expect(body.provider).toBe('claude-code');
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.permission).toBe('worktree');
    expect(body.type).toBe('agent');
  });

  it('carries a streaming badge while running and at no other time', () => {
    const streamingIn = (state: DisplayState): boolean =>
      toNodeBody({ node: node({ state }), span: null, verdict: null, spend: null, now: T0 })
        .streaming;

    expect(streamingIn('running')).toBe(true);
    for (const state of DISPLAY_STATES.filter((one) => one !== 'running')) {
      expect(streamingIn(state)).toBe(false);
    }
  });

  it('shows the live phase as phase text, and never as a state', () => {
    const body = toNodeBody({
      node: node({ phase: 'editing', progressMessage: 'rewriting the signup form' }),
      span: null,
      verdict: null,
      spend: null,
      now: T0,
    });

    expect(body.phase).toBe('editing');
    expect(body.progressMessage).toBe('rewriting the signup form');
    expect(body.state).toBe('running');
  });

  it('has no phase text at all when no progress event has landed', () => {
    const body = toNodeBody({ node: node(), span: null, verdict: null, spend: null, now: T0 });
    expect(body.phase).toBeNull();
    expect(body.progressMessage).toBeNull();
  });

  it('carries a gate verdict chip where one applies, and none where none does', () => {
    const withVerdict = toNodeBody({
      node: node(),
      span: null,
      verdict: attempt('needs-human'),
      spend: null,
      now: T0,
    });
    const without = toNodeBody({
      node: node(),
      span: null,
      verdict: null,
      spend: null,
      now: T0,
    });

    expect(withVerdict.verdict).toBe('needs-human');
    expect(withVerdict.verdictGate).toBe('gate-typecheck');
    expect(without.verdict).toBeNull();
    expect(without.verdictGate).toBeNull();
  });

  it('carries the file AND the line the verdict points at, so the chip can link to it', () => {
    // KAR-17.6 AC1/AC2 from the graph's end. The line is half the link: without
    // it the operator lands at the top of a diff and hunts for the verdict.
    const body = toNodeBody({
      node: node(),
      span: null,
      verdict: attempt('fail'),
      spend: null,
      now: T0,
      pointer: { node: 'n1', file: 'src/date-picker.ts', line: 2 },
    });

    expect(body.verdictFile).toBe('src/date-picker.ts');
    expect(body.verdictLine).toBe(2);
  });

  it('says nothing about a line when no finding located the failure', () => {
    const body = toNodeBody({
      node: node(),
      span: null,
      verdict: attempt('fail'),
      spend: null,
      now: T0,
    });

    // Not line 1, and not the empty string: the chip still links to the node's
    // diff, and simply makes no claim about where in it to look (AC3).
    expect(body.verdictFile).toBeNull();
    expect(body.verdictLine).toBeNull();
  });
});

suite('AC4 — elapsed time', () => {
  it('counts a closed span from its own two timestamps, not from now', () => {
    const body = toNodeBody({
      node: node({ state: 'passed' }),
      span: span({ endSeq: 90, endTs: T0 + 12_000, open: false, outcome: 'passed' }),
      verdict: null,
      spend: null,
      now: T0 + 9_000_000,
    });

    expect(body.elapsedMs).toBe(12_000);
    expect(body.elapsed).toBe('12.0 s');
  });

  it('counts an open span up to now, so a running node keeps moving', () => {
    const body = toNodeBody({
      node: node(),
      span: span(),
      verdict: null,
      spend: null,
      now: T0 + 65_500,
    });

    expect(body.elapsedMs).toBe(65_500);
    expect(body.elapsed).toBe('1m 05s');
  });

  it('says so rather than showing zero when the node has never run', () => {
    const body = toNodeBody({ node: node(), span: null, verdict: null, spend: null, now: T0 });

    expect(body.elapsedMs).toBeNull();
    expect(body.elapsed).toBe(UNKNOWN.elapsed);
  });

  it('never counts backwards, however the clock and the ledger disagree', () => {
    const body = toNodeBody({
      node: node(),
      span: span(),
      verdict: null,
      spend: null,
      now: T0 - 5_000,
    });

    expect(body.elapsedMs).toBe(0);
  });

  it.each([
    [0, '0.0 s'],
    [940, '0.9 s'],
    [12_000, '12.0 s'],
    [59_900, '59.9 s'],
    [60_000, '1m 00s'],
    [65_500, '1m 05s'],
    [3_599_000, '59m 59s'],
    [3_600_000, '1h 00m'],
    [7_845_000, '2h 10m'],
  ])('formats %i ms as %s', (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

suite('AC4 — cost so far', () => {
  it('prefers what the vendor billed over what DeFlow estimated', () => {
    expect(formatSpend(figures({ vendorReported: 0.42, estimated: 0.61 }))).toBe('$0.42');
  });

  it('says an estimate is an estimate, because the two are not the same claim', () => {
    expect(formatSpend(figures({ estimated: 0.61 }))).toBe('~$0.61');
  });

  it('is “not priced” rather than $0.00 when nothing has been priced at all', () => {
    expect(formatSpend(figures())).toBe(NOT_PRICED);
    expect(formatSpend(null)).toBe(NOT_PRICED);
  });

  it('reports a real zero as a zero, which is not the same as unpriced', () => {
    expect(formatSpend(figures({ vendorReported: 0 }))).toBe('$0.00');
  });

  it('puts the same string on the body as the table renders', () => {
    const body = toNodeBody({
      node: node(),
      span: null,
      verdict: null,
      spend: figures({ vendorReported: 1.5 }),
      now: T0,
    });
    expect(body.cost).toBe(formatSpend(figures({ vendorReported: 1.5 })));
  });
});
