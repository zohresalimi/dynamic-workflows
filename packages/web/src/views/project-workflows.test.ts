/**
 * KAR-22.3 — this project's workflows view, in a real Chromium: the live
 * graph, the task board beside it, the history under both, and what happens
 * when the operator switches project.
 *
 * File and route renamed by KAR-25.1 (`ProjectWorkspaceView` →
 * `ProjectWorkflowsView`, `project-workspace` → `project-workflows`); the
 * `data-workspace-*` selectors below did not move with it — see
 * `ProjectWorkflowsView.vue`'s own header comment for why.
 *
 * Verifies: EPIC-22-S34, EPIC-22-S36, EPIC-22-S37, EPIC-22-S38, EPIC-22-S41,
 * EPIC-22-S42, EPIC-22-S43, EPIC-22-S46 · AC1, AC2, AC3, AC6, AC7 ·
 * test plan #1, #3, #4, #5, #8, #9, #10
 *
 * Two substitutions and no more, both at the seams the shell already has:
 *
 * - **The API client**, because what several of these specs assert is *which
 *   request the workspace made* — `GET /api/projects/:id/runs` and not a global
 *   list it then sieved.
 * - **The run feed**, because the real one opens an SSE connection against the
 *   runner's own origin, which is a Vite dev server. Frames are pushed onto the
 *   very `sink` the real feed pours into (`../ledger/feed.ts`), so the path from
 *   frame to pixel is the shipped one; the socket itself is asserted end to end
 *   in `test/integration/project-workspace-hydrate.test.ts` and in
 *   `e2e/plan-graph.test.ts` against real daemons.
 *
 * The events are the `happy-path-12` **recording**, not hand-built view models:
 * all seven display states occur in it at once, which is what lets AC2's
 * colour-blind matrix run over a real fold rather than over seven objects that
 * agree with the component by construction.
 */
import type { Event } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { HAPPY_PATH_RUN, happyPath12 } from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
import { startLeakAssertion } from '../app/leak-assert.ts';
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';
import { DISPLAY_STATES, STATE_LABELS } from '../lib/state-palette.ts';
import { type RunStoreCounts, useRunStore } from '../stores/useRunStore.ts';

const PROJECT_A = 'prj_20260815T101112Z_a1b2c3';
const PROJECT_B = 'prj_20260815T101113Z_b2c3d4';
/** The finished run in project A's history, older than the live one. */
const EARLIER_RUN = 'run_20260810T090000Z_9f31ab';

interface HistoryRow {
  readonly runId: string;
  readonly status: string;
  readonly label: string;
  readonly title: string;
  readonly createdAt: string;
  readonly cost: unknown;
}

const LIVE: HistoryRow = {
  runId: HAPPY_PATH_RUN,
  status: 'running',
  label: 'running',
  title: 'Migrate the checkout module',
  createdAt: '2026-08-11T09:00:00.000Z',
  cost: { run: { costUsd: 0.42 } },
};

const EARLIER: HistoryRow = {
  runId: EARLIER_RUN,
  status: 'completed',
  label: 'completed',
  title: 'Repair the failing gate',
  createdAt: '2026-08-10T09:00:00.000Z',
  cost: { run: { costUsd: 1.5 } },
};

interface Asked {
  readonly projects: number;
  readonly historyOf: string[];
}

/**
 * The NDJSON body the io tail answers with, as one mutable line so a spec can
 * change what the "agent" has emitted between polls.
 */
const ioTail = { value: '' };

/** A client answering the two routes the workspace reads, recording both. */
function workspaceClient(history: Record<string, readonly HistoryRow[]>): ApiClient & {
  readonly asked: Asked;
} {
  const asked: Asked = { projects: 0, historyOf: [] };
  const json = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  /**
   * KAR-27.3 AC3 — the io tail the activity strip polls.
   *
   * NDJSON over a real `Response`-shaped object rather than JSON, because the
   * strip reads it through the shipped `parseIoNdjson`: a stub that handed back
   * parsed objects would skip the line assembly that is the whole risk here.
   */
  const ndjson = (body: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ 'X-DeFlow-Io-More': 'false' }),
      text: () => Promise.resolve(body),
    });

  const client = {
    projects: Object.assign(
      {
        $get: () => {
          (asked as { projects: number }).projects += 1;
          return json({
            projects: [
              {
                id: PROJECT_A,
                name: 'checkout',
                path: '/repos/checkout',
                createdAt: '2026-08-15T10:11:12.000Z',
                health: { state: 'ok', message: null },
                lastRun: null,
              },
              {
                id: PROJECT_B,
                name: 'billing',
                path: '/repos/billing',
                createdAt: '2026-08-15T10:11:13.000Z',
                health: { state: 'ok', message: null },
                lastRun: null,
              },
            ],
          });
        },
        $post: () => json({}),
      },
      {
        ':id': {
          runs: {
            $get: (args: { param: { id: string } }) => {
              asked.historyOf.push(args.param.id);
              return json({ runs: history[args.param.id] ?? [] });
            },
          },
          // KAR-25.5 — the empty state's "Start a run" now navigates to a
          // real `NewRunView`/`RunComposer` rather than opening an overlay,
          // and its `onMounted` reads this unconditionally; without it the
          // page throws where nobody in this file is looking.
          connectors: { $get: () => json({ services: [] }) },
          $delete: () => json({}),
          $patch: () => json({}),
        },
      },
    ),
    runs: Object.assign(
      { $get: () => json({ runs: [], cursor: null, more: false }) },
      {
        ':id': {
          nodes: {
            ':nodeId': {
              io: {
                $get: () => ndjson(ioTail.value),
              },
            },
          },
        },
      },
    ),
    approvals: { $get: () => json({ items: [] }) },
    // The composer's own picker reads this the moment its page mounts.
    providers: { routes: { $get: () => json({ providers: [], known: false }) } },
  };

  return Object.defineProperty(client, 'asked', { get: () => asked }) as never;
}

interface OpenedFeed {
  readonly runId: string;
  readonly sink: { applyEvent(event: Event): boolean };
  closed: boolean;
}

/** A feed factory that connects to nothing and remembers every open. */
function recordingFeed(): { factory: RunFeedFactory; opened: OpenedFeed[] } {
  const opened: OpenedFeed[] = [];
  const factory: RunFeedFactory = (options: RunFeedOptions): RunFeed => {
    const entry: OpenedFeed = { runId: options.runId, sink: options.sink, closed: false };
    opened.push(entry);
    return {
      runId: options.runId,
      ready: Promise.resolve(),
      close: () => {
        entry.closed = true;
      },
    };
  };
  return { factory, opened };
}

let shell: MountedShell;
let feeds: { factory: RunFeedFactory; opened: OpenedFeed[] };
let asked: Asked;

const one = <T extends Element = HTMLElement>(selector: string): T | null =>
  shell.container.querySelector<T>(selector);

const all = (selector: string): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>(selector),
];

const rows = (): HTMLElement[] => all('[data-board-row]');

const graphBodies = (): HTMLElement[] => all('[data-plan-node]');

/** The live feed for `runId`, or the newest one if it is not named. */
function feedFor(runId?: string): OpenedFeed {
  const found = [...feeds.opened]
    .reverse()
    .find((feed) => runId === undefined || feed.runId === runId);
  if (found === undefined) throw new Error(`no feed was opened for ${runId ?? 'any run'}`);
  return found;
}

/** Pours `events` in through the very sink the real stream pours into. */
function push(events: Iterable<Event>, runId = HAPPY_PATH_RUN): void {
  const sink = feedFor(runId).sink;
  for (const event of events) sink.applyEvent(event);
}

async function mountWorkspace(
  at: string,
  history: Record<string, readonly HistoryRow[]>,
): Promise<void> {
  feeds = recordingFeed();
  const client = workspaceClient(history);
  asked = client.asked;
  shell = await mountShell({ at, client, feed: feeds.factory });
  setActivePinia(shell.pinia);
}

/** Project A, its live run open, the whole recording folded, the graph drawn. */
async function openProjectA(): Promise<void> {
  await mountWorkspace(`/projects/${PROJECT_A}`, {
    [PROJECT_A]: [LIVE, EARLIER],
    [PROJECT_B]: [],
  });
  await expect.poll(() => feeds.opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
  push(happyPath12());
  await expect.poll(() => rows().length, { timeout: 15_000 }).toBe(12);
  await expect.poll(() => graphBodies().length, { timeout: 15_000 }).toBe(12);
}

beforeEach(() => {
  // A recording folded into a store a previous file left open would be a
  // workspace made of two runs.
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-22-S34 — the project route shows its active run live', () => {
  it("asks the daemon for this project's runs, not for every run there is", async () => {
    await openProjectA();

    // The history came from the project's own endpoint. A workspace that read
    // `GET /api/runs` and sieved it client-side cannot show a project with
    // three runs among three hundred (test plan #6).
    expect(asked.historyOf).toEqual([PROJECT_A]);
    // And one subscription, for this project's live run.
    expect(feeds.opened.map((feed) => feed.runId)).toEqual([HAPPY_PATH_RUN]);
  });

  it('moves the graph and the board on a frame, with no reload and no refetch', async () => {
    await openProjectA();

    expect(one(`[data-plan-node="smoke-tests"]`)?.dataset['state']).toBe('pending');
    expect(one(`[data-board-row="smoke-tests"]`)?.dataset['state']).toBe('pending');

    const seen: string[] = [];
    const watching = globalThis.fetch;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      seen.push(String(args[0]));
      return watching(...args);
    }) as typeof fetch;

    try {
      push([started('smoke-tests', 1)]);
      await new Promise((resolve) => requestAnimationFrame(resolve));

      expect(one(`[data-plan-node="smoke-tests"]`)?.dataset['state']).toBe('running');
      expect(one(`[data-board-row="smoke-tests"]`)?.dataset['state']).toBe('running');
      // The transition came from the stream. A workspace that re-read an
      // endpoint per frame would look identical and fall over on a real run.
      expect(seen).toEqual([]);
    } finally {
      globalThis.fetch = watching;
    }
  });

  it('draws through the existing plan-graph canvas rather than a second one', async () => {
    await openProjectA();

    // The renderer's own root, and the node bodies `PlanGraphView` renders into
    // its `#node` slot — neither of which a second surface would produce.
    expect(one('.vue-flow')).not.toBeNull();
    expect(graphBodies()).toHaveLength(12);
    expect(one('[data-plan-node="impl-signup"] [data-slot="glyph"] svg')).not.toBeNull();
  });
});

suite('EPIC-22-S36 — the board and the graph cannot disagree', () => {
  it('agrees on every node after every one of twenty frames', async () => {
    await mountWorkspace(`/projects/${PROJECT_A}`, { [PROJECT_A]: [LIVE], [PROJECT_B]: [] });
    await expect.poll(() => feeds.opened.length, { timeout: 15_000 }).toBeGreaterThan(0);

    const events = [...happyPath12()];
    // Everything up to the last twenty, so the graph is drawn before the
    // frame-by-frame comparison starts.
    const tail = events.splice(-20);
    push(events);
    await expect.poll(() => rows().length, { timeout: 15_000 }).toBeGreaterThan(0);

    expect(tail).toHaveLength(20);
    for (const [index, event] of tail.entries()) {
      push([event]);
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const board = Object.fromEntries(
        rows().map((row) => [row.dataset['boardRow'], row.dataset['state']]),
      );
      const graph = Object.fromEntries(
        graphBodies().map((body) => [body.dataset['planNode'], body.dataset['state']]),
      );

      expect(board, `frame ${index + 1} (${event.kind}) disagreed`).toEqual(graph);
    }
  });
});

suite('EPIC-22-S37 — every board row carries the eight facts an operator acts on', () => {
  it('shows title, type, state, provider, model, permission, elapsed and cost', async () => {
    await openProjectA();
    const run = useRunStore(shell.pinia);

    const id = 'recon-auth-surface';
    const row = one(`[data-board-row="${id}"]`);
    if (row === null) throw new Error('the board must have a row for every plan node');

    // Every value is compared against the **projection**, not against a string
    // this spec typed: a board asserted against fixture prose passes just as
    // happily when it is rendering a different node's provider.
    const node = run.planNodes.find((each) => each.id === id);
    if (node === undefined) throw new Error('the plan projection must hold the node');

    expect(cell(row, 'title')).toBe(node.title);
    expect(cell(row, 'type')).toBe(node.type);
    expect(cell(row, 'state')).toBe(STATE_LABELS[node.state]);
    expect(cell(row, 'provider')).toBe(node.provider);
    expect(cell(row, 'permission')).toBe(node.permission);

    // The two joined figures, taken from the same bodies the graph draws, so a
    // board that formatted its own would show a different number here.
    const body = one(`[data-plan-node="${id}"]`);
    expect(cell(row, 'elapsed')).toBe(
      body?.querySelector('[data-slot="elapsed"]')?.textContent?.trim(),
    );
    expect(cell(row, 'cost')).toBe(body?.querySelector('[data-slot="cost"]')?.textContent?.trim());

    // The fixture's `node.scheduled` names no model, and the row says so in
    // words rather than leaving a cell empty — "nobody has said yet" and "there
    // is nothing to say" are different facts.
    expect(cell(row, 'model')).toBe('no model reported');
    expect(node.model).toBeNull();
  });

  it('has a row for every node in the plan and no others', async () => {
    await openProjectA();
    const run = useRunStore(shell.pinia);

    expect(
      rows()
        .map((row) => row.dataset['boardRow'])
        .toSorted(),
    ).toEqual(run.planNodes.map((node) => node.id).toSorted());
  });
});

suite('EPIC-22-S38 — state is never carried by colour alone', () => {
  it.each(DISPLAY_STATES)('gives "%s" a glyph and a text label as well', async (state) => {
    await openProjectA();

    const row = rows().find((each) => each.dataset['state'] === state);
    expect(row, `no node in happy-path-12 is ${state}`).toBeDefined();

    // Laid out, not merely present: jsdom reports a zero-size <svg> as rendered,
    // which is why this file is in the browser project at all.
    const glyph = row?.querySelector('[data-slot="glyph"] svg') as SVGElement | null;
    expect(glyph, 'a row with no glyph is a row encoded by colour and text only').not.toBeNull();
    expect(glyph?.getBoundingClientRect().width).toBeGreaterThan(0);

    // And the word, which is the same word the accessible name uses.
    expect(row?.querySelector('[data-slot="label"]')?.textContent?.trim()).toBe(
      STATE_LABELS[state],
    );
  });

  it('reads the same with colour taken away', async () => {
    await openProjectA();

    // The glyph and the label are what remain when the hue is gone, and they
    // have to differ *per state* or they carry nothing.
    const signatures = new Map<string, string>();
    for (const state of DISPLAY_STATES) {
      const row = rows().find((each) => each.dataset['state'] === state);
      const glyph = row?.querySelector('[data-slot="glyph"] svg')?.innerHTML ?? '';
      const label = row?.querySelector('[data-slot="label"]')?.textContent?.trim() ?? '';
      expect(glyph).not.toBe('');
      expect(label).not.toBe('');
      signatures.set(state, `${glyph}|${label}`);
    }

    expect(new Set(signatures.values()).size).toBe(DISPLAY_STATES.length);
  });
});

suite('EPIC-22-S41 — a historical run opens without a run id being typed', () => {
  it('routes to the run, reopens the feed on it, and offers the existing scrubber', async () => {
    await openProjectA();

    // Both runs are on the history, newest first, with what an operator scans
    // for: the outcome, when it ran, what it cost and what it was asked to do.
    const history = all('[data-history-row]');
    expect(history.map((row) => row.dataset['historyRow'])).toEqual([HAPPY_PATH_RUN, EARLIER_RUN]);
    expect(history[1]?.textContent).toContain(EARLIER.title);
    expect(history[1]?.textContent).toContain(EARLIER.label);

    one<HTMLElement>(`[data-history-open="${EARLIER_RUN}"]`)?.click();

    await expect
      .poll(() => shell.router.currentRoute.value.params['runId'], { timeout: 15_000 })
      .toBe(EARLIER_RUN);
    // The store moved with it, and the previous run's nodes went with the
    // previous run.
    await expect.poll(() => feedFor(EARLIER_RUN).runId).toBe(EARLIER_RUN);
    await expect.poll(() => rows().length).toBe(0);

    // Its full view is restored from the ledger the moment the events arrive —
    // the same hydrate the live run's view uses.
    push(asRun(happyPath12(), EARLIER_RUN), EARLIER_RUN);
    await expect.poll(() => rows().length, { timeout: 15_000 }).toBe(12);
    await expect.poll(() => graphBodies().length, { timeout: 15_000 }).toBe(12);

    // And the existing scrubber is one link away, for the same run —
    // project-scoped now (KAR-25.1), not the bare legacy path.
    expect(one(`[data-run-scrubber="${EARLIER_RUN}"]`)?.getAttribute('href')).toBe(
      `/projects/${PROJECT_A}/runs/${EARLIER_RUN}/evolution`,
    );

    // Nothing was typed anywhere: no field in this document ever held a run id.
    for (const input of all('input')) {
      expect((input as HTMLInputElement).value).not.toContain('run_');
    }
  });
});

suite('EPIC-22-S42 — a project with no runs says so and points at the composer', () => {
  it('renders the empty state, names the composer, and draws no canvas', async () => {
    await mountWorkspace(`/projects/${PROJECT_B}`, { [PROJECT_A]: [LIVE], [PROJECT_B]: [] });
    await expect.poll(() => one('[data-workspace-empty]'), { timeout: 15_000 }).not.toBeNull();

    const empty = one('[data-workspace-empty]');
    expect(empty?.textContent).toMatch(/nothing has run|no runs/i);
    // An empty canvas reads as a broken page; there must not be one.
    expect(one('.vue-flow')).toBeNull();
    expect(rows()).toHaveLength(0);

    // And the next action is the composer itself, not a sentence about it.
    // KAR-25.5 — the composer is a route now
    // (`/projects/:projectId/new-run`), not an overlay this view opened; the
    // button pushes to it rather than setting a store flag.
    const start = one<HTMLElement>('[data-workspace-compose]');
    expect(start).not.toBeNull();
    start?.click();
    await expect.poll(() => shell.router.currentRoute.value.name).toBe('new-run');
    expect(shell.router.currentRoute.value.params['projectId']).toBe(PROJECT_B);
  });
});

suite('EPIC-22-S43 — switching project leaks no stream, no store and no subscription', () => {
  it('closes the feed, releases the store, and renders nothing from the old run', async () => {
    await openProjectA();
    const run = useRunStore(shell.pinia);
    const before = feedFor(HAPPY_PATH_RUN);
    expect(run.counts().nodes).toBe(12);

    await shell.router.push(`/projects/${PROJECT_B}`);
    await expect.poll(() => before.closed, { timeout: 15_000 }).toBe(true);

    // The store entry went with it: the projections are empty, the ring is
    // empty, and nothing is holding a terminal.
    await expect.poll(() => run.counts().nodes).toBe(0);
    expect(run.runId).toBeNull();

    // A frame on the old subscription renders nothing here. This is the
    // scenario's teeth: a workspace that kept the store would show project A's
    // nodes under project B's name.
    before.sink.applyEvent(started('smoke-tests', 500));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(rows()).toHaveLength(0);
    expect(graphBodies()).toHaveLength(0);
    expect(one('[data-workspace-empty]')).not.toBeNull();

    // And the assertion the shell already carries reports nothing retained.
    const logged: RunStoreCounts[] = [];
    let tick = (): void => {};
    const stop = startLeakAssertion({
      counts: () => run.counts(),
      clock: {
        every: (_ms, run_) => {
          tick = run_;
          return () => {};
        },
      },
      log: (_tag, counts) => logged.push(counts),
    });
    tick();
    stop();

    expect(logged).toEqual([{ nodes: 0, facts: 0, events: 0, terminals: 0, ringCap: 2000 }]);
  });
});

/* -------------------------------------------------------------------------- *
 * The UI redesign: where the run's own facts live, and what the page looks
 * like before there is a plan to draw.
 * -------------------------------------------------------------------------- */

suite('the run header carries the facts the topbar used to squeeze in', () => {
  it('renders the task, the provider pairs and the status pill on this page', async () => {
    await openProjectA();
    const run = useRunStore(shell.pinia);

    // The `happy-path-12` recording carries neither `task.submitted` nor
    // `provider.probed` — it starts at `run.created` — so those two frames are
    // applied here the way `app/frame.test.ts` applies them for the same two
    // banners: straight onto the store, which is where the projection reads
    // them from either way.
    run.applyEvent(submitted('Migrate the checkout module'));
    run.applyEvent(probed());
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // The three used to be mounted in `AppTopBar`; `app/frame.test.ts` still
    // asserts them there for every route that has no header of its own. Here
    // they are the header's, and this is the assertion that says so.
    const header = one('[data-run-header]');
    expect(header, 'the project view draws a run header').not.toBeNull();
    expect(header?.querySelector('[data-run-task]')).not.toBeNull();
    expect(header?.querySelector('[data-run-status-pill]')).not.toBeNull();

    // The task is the projection's, not a string this spec typed.
    expect(one('[data-run-task]')?.textContent).toContain(run.submittedTask?.summary);

    // The provider facts are labelled pairs now rather than one sentence, so
    // the values are asserted rather than the wording around them.
    const meta = one('[data-run-provider]');
    expect(meta).not.toBeNull();
    expect(meta?.textContent).toContain('mock');
    expect(meta?.textContent).toContain('/tmp/deflow-bin/deflow-mock-agent');

    // And the project's own two facts came with it, under the same hooks.
    expect(one('[data-workspace-project-name]')?.textContent?.trim()).toBe('checkout');
    expect(header?.textContent).toContain('/repos/checkout');
  });

  it('does not repeat the run’s status in the topbar on this route', async () => {
    await openProjectA();

    // System law 4 — said once per surface. The pill is inside the header, and
    // there is exactly one of it on the page.
    expect(all('[data-run-status-pill]')).toHaveLength(1);
    expect(one('.topbar [data-run-status-pill]')).toBeNull();
    expect(one('.topbar [data-run-task]')).toBeNull();
  });
});

/**
 * KAR-27.5 AC1, AC3, AC5 — a run with no plan keeps its panels.
 *
 * This suite used to assert the opposite: that the board was `null` and the
 * canvas collapsed. That was KAR-24.7's reading of "no 3fr/2fr split while
 * there is nothing to split", and on 2026-08-25 an operator watched what it
 * actually produces — a one-line strip over a void, for the several minutes a
 * framing turn takes, with the history table floating in the middle of the
 * page. The invariant that decision was protecting is the *feed*, not the
 * hiding: the canvas must stay mounted. It still does, and the panel around it
 * is now on screen where an operator can read what it is waiting for.
 *
 * Verifies: EPIC-27-S24, EPIC-27-S26 · KAR-27.5 AC1, AC3, AC5
 */
suite('EPIC-27-S24 — a run with no plan keeps both panels', () => {
  it('draws the plan panel and the tasks panel, neither of them collapsed', async () => {
    // Mounted and left alone: no events are pushed, so the run has no plan and
    // no gate — the state an operator is in for the first second of every run.
    await mountWorkspace(`/projects/${PROJECT_A}`, { [PROJECT_A]: [LIVE], [PROJECT_B]: [] });
    await expect.poll(() => feeds.opened.length, { timeout: 15_000 }).toBeGreaterThan(0);

    await expect.poll(() => one('[data-workspace-plan-panel]'), { timeout: 15_000 }).not.toBeNull();
    expect(one('[data-task-board]')).not.toBeNull();
    expect(rows()).toHaveLength(0);

    // Present in the DOM is not the claim — the old layout kept the canvas
    // mounted at `height: 0`, which satisfies every assertion except the one an
    // operator makes with their eyes.
    const panel = one('[data-workspace-plan-panel]');
    expect(panel?.getBoundingClientRect().height ?? 0).toBeGreaterThan(0);
    expect(one('[data-task-board]')?.getBoundingClientRect().height ?? 0).toBeGreaterThan(0);

    // AC3 — the canvas owns the run's subscription, and unmounting it would
    // close the feed that ends the wait.
    expect(one('.vue-flow')).not.toBeNull();
    expect(feeds.opened).toHaveLength(1);

    // AC1 — "carrying its own empty state naming what it is waiting for". The
    // plan panel says it through the canvas's `GraphEmptyNote`; the board has
    // to say it too, or the operator reads eight column headers over nothing
    // and cannot tell "no tasks yet" from "tasks failed to load".
    expect(one('[data-board-empty]')?.textContent ?? '').toContain('plan');
    expect(one('[data-board-empty]')?.textContent ?? '').not.toBe('');

    // AC5 — when the plan arrives the panels are already there: it fills in
    // place, with no remount of the canvas and no second feed.
    push(happyPath12());
    await expect.poll(() => rows().length, { timeout: 15_000 }).toBe(12);
    expect(one('[data-workspace-plan-panel]')).not.toBeNull();
    expect(one('[data-task-board]')).not.toBeNull();
    // And the empty state goes when there is something to show.
    expect(one('[data-board-empty]')).toBeNull();
    expect(feeds.opened).toHaveLength(1);
  });
});

/**
 * KAR-27.5 AC4 — one grid, whatever state the run is in.
 *
 * The defect was two grid definitions that disagreed: the planned state's
 * `auto / minmax(16rem, 1fr) / auto` over two columns, and a `--pending`
 * modifier that switched to one column and three `auto` rows. Three `auto` rows
 * in a `height: 100%` grid are stretched *equally* by `align-content`'s default,
 * which is what put a void above the history table and another one below it.
 *
 * Verifies: EPIC-27-S27 · AC4
 */
suite('EPIC-27-S27 — the screen fills its viewport in every run state', () => {
  it('lays a plan-less run out on the same tracks as a planned one', async () => {
    await mountWorkspace(`/projects/${PROJECT_A}`, { [PROJECT_A]: [LIVE], [PROJECT_B]: [] });
    await expect.poll(() => feeds.opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => one('[data-workspace-plan-panel]'), { timeout: 15_000 }).not.toBeNull();

    const tracks = (): { rows: number; columns: number } => {
      const grid = one('[data-project-workspace]');
      if (grid === null) throw new Error('the workspace grid is not on the page');
      const style = globalThis.getComputedStyle(grid);
      return {
        rows: style.gridTemplateRows.split(' ').length,
        columns: style.gridTemplateColumns.split(' ').length,
      };
    };

    // No absolute track count is asserted: this view has a real narrow-width
    // layout (`max-width: 819px` — one column, four rows), and the runner's
    // viewport is inside it. The claim AC4 makes is not "two columns", it is
    // that the *same* grid answers whatever state the run is in — so the two
    // readings are compared with each other rather than with a number.
    const pending = tracks();

    push(happyPath12());
    await expect.poll(() => rows().length, { timeout: 15_000 }).toBe(12);

    expect(tracks()).toEqual(pending);
  });
});

/**
 * KAR-27.3 AC3, AC4 — a run whose framing turn is in flight looks alive.
 *
 * The 2026-08-23 report, exactly: an operator watched this strip for minutes
 * while a framing agent made Linear queries and read the repository, and the
 * strip said *"No plan yet"* over a status chip that said *"waiting to be
 * framed"*. Both were the truth about DeFlow's bookkeeping and neither was an
 * answer to *"is anything happening?"*.
 *
 * Verifies: EPIC-27-S18, EPIC-27-S19 · KAR-27.3 AC3, AC4
 */
const PRE_EXEC_TS = 1_786_438_000_000;

/** An envelope on the pre-execution run, before any plan exists. */
const preExec = (seq: number, kind: string, payload: Record<string, unknown>): Event =>
  ({
    seq,
    runId: HAPPY_PATH_RUN,
    ts: PRE_EXEC_TS + seq,
    kind,
    v: 1,
    epoch: 1,
    payload,
  }) as unknown as Event;

const sessionOpened = (seq: number, node: string, attempt: number): Event =>
  preExec(seq, 'provider.session_opened', {
    node,
    attempt,
    provider: 'claude',
    session: { id: `9d1f0f2a-0000-4000-8000-00000000000${attempt}`, origin: 'minted' },
  });

/** One `stream-json` assistant frame carrying a tool call, as NDJSON. */
const toolFrame = (seq: number, name: string): string =>
  `${JSON.stringify({
    seq,
    stream: 'stdout',
    ts: PRE_EXEC_TS + seq,
    data: `${JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `tu_${name}`, name, input: {} }] },
    })}\n`,
  })}\n`;

/** The workspace open on a run with nothing folded yet. */
async function openPreExecutionRun(): Promise<void> {
  ioTail.value = '';
  await mountWorkspace(`/projects/${PROJECT_A}`, { [PROJECT_A]: [LIVE], [PROJECT_B]: [] });
  await expect.poll(() => feeds.opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
  // Hydrated: `hydratedFromSeq` moves off zero, so the panel is past the one
  // branch that is allowed to say "Reading the run's ledger…".
  push([
    preExec(1, 'task.submitted', {
      sha256: 'a'.repeat(64),
      raw: 'Migrate the checkout module',
      provenance: { kind: 'text', by: 'ui', submittedAt: PRE_EXEC_TS },
    }),
  ]);
}

/**
 * What the plan panel says, header and canvas together.
 *
 * It read `[data-workspace-pending-plan]` — the slim card that used to stand in
 * for the panel while a run had no plan — until KAR-27.5 put the panel itself
 * back on screen in that state and moved the strip into its header.
 */
const stripText = (): string => one('[data-workspace-plan-panel]')?.textContent?.trim() ?? '';

suite('EPIC-27-S18 — the activity strip shows life and goes away', () => {
  it('appears on a session_opened, naming the node, the attempt and the elapsed', async () => {
    await openPreExecutionRun();

    push([sessionOpened(2, 'framing', 0)]);

    await expect.poll(() => one('[data-turn-activity]'), { timeout: 15_000 }).not.toBeNull();
    expect(one('[data-turn-node-name]')?.textContent?.trim()).toBe('framing');
    expect(one('[data-turn-attempt]')?.textContent?.trim()).toBe('attempt 1 of 3');
    expect(one('[data-turn-elapsed]')?.textContent).toContain('running');
  });

  it('shows the tool calls the agent is making, off the io stream', async () => {
    await openPreExecutionRun();
    ioTail.value = toolFrame(11, 'mcp__linear__list_issues');

    push([sessionOpened(2, 'framing', 0)]);

    await expect
      .poll(() => one('[data-turn-calls]')?.textContent ?? '', { timeout: 15_000 })
      .toContain('mcp__linear__list_issues');
  });

  it('goes away when the turn concludes, with no refresh', async () => {
    await openPreExecutionRun();
    push([sessionOpened(2, 'framing', 0)]);
    await expect.poll(() => one('[data-turn-activity]'), { timeout: 15_000 }).not.toBeNull();

    push([
      preExec(3, 'human.requested', {
        node: 'framing',
        prompt: 'Which repository did you mean?',
        options: [{ id: 'this-one', label: 'This one', effect: 'approve' }],
      }),
    ]);

    await expect.poll(() => one('[data-turn-activity]'), { timeout: 15_000 }).toBeNull();
  });
});

/**
 * KAR-27.5 AC2 — the strip is the plan panel's header, so the panel outlives it.
 *
 * Verifies: EPIC-27-S25
 */
suite('EPIC-27-S25 — the strip lives in the plan panel, not instead of it', () => {
  it('keeps the panel when the turn concludes and the strip goes', async () => {
    await openPreExecutionRun();
    push([sessionOpened(2, 'framing', 0)]);

    await expect
      .poll(() => one('[data-workspace-plan-panel] [data-turn-activity]'), { timeout: 15_000 })
      .not.toBeNull();

    push([
      preExec(3, 'human.requested', {
        node: 'framing',
        prompt: 'Which repository did you mean?',
        options: [{ id: 'this-one', label: 'This one', effect: 'approve' }],
      }),
    ]);

    await expect.poll(() => one('[data-turn-activity]'), { timeout: 15_000 }).toBeNull();
    expect(one('[data-workspace-plan-panel]')).not.toBeNull();
    expect(one('[data-task-board]')).not.toBeNull();
  });
});

suite('EPIC-27-S19 — the plan panel names the actual state', () => {
  it('says the framing agent is working rather than "No plan yet"', async () => {
    await openPreExecutionRun();
    // No turn in flight yet: the honest sentence is still the old one.
    await expect.poll(() => stripText(), { timeout: 15_000 }).toContain('No plan yet');

    push([sessionOpened(2, 'framing', 0)]);
    await expect.poll(() => one('[data-turn-activity]'), { timeout: 15_000 }).not.toBeNull();

    // KAR-27.5 AC2 — the live strip is the panel's header line, not a band
    // standing in for the panel. The canvas's own empty note is still mounted
    // below it (the canvas is never unmounted, because it owns the run's
    // subscription) and now names the framing state, so "No plan yet" appears
    // nowhere on the panel.
    expect(one('[data-workspace-plan-panel] [data-turn-activity]')).not.toBeNull();
    expect(stripText()).not.toContain('No plan yet');
  });

  it('names recon and the planner in the note when their turn runs', async () => {
    await openPreExecutionRun();

    push([sessionOpened(2, 'recon', 0)]);
    await expect
      .poll(() => one('[data-turn-node-name]')?.textContent?.trim(), { timeout: 15_000 })
      .toBe('recon');

    push([sessionOpened(3, 'planner', 0)]);
    await expect
      .poll(() => one('[data-turn-node-name]')?.textContent?.trim(), { timeout: 15_000 })
      .toBe('planner');
  });

  it('never leaves "Reading the run\u2019s ledger…" on a hydrated feed', async () => {
    await openPreExecutionRun();

    await expect.poll(() => stripText(), { timeout: 15_000 }).not.toBe('');
    expect(stripText()).not.toContain("Reading the run's ledger");
  });
});

suite('EPIC-22-S46 — the board is bounded', () => {
  it('renders two hundred rows, retains two hundred nodes, and opens one subscription', async () => {
    await mountWorkspace(`/projects/${PROJECT_A}`, { [PROJECT_A]: [LIVE], [PROJECT_B]: [] });
    await expect.poll(() => feeds.opened.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const run = useRunStore(shell.pinia);

    push(widePlan(200));
    await expect.poll(() => rows().length, { timeout: 30_000 }).toBe(200);

    // The store's declared bound is the *plan*, never the event count: the
    // ring is fixed and nothing else accumulates per event.
    const counts = run.counts();
    expect(counts.nodes).toBe(200);
    expect(counts.events).toBeLessThanOrEqual(counts.ringCap);

    // One connection for the run, and not one per row — which is the shape a
    // board built out of per-node components tends to grow.
    expect(feeds.opened).toHaveLength(1);
  });
});

/** The text of one board cell, trimmed. */
function cell(row: HTMLElement, name: string): string | null {
  return row.querySelector(`[data-board-${name}]`)?.textContent?.trim() ?? null;
}

/** An envelope `seq` past the recording's head — the two frames below only. */
function past(offset: number, kind: string, payload: Record<string, unknown>): Event {
  const head = happyPath12().at(-1)?.seq ?? 0;
  return {
    seq: head + offset,
    runId: HAPPY_PATH_RUN,
    ts: 1_786_438_900_000 + offset,
    kind,
    v: 1,
    epoch: 1,
    payload,
  } as unknown as Event;
}

/** `task.submitted`, in the shape `../ledger/projections/submission.ts` folds. */
function submitted(raw: string): Event {
  return past(900, 'task.submitted', {
    raw,
    handle: null,
    provenance: {
      kind: 'text',
      by: 'ui',
      submittedAt: 1_786_438_900_000,
      cwd: null,
      projectId: null,
    },
  });
}

/** `provider.probed`, in the shape `../ledger/projections/provider.ts` folds. */
function probed(): Event {
  return past(901, 'provider.probed', {
    provider: 'mock',
    admission: 'installed',
    vendorBin: 'deflow-mock-agent',
    vendorPath: '/tmp/deflow-bin/deflow-mock-agent',
    adapterBin: 'deflow-mock-agent',
    adapterPath: '/tmp/deflow-bin/deflow-mock-agent',
    package: 'deflow',
    chosen: {
      route: 'shim',
      binaryPath: '/tmp/deflow-bin/deflow-mock-agent',
      routes: { acp: 'available', shim: 'available' },
      unserved: [],
    },
  });
}

/** A `node.started` for `node`, `seq` past the recording's head. */
function started(node: string, offset: number): Event {
  const head = happyPath12().at(-1)?.seq ?? 0;
  return {
    seq: head + offset,
    runId: HAPPY_PATH_RUN,
    ts: 1_786_438_900_000 + offset,
    kind: 'node.started',
    v: 2,
    epoch: 3,
    payload: {
      node,
      attempt: 0,
      ikey: `${HAPPY_PATH_RUN}/${node}/0/0`,
      binary: {
        path: '/tmp/deflow-happy-path-12/bin/deflow',
        version: '2.1.220',
        sha256: '5092cc9a1056449838b6cc78f04a7cb838ca7016d04a905ec85e501a4058f4fa',
      },
    },
  } as never;
}

/**
 * The same recording, re-addressed to another run.
 *
 * The events stay the recording's — real payloads, real shapes — and only the
 * envelope's `runId` moves, which is the one field a second run in the same
 * fixture would differ in anyway.
 */
function asRun(events: readonly Event[], runId: string): readonly Event[] {
  return events.map((event) => ({ ...event, runId }) as Event);
}

/**
 * A plan of `count` nodes, built from the recording's own `plan.proposed`.
 *
 * Cloned from a real plan document rather than hand-written, so the shape the
 * projection folds is the shape the daemon actually emits.
 */
function widePlan(count: number): readonly Event[] {
  const proposed = happyPath12().find((event) => event.kind === 'plan.proposed');
  if (proposed === undefined) throw new Error('the recording must contain a plan');
  const payload = proposed.payload as { graph: { nodes: readonly Record<string, unknown>[] } };
  const template = payload.graph.nodes[0];
  if (template === undefined) throw new Error('the plan must contain a node');

  const nodes = Array.from({ length: count }, (_unused, index) => ({
    ...template,
    id: `wide-${String(index).padStart(3, '0')}`,
    title: `Wide step ${index}`,
    deps: [],
  }));

  return [
    {
      ...proposed,
      seq: (happyPath12().at(-1)?.seq ?? 0) + 1000,
      payload: { ...proposed.payload, graph: { ...payload.graph, nodes } },
    } as unknown as Event,
  ];
}
