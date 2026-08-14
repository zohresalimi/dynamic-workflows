/**
 * KAR-19.12 AC1, AC5 — the one reader of *"is this run waiting on a person, and
 * on what"*.
 *
 * Every state here is folded from **real, parsed events** through `reduce`, for
 * the reason `human-gate.test.ts` gives: a hand-assembled `RunState` would let
 * this module agree with a shape the reducer cannot produce.
 *
 * Verifies: EPIC-19-S79, EPIC-19-S82 · KAR-19.12 AC1, AC5 · test plan #1
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { pendingGate, pendingGateSummary } from './pending-gate.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';
import { SPEC_APPROVAL_OPTIONS, SPEC_GATE_NODE } from './spec-approval.ts';

const RUN_ID = 'run_20260814T013434Z_c984dd';
const NOW = 1_786_670_000_000;

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
}

function parse(row: Row, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: NOW,
    kind: row.kind,
    v: EVENT_SCHEMAS[row.kind].v,
    epoch: 1,
    payload: row.payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${row.kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

function fold(rows: readonly Row[]): RunState {
  let state = initialRunState();
  for (const [index, row] of rows.entries()) state = reduce(state, parse(row, index + 1));
  return state;
}

/** The F1.3 gate, exactly as `openSpecApprovalGate` opens it. */
const specGateOpened: Row = {
  kind: 'human.requested',
  payload: {
    node: SPEC_GATE_NODE,
    prompt: 'Goal\nAdd a hello function',
    options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
  },
};

/** A blocking `human` node mid-run, which opens a gate while the run's own
 * status is still `running` — the case a status word cannot express. */
const nodeGateOpened: Row = {
  kind: 'human.requested',
  payload: {
    node: 'approve-scope',
    prompt: 'Recon found 3 extra packages. Extend the migration scope?',
    options: [
      { id: 'yes', label: 'Extend scope', effect: 'approve' },
      { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
    ],
  },
};

suite('KAR-19.12 AC1 — pendingGate reads the gate off the projection', () => {
  it('names the spec gate and every option it offers', () => {
    const gate = pendingGate(fold([specGateOpened]));

    expect(gate?.node).toBe(SPEC_GATE_NODE);
    expect(gate?.specApproval).toBe(true);
    expect(gate?.options.map((option) => option.id)).toEqual([
      'approve',
      'edit',
      'reject',
      'abandon',
    ]);
    // The labels travel too: an id on its own is DeFlow's vocabulary, and the
    // operator is choosing between sentences.
    expect(gate?.options.map((option) => option.label)).toEqual(
      SPEC_APPROVAL_OPTIONS.map((option) => option.label),
    );
    expect(gate?.requestedSeq).toBe(1);
  });

  it('names a plan-level gate, which no run status word can express', () => {
    const gate = pendingGate(fold([nodeGateOpened]));

    expect(gate?.node).toBe('approve-scope');
    expect(gate?.specApproval).toBe(false);
    expect(gate?.options.map((option) => option.id)).toEqual(['yes', 'no']);
  });

  it('is null once the gate has been answered', () => {
    const answered = fold([
      specGateOpened,
      {
        kind: 'human.responded',
        payload: {
          node: SPEC_GATE_NODE,
          optionId: 'approve',
          at: new Date(NOW).toISOString(),
          by: 'operator',
        },
      },
    ]);

    expect(pendingGate(answered)).toBeNull();
  });

  it('is null for a run that has never asked anything', () => {
    expect(pendingGate(initialRunState())).toBeNull();
  });

  it('answers with the oldest open gate when two are waiting', () => {
    const both = fold([nodeGateOpened, specGateOpened]);
    expect(pendingGate(both)?.node).toBe('approve-scope');
  });
});

suite('KAR-19.12 AC5 — one sentence for every surface that names a gate', () => {
  it('names the gate and the options it offers', () => {
    const gate = pendingGate(fold([specGateOpened]));
    if (gate === null) throw new Error('the gate is open');

    const summary = pendingGateSummary(gate);
    expect(summary).toContain(SPEC_GATE_NODE);
    for (const option of SPEC_APPROVAL_OPTIONS) expect(summary).toContain(option.id);
  });
});
