/**
 * KAR-13.3 — the pure half of an interjection: what may be posted at a running
 * node, what the adapter's capability row makes of it, and what the guidance
 * looks like once it is a packet segment.
 *
 * Every state here is folded from **real, parsed events** through `reduce`, for
 * the reason `human-gate.test.ts` gives: a hand-assembled `RunState` would let
 * this module agree with a shape the reducer cannot produce.
 *
 * Verifies: EPIC-13-S18 (the capability outline), EPIC-13-S20 (the two typed
 * refusals), EPIC-13-S21 · AC1, AC2, AC5, AC6, AC7, AC8, AC9 · test plan #1,
 * #2, #3
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import type { NodeId } from './ids.ts';
import { SegmentIdSchema } from './ids.ts';
import type { InterjectionMode } from './interject.ts';
import {
  INTERJECTION_DELIVERIES,
  INTERJECTION_MODES,
  interjectionSegments,
  interjectionsOf,
  planInterjection,
  segmentProvenance,
  undeliveredInterjections,
} from './interject.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const NOW = 1_754_150_000_000;

const IMPL = 'implement' as NodeId;
const GATE = 'approve-scope' as NodeId;
const GHOST = 'never-planned' as NodeId;

const TEXT = "Use the existing useToast composable, don't add a new one.";

const base = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

const agentNode = (id: string): Record<string, unknown> => ({
  ...base(id),
  type: 'agent',
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

const humanNode = (id: string): Record<string, unknown> => ({
  ...base(id),
  type: 'human',
  prompt: 'Recon found 3 extra packages. Extend the migration scope?',
  options: [
    { id: 'yes', label: 'Extend scope', effect: 'approve' },
    { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
  ],
});

const planGraph = (nodes: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN_ID,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-02T14:11:33.000Z',
  nodes,
  edges: [],
});

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

/** `implement` on attempt 1, with the ikey the interjection must not disturb. */
const STARTED = {
  node: IMPL,
  attempt: 1,
  ikey: `${RUN_ID}/${IMPL}/1/0`,
  binary: { path: '/opt/homebrew/bin/claude', version: '2.1.220', sha256: 'b'.repeat(64) },
};

/** A run whose `implement` node is running on attempt 1, plus whatever else. */
function running(rest: readonly Row[] = []): RunState {
  return fold([
    { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'ui' } },
    {
      kind: 'plan.proposed',
      payload: {
        version: 1,
        planHash: PLAN_HASH,
        graph: planGraph([agentNode(IMPL), humanNode(GATE)]),
        by: 'planner',
      },
    },
    { kind: 'run.started', payload: { planHash: PLAN_HASH } },
    { kind: 'node.started', payload: STARTED },
    ...rest,
  ]);
}

const COMPLETED_RESULT = {
  status: 'completed',
  output: { ok: true },
  outputSchemaId: 'DeFlow.finding.v1',
  usage: { inputTokens: 10, outputTokens: 2, source: 'vendor-reported' },
  costUsd: 0,
  producedFacts: [],
  artifacts: [],
};

/** Feeds an accepted plan's own events back through the reducer. */
function apply(state: RunState, events: readonly Row[], fromSeq: number): RunState {
  let next = state;
  let seq = fromSeq;
  for (const row of events) {
    next = reduce(next, parse(row, seq));
    seq += 1;
  }
  return next;
}

const accepted = (
  state: RunState,
  steering: boolean | undefined,
  mode: InterjectionMode = 'next-turn',
) => {
  const outcome = planInterjection(state, { node: IMPL, text: TEXT, mode, steering });
  if (outcome.status !== 'ok') throw new Error(`refused: ${JSON.stringify(outcome)}`);
  return outcome;
};

suite('the closed vocabularies (AC1, AC2)', () => {
  it('names the two modes and the three delivery states, in the API contract order', () => {
    expect(INTERJECTION_MODES).toEqual(['next-turn', 'pause-and-inject']);
    expect(INTERJECTION_DELIVERIES).toEqual(['queued', 'delivered', 'unsupported']);
  });
});

suite('the capability row decides the delivery, not the vendor (AC2, test plan #1)', () => {
  it('returns queued when the row advertises mid-turn steering', () => {
    const outcome = accepted(running(), true);

    expect(outcome.delivery).toBe('queued');
    expect(outcome.events.map((event) => event.kind)).toEqual(['human.interjected']);
    expect(outcome.events[0]?.payload).toEqual({
      node: IMPL,
      text: TEXT,
      mode: 'next-turn',
      delivery: 'queued',
    });
  });

  it.each([
    { steering: true, delivery: 'queued' },
    { steering: false, delivery: 'unsupported' },
    { steering: undefined, delivery: 'unsupported' },
  ])(
    'steering $steering answers $delivery, and never throws (EPIC-13-S18 outline)',
    ({ steering, delivery }) => {
      expect(accepted(running(), steering).delivery).toBe(delivery);
    },
  );

  it('pause-and-inject is queued whatever the row says: it is the mode that always works', () => {
    expect(accepted(running(), false, 'pause-and-inject').delivery).toBe('queued');
    expect(accepted(running(), undefined, 'pause-and-inject').delivery).toBe('queued');
  });

  it('suspends the running node for pause-and-inject, and only for that mode', () => {
    expect(accepted(running(), true, 'pause-and-inject').events.map((event) => event.kind)).toEqual(
      ['human.interjected', 'node.suspended'],
    );
    expect(accepted(running(), true).events.map((event) => event.kind)).toEqual([
      'human.interjected',
    ]);
  });

  it('mints no attempt and schedules no retry, in either mode (AC3)', () => {
    for (const mode of INTERJECTION_MODES) {
      const outcome = accepted(running(), true, mode);
      const kinds = outcome.events.map((event) => event.kind);

      expect(kinds).not.toContain('node.retry.scheduled');
      expect(kinds).not.toContain('node.started');
      expect(outcome.attempt).toBe(1);
    }
  });
});

suite('the refusals are typed, and append nothing (AC6, AC7, test plan #2)', () => {
  it('names POST /respond when the node is a suspended human gate', () => {
    const state = running([
      {
        kind: 'human.requested',
        payload: {
          node: GATE,
          prompt: 'Extend the migration scope?',
          options: [{ id: 'yes', label: 'Extend scope', effect: 'approve' }],
        },
      },
      { kind: 'node.suspended', payload: { node: GATE, until: { kind: 'human' } } },
    ]);

    const outcome = planInterjection(state, {
      node: GATE,
      text: TEXT,
      mode: 'next-turn',
      steering: true,
    });

    expect(outcome.status).toBe('use_respond');
    expect(outcome.status === 'use_respond' && outcome.message).toContain(
      'POST /runs/:id/nodes/:nodeId/respond',
    );
  });

  it('names the terminal state when the node finished while the operator was typing', () => {
    const state = running([
      { kind: 'node.completed', payload: { node: IMPL, attempt: 1, result: COMPLETED_RESULT } },
    ]);

    const outcome = planInterjection(state, {
      node: IMPL,
      text: TEXT,
      mode: 'next-turn',
      steering: true,
    });

    expect(outcome.status).toBe('node_not_running');
    expect(outcome.status === 'node_not_running' && outcome.nodeStatus).toBe('completed');
    expect(outcome.status === 'node_not_running' && outcome.message).toContain('completed');
  });

  it('refuses a node the plan never named', () => {
    const outcome = planInterjection(running(), {
      node: GHOST,
      text: TEXT,
      mode: 'next-turn',
      steering: true,
    });

    expect(outcome.status).toBe('node_not_found');
  });

  it('refuses guidance that says nothing', () => {
    const outcome = planInterjection(running(), {
      node: IMPL,
      text: '   \n ',
      mode: 'next-turn',
      steering: true,
    });

    expect(outcome.status).toBe('empty_text');
  });
});

suite('the projection carries the delivery (AC9)', () => {
  it('folds an unsupported interjection as undelivered, not as a delivered message', () => {
    const outcome = accepted(running(), false);
    const state = apply(
      running(),
      outcome.events.map((event) => ({ kind: event.kind, payload: event.payload })),
      100,
    );

    expect(interjectionsOf(state, IMPL)).toEqual([
      { seq: 100, node: IMPL, text: TEXT, mode: 'next-turn', delivery: 'unsupported' },
    ]);
    // And nothing is offered to a live session that cannot take it.
    expect(undeliveredInterjections(state, IMPL)).toEqual([]);
  });

  it('moves a queued interjection to delivered when the adapter says it went out', () => {
    const posted = accepted(running(), true);
    const queued = apply(
      running(),
      posted.events.map((event) => ({ kind: event.kind, payload: event.payload })),
      100,
    );

    expect(undeliveredInterjections(queued, IMPL)).toEqual([{ seq: 100, text: TEXT }]);

    const delivered = apply(
      queued,
      [{ kind: 'human.interjection.delivered', payload: { node: IMPL, interjectedSeq: 100 } }],
      101,
    );

    expect(interjectionsOf(delivered, IMPL).map((one) => one.delivery)).toEqual(['delivered']);
    expect(undeliveredInterjections(delivered, IMPL)).toEqual([]);
  });

  it('never offers a pause-and-inject interjection to the live session as well', () => {
    const posted = accepted(running(), true, 'pause-and-inject');
    const state = apply(
      running(),
      posted.events.map((event) => ({ kind: event.kind, payload: event.payload })),
      100,
    );

    // Queued, so the UI shows it as accepted — but the packet delivers it, and
    // sending it mid-turn as well would put the same correction twice in front
    // of the agent.
    expect(interjectionsOf(state, IMPL).map((one) => one.delivery)).toEqual(['queued']);
    expect(undeliveredInterjections(state, IMPL)).toEqual([]);
  });

  it('ends the pause when the guidance reaches the re-assembled packet (AC3, AC4)', () => {
    const posted = accepted(running(), true, 'pause-and-inject');
    const paused = apply(
      running(),
      posted.events.map((event) => ({ kind: event.kind, payload: event.payload })),
      100,
    );

    expect(paused.nodes[IMPL]?.status).toBe('suspended');
    expect(paused.nodes[IMPL]?.suspension).toEqual({ kind: 'human' });
    // The run itself is untouched by either half (AC4).
    expect(paused.status).toBe(running().status);

    const resumed = apply(
      paused,
      [{ kind: 'human.interjection.delivered', payload: { node: IMPL, interjectedSeq: 100 } }],
      102,
    );

    expect(resumed.nodes[IMPL]?.status).toBe('running');
    expect(resumed.nodes[IMPL]?.suspension).toBeNull();
    // The same attempt, and no retry anywhere in sight.
    expect(resumed.nodes[IMPL]?.attempt).toBe(1);
    expect(resumed.nodes[IMPL]?.attempts).toBe(2);
    expect(resumed.status).toBe(running().status);
  });

  it('ignores a delivery receipt for an interjection this projection never saw', () => {
    const state = apply(
      running(),
      [{ kind: 'human.interjection.delivered', payload: { node: IMPL, interjectedSeq: 999 } }],
      100,
    );

    expect(interjectionsOf(state, IMPL)).toEqual([]);
  });
});

suite('the guidance is an attributed segment (EPIC-13-S21, AC5, AC8, test plan #3)', () => {
  /** Three interjections posted before the node's next turn, out of order. */
  function three(): RunState {
    const state = running();
    const rows: Row[] = [
      { kind: 'human.interjected', payload: interjected('first') },
      { kind: 'human.interjected', payload: interjected('second') },
      { kind: 'human.interjected', payload: interjected('third') },
    ];
    return apply(state, rows, 100);
  }

  const interjected = (text: string): Record<string, unknown> => ({
    node: IMPL,
    text,
    mode: 'next-turn',
    delivery: 'queued',
  });

  it('carries the operator’s text byte-identically and the seq that produced it', async () => {
    const state = apply(
      running(),
      [{ kind: 'human.interjected', payload: interjected(TEXT) }],
      100,
    );
    const [segment] = await interjectionSegments({ interjections: interjectionsOf(state, IMPL) });

    expect(segment?.text).toBe(TEXT);
    expect(segment?.sourceEvent).toBe(100);
    expect(segmentProvenance(segment!)).toBe('human');
  });

  it('renders all three in seq order, with none coalesced or dropped', async () => {
    const segments = await interjectionSegments({ interjections: interjectionsOf(three(), IMPL) });

    expect(segments.map((segment) => segment.text)).toEqual(['first', 'second', 'third']);
    expect(segments.map((segment) => segment.sourceEvent)).toEqual([100, 101, 102]);
    expect(new Set(segments.map((segment) => segment.id)).size).toBe(3);
  });

  it('is not pinned, and is compactable like any other non-pinned segment', async () => {
    const segments = await interjectionSegments({ interjections: interjectionsOf(three(), IMPL) });

    for (const segment of segments) {
      expect(segment.pinned).toBe(false);
      expect(segment.compactable).toBe(true);
    }
  });

  it('reads a segment DeFlow itself assembled as deflow-provenance, not human', async () => {
    const segments = await interjectionSegments({ interjections: interjectionsOf(three(), IMPL) });
    const segment = segments[0];
    if (segment === undefined) throw new Error('three interjections produced no segment');

    expect(segmentProvenance({ ...segment, id: SegmentIdSchema.parse('brief') })).toBe('deflow');
  });
});
