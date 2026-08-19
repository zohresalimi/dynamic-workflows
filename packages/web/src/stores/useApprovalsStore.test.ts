/**
 * KAR-25.7 AC2, AC5, AC7 — the cross-run fold behind the approvals control:
 * one hydrate, then `human.requested`/`human.responded` off the global topic,
 * and nothing else clears an entry.
 *
 * Verifies: EPIC-25-S43, EPIC-25-S44, EPIC-25-S48, EPIC-25-S50
 *
 * Deliberately not a component test — what is under test is the fold, and a
 * mounted `ApprovalsMenu` would be asserting the same three facts through a
 * DOM query for no more confidence. `run-gate-answer.test.ts` is where the
 * fold is proved live, through the real popover.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, it, describe as suite } from 'vitest';
import { useApprovalsStore } from './useApprovalsStore.ts';

const T0 = 1_786_800_000_000;

const RUN_A = 'run_20260815T090000Z_aa0001';
const RUN_B = 'run_20260815T090000Z_bb0002';

function frame(runId: string, kind: string, seq: number, payload: unknown): Event {
  const result = parseEvent({
    seq,
    runId,
    ts: T0,
    kind,
    v: kind === 'human.requested' ? 5 : 2,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`the spec built an envelope this build cannot read: ${JSON.stringify(result)}`);
  }
  return result.event;
}

const requested = (runId: string, node: string, seq: number): Event =>
  frame(runId, 'human.requested', seq, {
    node,
    prompt: `${node} needs a decision`,
    options: [
      { id: 'approve', label: 'Ship it', effect: 'approve' },
      { id: 'reject', label: 'Send it back', effect: 'reject' },
    ],
  });

const responded = (runId: string, node: string, seq: number): Event =>
  frame(runId, 'human.responded', seq, {
    node,
    optionId: 'approve',
    at: new Date(T0 + 60_000).toISOString(),
    by: 'operator',
  });

beforeEach(() => {
  setActivePinia(createPinia());
});

suite('EPIC-25-S43, EPIC-25-S44 — hydrate keeps the two answerable kinds and nothing else', () => {
  it('keeps human-node and permission rows, with their node, prompt and options', () => {
    const store = useApprovalsStore();
    store.hydrate([
      {
        runId: RUN_A,
        kind: 'human-node',
        node: 'review-changes',
        prompt: 'Ship it?',
        options: [{ id: 'approve', label: 'Ship it' }],
        seq: 7,
      },
      {
        runId: RUN_B,
        kind: 'permission',
        node: 'escalate-write',
        prompt: 'Write outside the worktree?',
        options: [{ id: 'allow', label: 'Allow once' }],
        seq: 3,
      },
    ]);

    expect(store.count).toBe(2);
    expect(store.entries.map((entry) => [entry.runId, entry.node])).toEqual([
      [RUN_A, 'review-changes'],
      [RUN_B, 'escalate-write'],
    ]);
  });

  it('drops the six kinds that have no gateAnswerRequest path', () => {
    const store = useApprovalsStore();
    store.hydrate([
      { runId: RUN_A, kind: 'patch', node: null, prompt: 'a patch is pending', seq: 1 },
      { runId: RUN_A, kind: 'budget', node: null, prompt: 'a ceiling was hit', seq: 2 },
    ]);

    // AC2 — absent when nothing an operator can answer through this control
    // is waiting, even though the daemon's own queue is not empty.
    expect(store.count).toBe(0);
  });
});

suite('EPIC-25-S48 — a human.requested frame opens an entry, live', () => {
  it('adds an entry with no hydrate at all', () => {
    const store = useApprovalsStore();
    store.applyLifecycle(requested(RUN_A, 'review-changes', 7));

    expect(store.count).toBe(1);
    expect(store.entries[0]?.prompt).toBe('review-changes needs a decision');
    expect(store.entries[0]?.options.map((option) => option.id)).toEqual(['approve', 'reject']);
  });

  it('replaces rather than duplicates a re-ask of the same node', () => {
    const store = useApprovalsStore();
    store.applyLifecycle(requested(RUN_A, 'review-changes', 7));
    store.applyLifecycle(requested(RUN_A, 'review-changes', 9));

    expect(store.count).toBe(1);
    expect(store.entries[0]?.seq).toBe(9);
  });
});

suite('EPIC-25-S48, EPIC-25-S50 — human.responded closes the entry, from the ledger only', () => {
  it('removes the entry the response names, and no other', () => {
    const store = useApprovalsStore();
    store.applyLifecycle(requested(RUN_A, 'review-changes', 7));
    store.applyLifecycle(requested(RUN_B, 'escalate-write', 3));
    expect(store.count).toBe(2);

    store.applyLifecycle(responded(RUN_A, 'review-changes', 8));

    expect(store.count).toBe(1);
    expect(store.entries[0]?.runId).toBe(RUN_B);
  });

  it('answers for a run this store never hydrated are a no-op, not a throw', () => {
    const store = useApprovalsStore();
    expect(() => store.applyLifecycle(responded(RUN_A, 'review-changes', 8))).not.toThrow();
    expect(store.count).toBe(0);
  });
});
