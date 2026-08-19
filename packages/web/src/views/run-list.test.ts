/**
 * KAR-19.1 AC5, KAR-25.1 — this project's run list, project-scoped.
 *
 * EPIC-19-S2's clauses, re-proved at the scope the route now has: hydrate
 * from `GET /api/projects/:id/runs`, a listed run updates **in place** off the
 * `?runs=*` topic with no refetch, clicking a row navigates to
 * `/projects/<id>/runs/<runId>`, and a `run.completed`/`run.aborted` frame for
 * a run already on the page updates it rather than duplicating it.
 *
 * **What did not survive the move, and why.** EPIC-19-S2's original claim also
 * covered *inserting* a brand-new row from a `run.created` frame with no
 * refetch. `?runs=*`'s membership (`GLOBAL_TOPIC_KINDS`,
 * `packages/daemon/src/http/sse.ts`) is exactly four lifecycle kinds, and
 * `run.created`'s own schema (`RunCreatedSchema`,
 * `packages/core/src/event-payloads.ts`) carries `spec`, `cwd`, `repo` — no
 * `projectId`. A list scoped to one project cannot decide whether an arriving
 * `run.created` belongs to it, so it is not inserted; a run started elsewhere
 * while this page is open appears on the next visit rather than live. The
 * last suite below asserts that gap explicitly, rather than letting it go
 * uncovered. `../app/useRunList.ts`'s own header comment carries the same
 * note.
 *
 * Verifies: EPIC-19-S2 · KAR-19.1 AC5, AC6 · KAR-25.1 · test plan #5
 */
import type { Event } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';
import { useRunListStore } from '../stores/useRunListStore.ts';

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';
const LISTED_RUN = 'run_20260812T140000Z_a1b2c3';
const NEW_RUN = 'run_20260812T150000Z_d4e5f6';

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

/** A client whose `GET /api/projects/:id/runs` answers with `runs`, counting
 * the calls. */
function listClient(runs: readonly unknown[] = []): ApiClient & { readonly calls: number[] } {
  const calls: number[] = [];
  const client = {
    projects: {
      // The rail's `ProjectSwitcher` calls this on every mount, regardless of
      // route — not this suite's concern, but a client with no answer for it
      // throws inside `ProjectWorkflowsView` the moment a row navigates
      // there (`navigates to the project-scoped run when the row is clicked`,
      // below).
      $get: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ projects: [] }),
        }),
      ':id': {
        runs: {
          $get: () => {
            calls.push(Date.now());
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({ runs, cursor: null, more: false }),
            });
          },
        },
      },
    },
    approvals: {
      $get: () =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) }),
    },
  };
  return Object.defineProperty(client, 'calls', { get: () => calls }) as never;
}

/** A `runs=*` feed a spec pushes frames into. */
function pushableFeed(): { factory: RunsFeedFactory; push: (event: Event) => void } {
  let deliver: ((event: Event) => void) | null = null;
  const factory: RunsFeedFactory = (options): RunsFeed => {
    deliver = options.onLifecycle;
    return { ready: Promise.resolve(), close: () => {} };
  };
  return {
    factory,
    push: (event) => {
      if (deliver === null) throw new Error('the project runs route opened no runs=* subscription');
      deliver(event);
    },
  };
}

const lifecycle = (kind: string, runId: string, seq: number, payload: unknown): Event =>
  ({ seq, runId, ts: 1_754_812_800_000, kind, v: 1, epoch: 1, payload }) as unknown as Event;

const created = (runId: string, seq = 7): Event =>
  lifecycle('run.created', runId, seq, {
    spec: { goal: 'Migrate the checkout module to Vue 3' },
    cwd: '/repo',
    repo: { head: 'e83c516', branch: 'main' },
  });

const LISTED_ROW = {
  runId: LISTED_RUN,
  status: 'created' as const,
  label: 'submitted — waiting to be framed',
  title: 'Migrate the checkout module',
  createdAt: '2026-08-12T14:00:00.000Z',
  headSeq: 1,
  planVersion: 0,
};

const GATE_NODE = 'review-changes';

/** The same row, but waiting on a gate — `pendingGate`'s own shape. */
const WAITING_ROW = {
  ...LISTED_ROW,
  status: 'needs-human' as const,
  label: 'needs a decision',
  gate: { node: GATE_NODE, options: [{ id: 'approve', label: 'Ship it' }] },
};

const rows = (): NodeListOf<HTMLElement> =>
  shell.container.querySelectorAll<HTMLElement>('[data-run-row]');

async function mountRunList(client: ApiClient, feed: RunsFeedFactory): Promise<void> {
  shell = await mountShell({
    at: { name: 'project-runs', params: { projectId: PROJECT_ID } },
    client,
    runsFeed: feed,
  });
  setActivePinia(shell.pinia);
  await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);
}

suite('EPIC-19-S2 — a run already listed updates in place, with no refetch', () => {
  it('renders the shared status label from the initial hydrate', async () => {
    const feed = pushableFeed();
    await mountRunList(listClient([LISTED_ROW]), feed.factory);

    await expect.poll(() => rows().length).toBe(1);
    const status = shell.container.querySelector<HTMLElement>(`[data-run-status="${LISTED_RUN}"]`);
    expect(status?.textContent?.trim()).toBe('submitted — waiting to be framed');
  });

  it('navigates to the project-scoped run when the row is clicked', async () => {
    const feed = pushableFeed();
    await mountRunList(listClient([LISTED_ROW]), feed.factory);
    await expect.poll(() => rows().length).toBe(1);

    shell.container.querySelector<HTMLElement>(`[data-run-link="${LISTED_RUN}"]`)?.click();

    await expect
      .poll(() => shell.router.currentRoute.value.path)
      .toBe(`/projects/${PROJECT_ID}/runs/${LISTED_RUN}`);
  });

  it('updates the row in place when the run ends, with no refetch', async () => {
    const client = listClient([LISTED_ROW]);
    const feed = pushableFeed();
    await mountRunList(client, feed.factory);
    await expect.poll(() => rows().length).toBe(1);
    const fetchesBefore = client.calls.length;

    feed.push(
      lifecycle('run.completed', LISTED_RUN, 40, { outcome: 'succeeded', criteriaSatisfied: [] }),
    );

    await expect
      .poll(() =>
        shell.container
          .querySelector<HTMLElement>(`[data-run-status="${LISTED_RUN}"]`)
          ?.textContent?.trim(),
      )
      .toBe('completed');
    // In place: one row, not a second one for the same run.
    expect(rows()).toHaveLength(1);
    // And nothing went back to the server to make it update.
    expect(client.calls.length).toBe(fetchesBefore);
    expect(useRunListStore(shell.pinia).fetches).toBe(1);
  });

  /**
   * KAR-19.6 AC7 / EPIC-19-S42 — a stopped run stops looking live. The
   * operator's complaint was not only that the runs would not stop; it was
   * that they kept appearing. A cancel that ends the ledger and leaves the
   * list rendering the run as live has moved the defect rather than fixed it.
   */
  it('updates the row in place when the run is cancelled, with no refetch', async () => {
    const client = listClient([LISTED_ROW]);
    const feed = pushableFeed();
    await mountRunList(client, feed.factory);
    await expect.poll(() => rows().length).toBe(1);
    const fetchesBefore = client.calls.length;

    feed.push(
      lifecycle('run.aborted', LISTED_RUN, 41, { outcome: 'failed', criteriaSatisfied: [] }),
    );

    await expect
      .poll(() =>
        shell.container
          .querySelector<HTMLElement>(`[data-run-status="${LISTED_RUN}"]`)
          ?.textContent?.trim(),
      )
      // `runStatusLabel`'s own string for `aborted`, and no fourth spelling.
      .toBe('aborted');
    expect(rows()).toHaveLength(1);
    expect(client.calls.length).toBe(fetchesBefore);
    expect(useRunListStore(shell.pinia).fetches).toBe(1);
  });

  it('lists what GET /api/projects/:id/runs already held, including a run nothing has framed', async () => {
    await mountRunList(listClient([LISTED_ROW]), pushableFeed().factory);

    await expect.poll(() => rows().length).toBe(1);
    expect(shell.container.textContent).toContain('Migrate the checkout module');
  });
});

suite('KAR-25.7 AC5, AC7 — a waiting row clears its gate from the ledger, not a refetch', () => {
  it('clears data-run-gate on the human.responded frame and leaves the status word alone', async () => {
    const client = listClient([WAITING_ROW]);
    const feed = pushableFeed();
    await mountRunList(client, feed.factory);
    await expect.poll(() => rows().length).toBe(1);
    const fetchesBefore = client.calls.length;

    expect(shell.container.querySelector(`[data-run-gate="${LISTED_RUN}"]`)).not.toBeNull();

    // The frame this tab never asked for — the CLI or another tab answered it.
    // No local "I answered" flag exists here to consult; the ledger's own
    // frame is what clears the row.
    feed.push(
      lifecycle('human.responded', LISTED_RUN, 42, {
        node: GATE_NODE,
        optionId: 'approve',
        at: '2026-08-12T14:05:00.000Z',
        by: 'operator',
      }),
    );

    await expect
      .poll(() => shell.container.querySelector(`[data-run-gate="${LISTED_RUN}"]`))
      .toBeNull();
    // `human.responded` is not a `RunStatus` — the word beside the row is
    // untouched by this frame; only the gate line goes.
    expect(
      shell.container
        .querySelector<HTMLElement>(`[data-run-status="${LISTED_RUN}"]`)
        ?.textContent?.trim(),
    ).toBe('needs a decision');
    expect(rows()).toHaveLength(1);
    expect(client.calls.length).toBe(fetchesBefore);
  });

  it('leaves a different run’s gate alone', async () => {
    const other = { ...WAITING_ROW, runId: NEW_RUN };
    const feed = pushableFeed();
    await mountRunList(listClient([WAITING_ROW, other]), feed.factory);
    await expect.poll(() => rows().length).toBe(2);

    feed.push(
      lifecycle('human.responded', LISTED_RUN, 42, {
        node: GATE_NODE,
        optionId: 'approve',
        at: '2026-08-12T14:05:00.000Z',
        by: 'operator',
      }),
    );

    await expect
      .poll(() => shell.container.querySelector(`[data-run-gate="${LISTED_RUN}"]`))
      .toBeNull();
    expect(shell.container.querySelector(`[data-run-gate="${NEW_RUN}"]`)).not.toBeNull();
  });
});

suite('KAR-25.7 AC3, EPIC-25-S45 — a waiting run row lands on its gate, in view', () => {
  it('lands on the waiting run and shows its gate panel, without further clicking', async () => {
    const client = listClient([WAITING_ROW]);
    const feed = pushableFeed();

    /** The per-run feed the destination view (`PlanGraphView`, through
     * `useRunFeed`) opens once the row is clicked — the run list itself opens
     * no per-run feed at all, so this is a second, separate injected factory
     * from `feed` above, exactly as production has two separate composables. */
    interface Opened {
      readonly runId: string;
      readonly sink: { applyEvent(event: Event): boolean };
    }
    const holder: { opened: Opened | null } = { opened: null };
    const runFeedFactory: RunFeedFactory = (options: RunFeedOptions): RunFeed => {
      holder.opened = { runId: options.runId, sink: options.sink };
      return { runId: options.runId, ready: Promise.resolve(), close: () => {} };
    };

    shell = await mountShell({
      at: { name: 'project-runs', params: { projectId: PROJECT_ID } },
      client,
      runsFeed: feed.factory,
      feed: runFeedFactory,
    });
    setActivePinia(shell.pinia);
    await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);
    await expect.poll(() => rows().length).toBe(1);

    shell.container.querySelector<HTMLElement>(`[data-run-link="${LISTED_RUN}"]`)?.click();

    await expect
      .poll(() => shell.router.currentRoute.value.path)
      .toBe(`/projects/${PROJECT_ID}/runs/${LISTED_RUN}`);
    await expect.poll(() => holder.opened !== null, { timeout: 15_000 }).toBe(true);
    const opened = holder.opened;
    if (opened === null) throw new Error('the run screen opened no run feed');
    expect(opened.runId).toBe(LISTED_RUN);

    // The gate arrives on this run's own feed, the way it does in production —
    // and the shell band shows it without another click or a scroll: it is
    // `App.vue`'s own `RunGateBanner`, always mounted above the outlet.
    const result = parseEvent({
      seq: 9,
      runId: LISTED_RUN,
      ts: 1_754_812_800_000,
      kind: 'human.requested',
      v: EVENT_SCHEMAS['human.requested'].v,
      epoch: 1,
      payload: {
        node: GATE_NODE,
        prompt: 'Ship it?',
        options: [{ id: 'approve', label: 'Ship it', effect: 'approve' }],
      },
    });
    if (result.status !== 'ok') throw new Error('the spec built an unreadable envelope');
    opened.sink.applyEvent(result.event);

    await expect
      .poll(() => shell.container.querySelector('[data-run-gate-banner]'), { timeout: 15_000 })
      .not.toBeNull();
    expect(shell.container.querySelector('[data-run-gate-node]')?.textContent).toContain(GATE_NODE);
  });
});

suite('KAR-25.1 — the accepted gap: a run created elsewhere is not inserted live', () => {
  it('does not add a row for a run.created frame naming no project', async () => {
    const feed = pushableFeed();
    await mountRunList(listClient([]), feed.factory);
    expect(rows()).toHaveLength(0);

    feed.push(created(NEW_RUN));

    // Give the frame a turn to be applied, if it were going to be.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rows()).toHaveLength(0);
  });
});
