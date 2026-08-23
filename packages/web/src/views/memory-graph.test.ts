/**
 * KAR-17.9 test plan rows 4 and 5 — the memory graph in a real Chromium.
 *
 * Verifies: EPIC-17-S33 · AC1, AC2, AC3, AC4, AC7
 *
 * The aggregation itself is asserted without a browser
 * (`../ledger/projections/memory-graph.test.ts`). What is here is the half only
 * a browser can answer, and it is two claims:
 *
 * 1. **Row 4 — three thousand facts do not reach the DOM.** The red the test
 *    plan names is *"the default view renders raw facts"*, and the control is
 *    what makes the number mean something: the same view over a thirty-fact
 *    ledger draws the same forty-two bubbles, so the two timings are a
 *    measurement of the *graph* rather than of the machine.
 * 2. **Row 5 — the consumer set is fetched, not inferred.** The fake daemon
 *    answers with a reader this tab never saw a `fact.read` for, so a view that
 *    built its list out of the projection it is already holding cannot pass.
 */
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { commands } from 'vitest/browser';
import {
  type ConsumersAsked,
  consumersFetch,
  FACTS_API_BASE,
  type FactConsumerRow,
} from '../../test/facts-daemon.ts';
import { HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { memoryStressLedger, STRESS_RUN } from '../../test/memory-stress.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';

/** KAR-25.1 — the run views are project-scoped now; the value is never
 * asserted on, only threaded through so the named route resolves. */
const PROJECT_ID = 'prj_test';

import { createClient } from '../api/client.ts';
import { useRunStore } from '../stores/useRunStore.ts';

/** The fact `plan-migration` wrote, and `review-security` later invalidated. */
const GUARD_FACT = 'fact_e8d87892b0287c860826701c30';

let shell: MountedShell;
let asked: ConsumersAsked[];

const one = (selector: string): HTMLElement | null =>
  shell.container.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

/**
 * Clicks something **inside the canvas**.
 *
 * `element.click()` rather than `userEvent.click`, the way the scrubber's specs
 * click a node body, and for a reason that is about the fixture rather than
 * about the view: the renderer's minimap is an overlay panel pinned to the
 * bottom-right of the pane, and in a 480-pixel test container it sits on top of
 * whichever node the layout put there. A real pointer is refused by it; the
 * operator on a real screen pans or scrolls. What is under test here is what
 * the view does when a node is activated, not the renderer's hit testing.
 */
const press = (selector: string): void => {
  const target = one(selector);
  if (target === null) throw new Error(`nothing matched ${selector}`);
  target.click();
};

/**
 * How long a poll may wait for the canvas to draw — **not** a budget.
 *
 * Nothing bearing `data-memory-node` can exist until three things that have
 * nothing to do with the aggregation have happened: `GraphCanvas` dynamically
 * imports `./layout.ts` so that elkjs stays out of the initial chunk (KAR-17.1
 * AC5), that engine starts a worker of its own per canvas, and ELK lays 42
 * boxes out inside it. Measured on this branch, cold, the first bubble of the
 * three-thousand-fact graph arrives at 1641 / 1816 / 2286 ms across three runs
 * — so Vitest's 1 s default made the *worker boot* the assertion and turned
 * every stress row red before a single number this file cares about was read.
 *
 * 15 s is the figure every other canvas spec already waits with — `plan-graph`,
 * `plan-scrubber`, `plan-before-results`, `live-graph` and `GraphCanvas`'s own
 * — and this file was the one that omitted it. The timing claim KAR-17.9 AC7
 * actually makes is untouched and still the only budget here: three thousand
 * facts against a thirty-fact control on the same machine, ceilinged at four
 * times it (below). A ceiling that big is why raising this wait cannot hide a
 * regression — a graph that got slower fails on the ratio, which is the number
 * the story is about, rather than on how long Chromium took to start a worker.
 */
const DRAWN = { timeout: 15_000 } as const;

interface OpenOptions {
  readonly runId?: string;
  readonly events?: readonly ReturnType<typeof happyPath12>[number][];
  readonly consumers?: ReadonlyMap<string, readonly FactConsumerRow[]>;
}

/** Mounts the memory route over `events`, and waits for the first bubble. */
async function openMemory(options: OpenOptions = {}): Promise<number> {
  asked = [];
  const runId = options.runId ?? HAPPY_PATH_RUN;
  shell = await mountShell({
    at: { name: 'run-memory', params: { projectId: PROJECT_ID, runId } },
    client: createClient({
      baseUrl: FACTS_API_BASE,
      fetch: consumersFetch(options.consumers ?? new Map(), asked),
    }),
  });
  setActivePinia(shell.pinia);
  const run = useRunStore(shell.pinia);
  const started = performance.now();
  for (const event of options.events ?? happyPath12()) run.applyEvent(event);
  await expect.poll(() => all('[data-memory-node]').length, DRAWN).toBeGreaterThan(0);
  return performance.now() - started;
}

beforeEach(async () => {
  setActivePinia(undefined as never);
  await commands.emulateMedia({ reducedMotion: 'no-preference' });
});

afterEach(() => {
  shell?.unmount();
});

suite('KAR-17.9 test 4 — three thousand facts, forty-two bubbles (AC1, AC7)', () => {
  it('draws one bubble per node and no raw facts at all', async () => {
    const big = memoryStressLedger();
    expect(big.facts).toBe(3000);

    await openMemory({ runId: STRESS_RUN, events: big.events });
    await expect.poll(() => all('[data-memory-node]').length, DRAWN).toBe(42);

    expect(all('[data-memory-kind="fact"]')).toHaveLength(0);
    // The count is on the bubble, which is what makes the aggregate readable
    // rather than merely small.
    expect(one('[data-memory-node="node:producer-0"]')?.dataset['factCount']).toBe('100');
  });

  it('is no slower with three thousand facts than with thirty', async () => {
    // The control and the measurement draw the *same graph* — forty-two
    // bubbles — off blackboards two orders of magnitude apart. A view that
    // rendered facts would not be able to say that, and a budget stated as a
    // constant would be a statement about this laptop rather than about the
    // aggregation. Measured on the same machine, seconds apart, exactly as
    // EPIC-05 measured its two timing budgets.
    const control = await openMemory({
      runId: STRESS_RUN,
      events: memoryStressLedger({ factsPerProducer: 1, consumersPerFact: 2 }).events,
    });
    await expect.poll(() => all('[data-memory-node]').length, DRAWN).toBe(42);
    shell.unmount();

    const measured = await openMemory({ runId: STRESS_RUN, events: memoryStressLedger().events });
    await expect.poll(() => all('[data-memory-node]').length, DRAWN).toBe(42);

    const ceiling = Math.max(control * 4, 1500);
    expect(
      measured,
      `three thousand facts took ${measured.toFixed(0)} ms against a thirty-fact control of ` +
        `${control.toFixed(0)} ms (ceiling ${ceiling.toFixed(0)} ms)`,
    ).toBeLessThanOrEqual(ceiling);
  });
});

suite('KAR-17.9 test 5 — a fact’s provenance, and its complete consumer set (AC3)', () => {
  const CONSUMERS = new Map<string, readonly FactConsumerRow[]>([
    [
      GUARD_FACT,
      [
        { node: 'impl-login', firstReadSeq: 22, reads: 1 },
        // A reader this tab never saw a `fact.read` for — it joined mid-run.
        // The whole point of AC3's *"complete consumer set"*.
        { node: 'impl-profile', firstReadSeq: 24, reads: 3 },
      ],
    ],
  ]);

  /** Expands `plan-migration` and opens the one fact it wrote. */
  async function openGuardFact(): Promise<void> {
    await openMemory({ consumers: CONSUMERS });
    press('[data-memory-node="node:plan-migration"] [data-memory-expand]');
    await expect.poll(() => all('[data-memory-kind="fact"]').length, DRAWN).toBe(1);
    press(`[data-memory-node="fact:${GUARD_FACT}"]`);
    await expect.poll(() => one(`[data-fact-detail="${GUARD_FACT}"]`), DRAWN).not.toBeNull();
  }

  it('shows the writing node, its evidence, the timestamp and the confidence', async () => {
    await openGuardFact();

    const detail = one(`[data-fact-detail="${GUARD_FACT}"]`);
    expect(detail?.querySelector('[data-provenance-node]')?.textContent).toContain(
      'plan-migration',
    );
    // `asserted`, which is the fixture's own value and the interesting one:
    // the fact an operator is about to find was wrong was never verified.
    expect(detail?.querySelector('[data-provenance-confidence]')?.textContent).toContain(
      'asserted',
    );
    expect(detail?.querySelector('[data-provenance-at]')?.textContent).toContain('2026-08-11');
    expect(detail?.querySelectorAll('[data-evidence-handle]')).toHaveLength(1);
  });

  it('fetches the consumer set rather than reading it off its own edges', async () => {
    await openGuardFact();

    expect(asked).toEqual([{ runId: HAPPY_PATH_RUN, factId: GUARD_FACT }]);
    expect(all('[data-fact-consumer]').map((row) => row.dataset['factConsumer'])).toEqual([
      'impl-login',
      'impl-profile',
    ]);
    expect(one('[data-fact-consumer="impl-profile"]')?.textContent).toContain('3');
  });

  it('renders an invalidated fact distinctly, and highlights everything it tainted', async () => {
    await openGuardFact();

    expect(one(`[data-memory-node="fact:${GUARD_FACT}"]`)?.dataset['invalid']).toBe('true');
    expect(one(`[data-fact-detail="${GUARD_FACT}"] [data-fact-invalid]`)?.textContent).toContain(
      'the guard shape changed in the router upgrade',
    );

    // `taints: [impl-login, impl-signup]` — and `impl-signup` never read this
    // fact. A graph that highlighted its own consumers would miss it.
    expect(one('[data-memory-node="node:impl-signup"]')?.dataset['tainted']).toBe('true');
    expect(one('[data-memory-node="node:impl-login"]')?.dataset['tainted']).toBe('true');
    expect(one('[data-memory-node="node:review-security"]')?.dataset['tainted']).toBe('false');
  });

  it('pages an expansion rather than growing it without bound (AC2)', async () => {
    const big = memoryStressLedger({ producers: 1, factsPerProducer: 900, consumersPerFact: 1 });
    await openMemory({ runId: STRESS_RUN, events: big.events });

    press('[data-memory-node="node:producer-0"] [data-memory-expand]');
    await expect.poll(() => all('[data-memory-kind="fact"]').length, DRAWN).toBe(50);

    expect(one('[data-memory-page]')?.textContent).toContain('1–50 of 900');

    press('[data-memory-next]');
    await expect
      .poll(() => one('[data-memory-page]')?.textContent, DRAWN)
      .toContain('51–100 of 900');
    expect(all('[data-memory-kind="fact"]')).toHaveLength(50);

    // Collapsing restores the aggregate.
    press('[data-memory-node="node:producer-0"] [data-memory-expand]');
    await expect.poll(() => all('[data-memory-kind="fact"]').length, DRAWN).toBe(0);
  });
});
