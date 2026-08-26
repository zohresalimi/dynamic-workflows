/**
 * KAR-28.7 — the status pill renders the one status source, and renders it
 * through `runStatusLabel`.
 *
 * Verifies: EPIC-28-S30, EPIC-28-S31 · AC4, AC6 · test plan #6, #7
 *
 * Two claims, and they pull against each other, which is why both are here.
 *
 * **The composed sentence has to arrive.** Until this story the pill looked
 * `RUN_STATUS_LABELS[status]` up directly, so the best it could print for a run
 * in `spec-approved` was the bare word `planning` — KAR-27.3's
 * *"planner — running · attempt 1 of 3 · since <instant>"* could never reach
 * the frame at all, on any run.
 *
 * **And nothing else may move.** Routing the label through `runStatusLabel`
 * touches every status, so the seven kinds that were already right are asserted
 * kind by kind against `@DeFlow/core`'s own table rather than against a literal
 * — a spelling copied into this file would agree with a reworded table for
 * exactly as long as nobody rewords it.
 */
import { type Event, RUN_STATUS_LABELS } from '@DeFlow/core';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { nextTick } from 'vue';
import { useRunStore } from '../../stores/useRunStore.ts';
import RunStatusPill from './RunStatusPill.vue';

const RUN = 'run_20260826T060745Z_d81b6c';
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

let pinia: ReturnType<typeof createPinia>;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

/** The pill, mounted over a store the caller has already fed. */
async function pillText(): Promise<string> {
  const screen = render(RunStatusPill, { global: { plugins: [pinia] } });
  await nextTick();
  const pill = screen.container.querySelector('[data-run-status-pill]');
  return pill?.querySelector('.run-status-pill__label')?.textContent?.trim() ?? '';
}

suite('EPIC-28-S30 — the composed pre-execution label reaches the pill (AC4)', () => {
  it('shows the planner’s own sentence and not the bare word for spec-approved', async () => {
    const store = useRunStore();
    store.open(RUN);
    store.applyEvent(envelope(1, 'run.created', { spec: { goal: 'Ship it' } }));
    store.applyEvent(envelope(2, 'run.spec.approved', { specHash: 'a'.repeat(64), by: 'ui' }));
    store.applyEvent(
      envelope(
        3,
        'provider.session_opened',
        {
          node: 'planner',
          attempt: 0,
          provider: 'claude',
          session: { id: 's1', origin: 'minted' },
        },
        Date.parse(PLANNER_SINCE),
      ),
    );

    expect(await pillText()).toBe(`planner — running · attempt 1 of 3 · since ${PLANNER_SINCE}`);
    expect(await pillText()).not.toBe(RUN_STATUS_LABELS['spec-approved']);
  });
});

suite('EPIC-28-S31 — the states that already worked still work (AC6)', () => {
  const CASES = [
    ['run.created', { spec: { goal: 'Ship it' } }, RUN_STATUS_LABELS.created],
    ['run.started', { planHash: 'b'.repeat(64) }, RUN_STATUS_LABELS.running],
    ['run.paused', { by: 'user' }, RUN_STATUS_LABELS.paused],
    ['run.resumed', { by: 'user' }, RUN_STATUS_LABELS.running],
    ['run.cancel.requested', { mode: 'cooperative' }, RUN_STATUS_LABELS.cancelling],
    ['run.completed', { outcome: 'success' }, RUN_STATUS_LABELS.completed],
    ['run.aborted', { outcome: 'failed' }, RUN_STATUS_LABELS.aborted],
  ] as const;

  for (const [kind, payload, expected] of CASES) {
    it(`prints ${expected} for ${kind}`, async () => {
      const store = useRunStore();
      store.open(RUN);
      store.applyEvent(envelope(1, kind, payload));

      expect(await pillText()).toBe(expected);
    });
  }
});
