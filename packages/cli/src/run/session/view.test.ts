/**
 * KAR-21.1 AC3, AC4, AC7, AC9 / EPIC-21-S01, S02, S06, S09 — what the operator
 * sees is a value a test can hold.
 *
 * The whole design of this story is in the signature: `(RunState, SessionState,
 * Style) -> readonly string[]`. There is no terminal to look at, no clock to
 * wait for and no module-level state to reset between cases, which is why every
 * scenario here costs milliseconds and why none of them is `manual`.
 *
 * The states are built by spreading `initialRunState()` rather than by folding
 * a hand-written ledger, the way `../exit-codes.test.ts` already does for the
 * same reason: the spread is *typed*, so a field added to `RunState` or to
 * `NodeState` breaks this file at compile time, whereas a hand-built event that
 * misses a field is appended happily and skipped at read time.
 *
 * The Then clauses name existing functions on purpose — `RUN_STATUS_LABELS`,
 * `TRANSCRIPT_GLYPHS`, `formatDuration`, `formatCost`, `pendingGateSummary`.
 * That is AC4 stated as a test: the frame is a **composition** of KAR-18.9's
 * layer, and an assertion that had to name a new rendering rule would be
 * evidence that a second presentation layer was being built.
 *
 * Verifies: EPIC-21-S01, EPIC-21-S02, EPIC-21-S06, EPIC-21-S09 · AC3, AC4,
 * AC7, AC9 · test plan #1, #2, #6, #9
 */
import type { NodeId, NodeState, RunId, RunState } from '@DeFlow/core';
import { initialRunState, pendingGate, pendingGateSummary, RUN_STATUS_LABELS } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { TRANSCRIPT_GLYPHS } from '../../render/glyphs.ts';
import { createStyle, type Style } from '../../render/style.ts';
import { formatCost, formatDuration } from '../render.ts';
import { initialSessionState, type SessionState } from './state.ts';
import { renderFrame } from './view.ts';

const RUN_ID = 'run_20260816T101500Z_0a0a0a' as RunId;

/** The instant the caller measured through its injected `Clock` (NF9). */
const NOW = 1_760_000_000_000;

const node = (over: Partial<NodeState>): NodeState => ({
  status: 'scheduled',
  attempt: 0,
  attempts: 1,
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
  updatedSeq: 1,
  ...over,
});

/** EPIC-21-S01's state: four nodes, one of them running for 95 seconds. */
function midFlight(over: Partial<RunState> = {}): RunState {
  const base = initialRunState();
  return {
    ...base,
    runId: RUN_ID,
    status: 'running',
    nodes: {
      n_recon_1: node({ status: 'completed' }),
      n_impl_2: node({ status: 'running', startedTs: NOW - 95_000 }),
      n_impl_3: node({ status: 'scheduled' }),
      n_impl_4: node({ status: 'failed', attempt: 1, attempts: 2 }),
    },
    budget: {
      ...base.budget,
      run: {
        ...base.budget.run,
        costUsd: { subscription: 0, apiKey: 1.2, vendorReported: null, estimated: null },
      },
    },
    ...over,
  };
}

const session = (over: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState(),
  nowMs: NOW,
  rows: 24,
  ...over,
});

const styleAt = (width: number): Style =>
  createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' }, columns: width });

const glyphs = TRANSCRIPT_GLYPHS.utf8;

suite('EPIC-21-S01 — the frame is a pure function of the run state (AC3, AC4)', () => {
  it('names the run and its RUN_STATUS_LABELS status on the first line', () => {
    const lines = renderFrame(midFlight(), session(), styleAt(80));

    expect(lines[0]).toContain(RUN_ID);
    expect(lines[0]).toContain(RUN_STATUS_LABELS.running);
  });

  it('gives every node a row carrying its TRANSCRIPT_GLYPHS glyph', () => {
    const text = renderFrame(midFlight(), session(), styleAt(80)).join('\n');

    for (const [id, glyph] of [
      ['n_recon_1', glyphs.done],
      ['n_impl_2', glyphs.active],
      ['n_impl_3', glyphs.pending],
      ['n_impl_4', glyphs.gone],
    ] as const) {
      const row = text.split('\n').find((line) => line.includes(id));
      expect(row, `no row for ${id}`).toBeDefined();
      expect(row).toContain(glyph);
    }
  });

  it("carries the running node's elapsed time as formatDuration renders it", () => {
    const text = renderFrame(midFlight(), session(), styleAt(80)).join('\n');
    const row = text.split('\n').find((line) => line.includes('n_impl_2')) ?? '';

    expect(formatDuration(95_000)).toBe('1m 35s');
    expect(row).toContain('1m 35s');
  });

  it('prints the four cost cells as formatCost names them, and sums nothing', () => {
    const state = midFlight();
    const text = renderFrame(state, session(), styleAt(80)).join('\n');

    expect(text).toContain(formatCost(state.budget.run.costUsd));
    expect(text).toContain('$1.20 api-key');
    expect(text).toContain('$0.00 subscription');
    // The sum of the two cells, which is a number that is true of nothing.
    expect(text).not.toContain('$1.20,');
    expect(text).not.toContain('1.2 total');
  });

  it("shows the open gate's summary, in pendingGateSummary's words", () => {
    const state = midFlight({
      status: 'needs-human',
      humanGates: {
        'spec-approval': {
          node: 'spec-approval' as NodeId,
          prompt: 'Approve this spec?',
          options: [
            { id: 'approve', label: 'Approve this spec and start planning', effect: 'approve' },
            { id: 'reject', label: 'Reject and re-run the framing interview', effect: 'reject' },
          ],
          requestedSeq: 7,
          response: null,
          deadline: null,
          escalated: false,
          reason: null,
          permission: null,
        },
      },
    } as Partial<RunState>);

    const gate = pendingGate(state);
    expect(gate).not.toBeNull();
    const text = renderFrame(state, session(), styleAt(80)).join('\n');

    expect(text).toContain(pendingGateSummary(gate as NonNullable<typeof gate>));
  });

  it('is pure: two renders of one state are equal, and nothing was read', () => {
    const state = midFlight();
    const first = renderFrame(state, session(), styleAt(80));
    const second = renderFrame(state, session(), styleAt(80));

    expect(second).toEqual(first);
    // A frozen state would throw on any write, and a frozen session with it.
    expect(() =>
      renderFrame(Object.freeze(state), Object.freeze(session()), styleAt(80)),
    ).not.toThrow();
  });
});

suite('EPIC-21-S02 — the frame fits the window it is actually in (AC7)', () => {
  const longWorktree = `/tmp/${'deflow-worktree-segment/'.repeat(4)}n_impl_2`;

  for (const width of [80, 40, 20]) {
    it(`wraps rather than running off the edge at ${String(width)} columns`, () => {
      const state = midFlight({
        nodes: {
          ...midFlight().nodes,
          n_impl_2: node({ status: 'running', startedTs: NOW - 95_000, worktree: longWorktree }),
        },
      });
      // A tall window on purpose: this scenario is about the *width*, and a
      // row budget that dropped the long row would pass it for the wrong
      // reason. AC7's fraction is EPIC-21-S06's subject, not this one's.
      const lines = renderFrame(state, session({ rows: 60 }), styleAt(width));

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        if (line.length <= width) continue;
        // AC4's one deliberate exception, and KAR-18.9's: a token wider than
        // the column is emitted whole rather than broken, because half a path
        // is worse than a long line.
        expect(
          line.trim(),
          `only a single unbreakable token may exceed ${String(width)}: ${JSON.stringify(line)}`,
        ).not.toMatch(/\s/);
      }
      // Nothing was truncated: the whole path is still somewhere in the frame.
      expect(lines.join('\n')).toContain(longWorktree);
    });
  }

  it('indents a continuation line to the column its row began its detail at', () => {
    const state = midFlight({
      nodes: {
        ...midFlight().nodes,
        n_impl_2: node({ status: 'running', startedTs: NOW - 95_000, worktree: longWorktree }),
      },
    });
    const lines = renderFrame(state, session({ rows: 60 }), styleAt(80));
    const index = lines.findIndex((line) => line.includes('n_impl_2'));
    const continuation = lines[index + 1] ?? '';

    expect(continuation).toMatch(/^ {4,}\S/);
    expect(lines[index]?.indexOf('1m 35s')).toBe(continuation.search(/\S/));
  });
});

suite('EPIC-21-S06 — a big plan does not push the important line off the screen', () => {
  /** Forty nodes, three of them running, and a gate waiting behind them. */
  function bigPlan(): RunState {
    const nodes: Record<string, NodeState> = {};
    for (let index = 0; index < 40; index += 1) {
      const id = `n_${String(index).padStart(2, '0')}`;
      nodes[id] = node(
        index < 3
          ? { status: 'running', startedTs: NOW - 1_000 * (index + 1) }
          : { status: index % 2 === 0 ? 'completed' : 'scheduled' },
      );
    }
    return midFlight({
      status: 'needs-human',
      nodes,
      humanGates: {
        'confirm-scope': {
          node: 'confirm-scope' as NodeId,
          prompt: 'Recon found two more packages. Keep going?',
          options: [
            { id: 'continue', label: 'Keep going', effect: 'approve' },
            { id: 'stop', label: 'Stop here', effect: 'reject' },
          ],
          requestedSeq: 11,
          response: null,
          deadline: null,
          escalated: false,
          reason: null,
          permission: null,
        },
      },
    } as Partial<RunState>);
  }

  it('fits the stated fraction of the terminal rows', () => {
    const lines = renderFrame(bigPlan(), session({ rows: 24 }), styleAt(80));

    expect(lines.length).toBeLessThanOrEqual(8);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('keeps every running node, the gate and an exact +N more', () => {
    const state = bigPlan();
    const lines = renderFrame(state, session({ rows: 24 }), styleAt(80));
    const text = lines.join('\n');

    for (const id of ['n_00', 'n_01', 'n_02']) expect(text).toContain(id);

    const gate = pendingGate(state);
    expect(text).toContain(pendingGateSummary(gate as NonNullable<typeof gate>));

    // Anchored, because `run_20260816T101500Z_…` contains the substring `n_20`
    // and an unanchored count would silently include a node that has no row.
    const shown = Object.keys(state.nodes).filter((id) =>
      new RegExp(String.raw`\b${id}\b`).test(text),
    ).length;
    expect(text).toContain(`+${String(40 - shown)} more`);
  });

  it('drops rows rather than truncating one mid-token', () => {
    const lines = renderFrame(bigPlan(), session({ rows: 24 }), styleAt(80));

    expect(lines.join('\n')).not.toContain('…');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
  });
});

suite('EPIC-21-S09 — two sessions in one process do not share a screen state', () => {
  it("B's frame has no input row while A's still does", () => {
    const state = midFlight();
    const withInput = session({
      input: { kind: 'interject', prompt: 'say something to n_impl_2', text: 'try the other port' },
    });
    const withoutInput = session();

    const a = renderFrame(state, withInput, styleAt(80)).join('\n');
    const b = renderFrame(state, withoutInput, styleAt(80)).join('\n');

    expect(a).toContain('try the other port');
    expect(b).not.toContain('try the other port');
    // And A is unchanged by B having been rendered afterwards, which is the
    // whole of "no module-level variable holds screen state".
    expect(renderFrame(state, withInput, styleAt(80)).join('\n')).toBe(a);
  });
});
