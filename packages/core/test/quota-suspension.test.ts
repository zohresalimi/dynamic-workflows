/**
 * KAR-14.4 — the projection half of a quota suspension: what `decide()` asks
 * for while a node is asleep on a vendor's own reset, and what it asks for the
 * moment that instant arrives.
 *
 * Every state here is folded from real, parsed events, for the reason
 * `decide.test.ts` gives: a hand-assembled `RunState` would let `decide` agree
 * with a shape the reducer cannot actually produce.
 *
 * The property with teeth is the **restatement**. `decide()` re-emits every
 * outstanding wake on every tick — that idempotence is what makes the row
 * survive a crash between the event that scheduled it and the row itself. A
 * quota suspension whose restatement came back as `poll` or `backoff` would
 * have its reason overwritten one second after it was written, and AC2's
 * `reason = 'quota'` would hold only until the next tick.
 *
 * Verifies: EPIC-14-S21, EPIC-14-S22 (scenario 2) · AC2
 */
import { expect, it, describe as suite } from 'vitest';
import type { Command, ScheduleWake, StartNode } from '../src/command.ts';
import { WAKE_REASONS } from '../src/command.ts';
import { decide } from '../src/decide.ts';
import type { EventKind } from '../src/event-payloads.ts';
import { EVENT_SCHEMAS } from '../src/event-payloads.ts';
import type { Event } from '../src/events.ts';
import { parseEvent } from '../src/events.ts';
import { SUSPENSION_KINDS } from '../src/node-result.ts';
import { QUOTA_WAKE_REASON } from '../src/rate-limit.ts';
import { reduce } from '../src/reduce.ts';
import { initialRunState, type RunState } from '../src/run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const NOW = 1_754_150_000_000;
const NODE = 'impl-1';
const SIBLING = 'docs';

const hours = (count: number): number => count * 3_600_000;
const days = (count: number): number => count * 86_400_000;

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
}

const agentNode = (id: string): Record<string, unknown> => ({
  id,
  title: `do ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
});

const PLAN: Record<string, unknown> = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN_ID,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-02T14:11:33.000Z',
  nodes: [agentNode(NODE), agentNode(SIBLING)],
  edges: [],
};

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

/**
 * The ledger a quota suspension leaves behind: the attempt failed transiently,
 * the node is suspended on the vendor's own reset, and the retry is due at that
 * same instant. All three land in one transaction (KAR-14.4 AC3); this fixture
 * is what a later tick reads them back as.
 */
const suspendedOnQuota = (wakeAt: number): readonly Row[] => [
  {
    kind: 'plan.proposed',
    payload: { version: 1, planHash: PLAN_HASH, graph: PLAN, by: 'planner' },
  },
  { kind: 'run.started', payload: { planHash: PLAN_HASH } },
  {
    kind: 'node.started',
    payload: {
      node: NODE,
      attempt: 0,
      ikey: `${RUN_ID}/${NODE}/0/0`,
      binary: { path: '/usr/bin/DeFlow-mock-agent', version: '1.0.0', sha256: 'd'.repeat(64) },
    },
  },
  {
    kind: 'node.failed',
    payload: {
      node: NODE,
      attempt: 0,
      failure: {
        reason: 'provider.rate-limited',
        class: 'transient',
        message: 'claude: rate limited until the reset',
        evidence: [],
        occurredAtEvent: 3,
        attempt: 0,
      },
    },
  },
  {
    kind: 'node.suspended',
    payload: {
      node: NODE,
      until: { kind: QUOTA_WAKE_REASON, wakeAt: new Date(wakeAt).toISOString() },
    },
  },
  { kind: 'node.retry.scheduled', payload: { node: NODE, nextAttempt: 1, wakeAt } },
];

const at = (rows: readonly Row[], now: number): readonly Command[] => decide(fold(rows), now);

const wakes = (commands: readonly Command[]): readonly ScheduleWake[] =>
  commands.filter((command): command is ScheduleWake => command.kind === 'ScheduleWake');

const starts = (commands: readonly Command[]): readonly string[] =>
  commands
    .filter((command): command is StartNode => command.kind === 'StartNode')
    .map((command) => command.node);

suite('AC2 — the closed vocabularies gain quota, and say why the node is asleep', () => {
  it('node_wake.reason can express a quota suspension', () => {
    expect(WAKE_REASONS).toEqual(['backoff', 'human_gate', 'poll', 'quota']);
  });

  it('and so can the suspension the timeline renders', () => {
    expect(SUSPENSION_KINDS).toEqual(['human', 'wake', 'external', 'quota']);
    expect(QUOTA_WAKE_REASON).toBe('quota');
  });
});

suite('EPIC-14-S21 — the suspension is one row, restated as quota on every tick', () => {
  const wakeAt = NOW + hours(4);

  it('asks for exactly one wake, at the instant the vendor named, with reason quota', () => {
    const quota = wakes(at(suspendedOnQuota(wakeAt), NOW)).filter((wake) => wake.node === NODE);

    expect(quota).toEqual([
      { kind: 'ScheduleWake', runId: RUN_ID, node: NODE, wakeAt, reason: 'quota' },
    ]);
  });

  it('restates the same reason a tick later, so the row is never downgraded', () => {
    const rows = suspendedOnQuota(wakeAt);
    for (const now of [NOW, NOW + 1_000, NOW + hours(3)]) {
      expect(wakes(at(rows, now)).find((wake) => wake.node === NODE)?.reason).toBe('quota');
    }
  });

  it('starts nothing for that node while it sleeps, and the sibling branch meanwhile', () => {
    const commands = at(suspendedOnQuota(wakeAt), NOW);
    expect(starts(commands)).not.toContain(NODE);
    // NF7: one provider unavailable degrades the plan, it does not stop the run.
    expect(starts(commands)).toContain(SIBLING);
  });

  it('admits the node again the moment the reset arrives', () => {
    const rows = suspendedOnQuota(wakeAt);
    expect(starts(at(rows, wakeAt - 1))).not.toContain(NODE);
    expect(starts(at(rows, wakeAt))).toContain(NODE);
  });
});

suite('EPIC-14-S22 scenario 2 — a 30-day reset is honoured exactly', () => {
  const wakeAt = NOW + days(30);

  it('is a wake no timer could hold, expressed as a plain instant', () => {
    expect(days(30)).toBeGreaterThan(2 ** 31 - 1);
    const [wake] = wakes(at(suspendedOnQuota(wakeAt), NOW)).filter((one) => one.node === NODE);
    expect(wake?.wakeAt).toBe(wakeAt);
    expect(wake?.reason).toBe('quota');
  });

  it('does not admit at 29 days, and does at 30', () => {
    const rows = suspendedOnQuota(wakeAt);
    expect(starts(at(rows, NOW + days(29)))).not.toContain(NODE);
    expect(starts(at(rows, NOW + days(30)))).toContain(NODE);
  });
});
