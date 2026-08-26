/**
 * KAR-28.7 — one source of a run's status, and an answered gate that lets go
 * of it.
 *
 * Verifies: EPIC-28-S26, EPIC-28-S27, EPIC-28-S28, EPIC-28-S30 · AC1, AC2,
 * AC4, AC5 · test plan #1, #2, #3, #5
 *
 * **The defect, as observed.** On 2026-08-26 the web showed a status pill
 * reading *needs a decision* for `run_20260826T060745Z_d81b6c` while the run
 * was planning. The daemon was right the whole time — both `GET /api/runs` and
 * `GET /api/runs/:id` answered `spec-approved` with no pending gate — and the
 * web was wrong because it kept a sticky per-kind status table of its own in
 * which `human.requested` latched `needs-human` and *nothing* could take it
 * off again: neither `human.responded` nor `run.spec.approved` owned an entry,
 * and a run emits none of the six kinds that did between spec approval and the
 * planner adopting a plan.
 *
 * So the assertions here are all about the latch **clearing**. The one that
 * pins it engaging already exists (`../app/frame.test.ts`, AC5) and is left
 * exactly as it was.
 *
 * The envelopes are literals cast to `Event` rather than `parseEvent` output,
 * which is `../app/frame.test.ts`'s own convention and is deliberate here: a
 * `run.created` payload that satisfies `RunCreatedSchema` carries a whole
 * sealed `TaskSpec`, and none of the folds under test reads one. What each
 * fold *does* read is spelled out in full.
 */
import { type Event, RUN_STATUS_LABELS, SPEC_GATE_NODE_ID } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, it, describe as suite } from 'vitest';
import { useRunListStore } from './useRunListStore.ts';
import { useRunStore } from './useRunStore.ts';

/** The run the report was written about. */
const RUN = 'run_20260826T060745Z_d81b6c';

/** The instant the daemon composed its label from, verbatim from the report. */
const PLANNER_SINCE = '2026-08-26T06:16:16.589Z';

const BASE = 1_756_180_000_000;

function envelope(seq: number, kind: string, payload: Record<string, unknown>, ts?: number): Event {
  return {
    seq,
    runId: RUN,
    ts: ts ?? BASE + seq,
    kind,
    v: 1,
    epoch: 1,
    payload,
  } as unknown as Event;
}

const created = (seq: number): Event => envelope(seq, 'run.created', { spec: { goal: 'Ship it' } });

const gateOpened = (seq: number, node: string): Event =>
  envelope(seq, 'human.requested', {
    node,
    prompt: 'Approve this spec?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
  });

const gateAnswered = (seq: number, node: string): Event =>
  envelope(seq, 'human.responded', {
    node,
    optionId: 'approve',
    at: '2026-08-26T06:16:16.000Z',
    by: 'operator',
  });

const specApproved = (seq: number): Event =>
  envelope(seq, 'run.spec.approved', { specHash: 'a'.repeat(64), by: 'ui' });

/** The `provider.session_opened` the planner's turn is measured from. */
const plannerOpened = (seq: number): Event =>
  envelope(
    seq,
    'provider.session_opened',
    { node: 'planner', attempt: 0, provider: 'claude', session: { id: 's1', origin: 'minted' } },
    Date.parse(PLANNER_SINCE),
  );

beforeEach(() => {
  setActivePinia(createPinia());
});

function openStore(): ReturnType<typeof useRunStore> {
  const store = useRunStore();
  store.open(RUN);
  return store;
}

suite('EPIC-28-S26 — an answered gate lets go of the pill (AC1, AC5)', () => {
  it('moves off needs-human on the human.responded that closes the gate', () => {
    const store = openStore();
    store.applyEvent(created(1));
    store.applyEvent(gateOpened(2, 'n1'));

    // The latch engaging, which is the half that already worked.
    expect(store.statusView?.status).toBe('needs-human');
    expect(store.statusView?.label).toBe(RUN_STATUS_LABELS['needs-human']);

    store.applyEvent(gateAnswered(3, 'n1'));

    expect(store.statusView?.status).not.toBe('needs-human');
    expect(store.statusView?.label).not.toBe(RUN_STATUS_LABELS['needs-human']);
  });
});

suite('EPIC-28-S27 — approving a spec also releases it (AC1)', () => {
  it('follows the daemon’s spec-approved rather than staying on needs-human', () => {
    const store = openStore();
    store.applyEvent(created(1));
    store.applyEvent(gateOpened(2, SPEC_GATE_NODE_ID));
    expect(store.statusView?.status).toBe('needs-human');

    store.applyEvent(specApproved(3));

    expect(store.statusView?.status).toBe('spec-approved');
  });
});

suite('EPIC-28-S30 — the composed pre-execution label reaches the frame (AC4)', () => {
  it('renders the ledger of run_20260826T060745Z_d81b6c as the planner’s own sentence', () => {
    const store = openStore();
    // The path the reported run actually took: framed, gated, answered,
    // approved, and then the planner's session opened.
    store.applyEvent(created(1));
    store.applyEvent(gateOpened(2, SPEC_GATE_NODE_ID));
    store.applyEvent(gateAnswered(3, SPEC_GATE_NODE_ID));
    store.applyEvent(specApproved(4));
    store.applyEvent(plannerOpened(5));

    expect(store.statusView?.status).toBe('spec-approved');
    expect(store.statusView?.label).toBe(
      `planner — running · attempt 1 of 3 · since ${PLANNER_SINCE}`,
    );
    // Not the bare word a direct `RUN_STATUS_LABELS` lookup can manage.
    expect(store.statusView?.label).not.toBe(RUN_STATUS_LABELS['spec-approved']);
  });
});

suite('EPIC-28-S28 — the run-list row is fixed with the pill, not after it (AC1)', () => {
  const row = () => useRunListStore().rows[0];

  function hydrated(status: 'running' | 'needs-human'): ReturnType<typeof useRunListStore> {
    const list = useRunListStore();
    list.hydrate([
      {
        runId: RUN,
        status,
        label: RUN_STATUS_LABELS[status],
        title: 'Ship it',
        createdAt: '2026-08-26T06:07:45.000Z',
        headSeq: 1,
        planVersion: 0,
        gate: null,
        cancelWaiting: null,
      },
    ]);
    return list;
  }

  it('moves the row’s status and its label when the gate is answered', () => {
    const list = hydrated('running');

    list.applyLifecycle(gateOpened(2, 'n1'));
    expect(row()?.status).toBe('needs-human');
    expect(row()?.label).toBe(RUN_STATUS_LABELS['needs-human']);
    expect(row()?.gate?.node).toBe('n1');

    list.applyLifecycle(gateAnswered(3, 'n1'));

    // Both, not only the gate line: a row that keeps the stale sentence after
    // the pill is fixed is the same defect one surface over.
    expect(row()?.status).toBe('running');
    expect(row()?.label).toBe(RUN_STATUS_LABELS.running);
    expect(row()?.gate).toBeNull();
  });

  it('lets go of a row the daemon itself hydrated as needs-human', () => {
    const list = hydrated('needs-human');
    list.applyLifecycle(gateOpened(2, 'n1'));

    list.applyLifecycle(gateAnswered(3, 'n1'));

    expect(row()?.status).not.toBe('needs-human');
    expect(row()?.label).not.toBe(RUN_STATUS_LABELS['needs-human']);
  });
});
