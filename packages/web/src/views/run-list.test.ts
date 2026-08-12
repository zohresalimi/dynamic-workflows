/**
 * KAR-19.1 AC5 — the root route is a live run list.
 *
 * EPIC-19-S2's clauses are the assertions, in order: a `run.created` frame on
 * the `?runs=*` subscription puts a row on screen, **no second
 * `GET /api/runs` was issued to make it appear**, the page was not reloaded,
 * clicking the row navigates to `/runs/<id>`, and a later `run.completed` for
 * the same run updates that row **in place**.
 *
 * The "no refetch" clause is the one that matters. A list that re-fetches on an
 * interval looks identical to a live one until the interval is long and the run
 * is short — which is exactly the condition an operator submitting a task is in.
 *
 * The transport is substituted and the events are not: the frames pushed in are
 * the frames a live daemon emits on that topic, asserted against a real daemon
 * in `packages/daemon/test/integration/runs-list-api.test.ts` and above it.
 *
 * Verifies: EPIC-19-S2 · KAR-19.1 AC5, AC6 · test plan #5
 */
import type { Event } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';
import { useRunListStore } from '../stores/useRunListStore.ts';

const NEW_RUN = 'run_20260812T140000Z_a1b2c3';

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

/** A client whose `GET /api/runs` answers with `runs`, counting the calls. */
function listClient(runs: readonly unknown[] = []): ApiClient & { readonly calls: number[] } {
  const calls: number[] = [];
  const client = {
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
      if (deliver === null) throw new Error('the root route opened no runs=* subscription');
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

const rows = (): NodeListOf<HTMLElement> =>
  shell.container.querySelectorAll<HTMLElement>('[data-run-row]');

suite('EPIC-19-S2 — a run created while the UI is open (AC5)', () => {
  it('shows the row with no refetch and no reload', async () => {
    const client = listClient([]);
    const feed = pushableFeed();
    shell = await mountShell({ at: '/', client, runsFeed: feed.factory });
    setActivePinia(shell.pinia);

    await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);
    expect(rows()).toHaveLength(0);
    const fetchesBefore = client.calls.length;

    feed.push(created(NEW_RUN));

    await expect.poll(() => rows().length).toBe(1);
    // The clause the whole design turns on: nothing went back to the server to
    // make that row appear.
    expect(client.calls.length).toBe(fetchesBefore);
    expect(useRunListStore(shell.pinia).fetches).toBe(1);
  });

  it('renders the shared status label, not a word of its own', async () => {
    const feed = pushableFeed();
    shell = await mountShell({ at: '/', client: listClient([]), runsFeed: feed.factory });
    setActivePinia(shell.pinia);
    await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);

    feed.push(created(NEW_RUN));

    await expect.poll(() => rows().length).toBe(1);
    const status = shell.container.querySelector<HTMLElement>(`[data-run-status="${NEW_RUN}"]`);
    expect(status?.textContent?.trim()).toBe('submitted — waiting to be framed');
    // And never the sentence the incident produced.
    expect(shell.container.textContent).not.toContain('No plan yet');
  });

  it('navigates to /runs/<id> when the row is clicked', async () => {
    const feed = pushableFeed();
    shell = await mountShell({ at: '/', client: listClient([]), runsFeed: feed.factory });
    setActivePinia(shell.pinia);
    await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);
    feed.push(created(NEW_RUN));
    await expect.poll(() => rows().length).toBe(1);

    shell.container.querySelector<HTMLElement>(`[data-run-link="${NEW_RUN}"]`)?.click();

    await expect.poll(() => shell.router.currentRoute.value.path).toBe(`/runs/${NEW_RUN}`);
  });

  it('updates the row in place when the run ends', async () => {
    const feed = pushableFeed();
    shell = await mountShell({ at: '/', client: listClient([]), runsFeed: feed.factory });
    setActivePinia(shell.pinia);
    await expect.poll(() => useRunListStore(shell.pinia).hydrated).toBe(true);
    feed.push(created(NEW_RUN));
    await expect.poll(() => rows().length).toBe(1);

    feed.push(
      lifecycle('run.completed', NEW_RUN, 40, { outcome: 'succeeded', criteriaSatisfied: [] }),
    );

    await expect
      .poll(() =>
        shell.container
          .querySelector<HTMLElement>(`[data-run-status="${NEW_RUN}"]`)
          ?.textContent?.trim(),
      )
      .toBe('completed');
    // In place: one row, not a second one for the same run.
    expect(rows()).toHaveLength(1);
  });

  it('lists what GET /api/runs already held, including a run nothing has framed', async () => {
    shell = await mountShell({
      at: '/',
      client: listClient([
        {
          runId: NEW_RUN,
          status: 'created',
          label: 'submitted — waiting to be framed',
          title: 'Migrate the checkout module',
          createdAt: '2026-08-12T14:00:00.000Z',
          headSeq: 1,
          planVersion: 0,
        },
      ]),
      runsFeed: pushableFeed().factory,
    });
    setActivePinia(shell.pinia);

    await expect.poll(() => rows().length).toBe(1);
    expect(shell.container.textContent).toContain('Migrate the checkout module');
  });
});
