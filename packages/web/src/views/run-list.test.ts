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
import { setActivePinia } from 'pinia';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
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
