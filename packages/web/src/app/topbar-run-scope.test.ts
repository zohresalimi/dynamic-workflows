/**
 * KAR-28.3 — the topbar describes *this* page's run, or no run at all.
 *
 * Verifies: EPIC-28-S13, EPIC-28-S14, EPIC-28-S15, EPIC-28-S16 · AC1–AC3
 *
 * Observed 2026-08-25 on `/projects/:id/new-run`: the topbar rendered the
 * previous run's provider, bin, route, prompt and an `aborted` status pill,
 * over a composer for a run that had not been submitted yet. `AppTopBar.vue`
 * asked "does this view draw its own run header" and rendered the three
 * banners for every route that answered no — which is every route in the
 * application except two, including the six that show no run at all.
 *
 * The file is modelled on `./nav-scope.test.ts`: `mountShell` assembles the
 * one real application, so what is under test is the frame as it ships rather
 * than a component tree of this spec's own devising, and the daemon fixture is
 * copied rather than imported for the reason that file states — each of these
 * frame specs answers exactly what its own routes ask for, and a shared
 * fixture would grow a branch per spec.
 *
 * The route sweep below mounts *every* run-less route (S14) but only two of
 * the sixteen run routes (S15). That asymmetry is deliberate: the regression
 * this story fixes is a run leaking onto a run-less page, so those are worth a
 * real mount each, while "no route was left out of the rule" is a question
 * about the route table, which S16's guard answers over all of it at once and
 * far more cheaply than sixteen browser mounts would.
 */
import { type Event, RUN_STATUS_LABELS } from '@DeFlow/core';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { nextTick } from 'vue';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import { routes } from '../router/index.ts';
import {
  classifyRunRoute,
  RUN_HEADER_ROUTE_NAMES,
  RUN_IN_BAR_ROUTE_NAMES,
  RUNLESS_ROUTE_NAMES,
} from '../router/run-scope.ts';
import { useRunStore } from '../stores/useRunStore.ts';

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';
const RUN_ID = 'run_20260818T090000Z_aaaaaa';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly health: { readonly state: string; readonly message: string | null };
}

const PROJECT: ProjectRow = {
  id: PROJECT_ID,
  name: 'checkout',
  path: '/repos/checkout',
  health: { state: 'ok', message: null },
};

/**
 * A daemon that answers what the frame, the composer and the legacy-run guard
 * ask for on the way in — nothing else, so a view that starts issuing a
 * request this spec has not thought about fails loudly rather than quietly.
 *
 * `GET /api/runs/:id` answers `projectId: null`, which is branch (b) of
 * `../router/legacy-run.ts`'s guard: a project-less run renders in place at
 * its `/runs/:runId` bookmark, which is the second half of S15.
 */
function daemon(options: { readonly projects?: readonly ProjectRow[] } = {}) {
  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();

    if (/\/api\/runs\/[^/?]+$/.test(url)) return json(200, { runId: RUN_ID, projectId: null });
    if (url.includes('/providers/routes')) return json(200, { providers: [] });
    if (url.includes('/providers')) return json(200, []);
    if (url.includes('/connectors')) return json(200, { services: [] });
    if (/\/api\/projects\/[^/?]+\/runs$/.test(url)) return json(200, { runs: [] });
    if (url.includes('/projects')) return json(200, { projects: options.projects ?? [PROJECT] });
    if (url.includes('/approvals'))
      return json(200, { items: [], counts: { total: 0 }, headSeq: 1 });
    return json(404, { error: { message: 'not found' } });
  };
}

function client() {
  return createClient({
    baseUrl: 'http://127.0.0.1:7777/api',
    fetch: daemon(),
    token: () => 'test-token-Aa0_-Bb1',
  });
}

/** `./frame.test.ts`'s own envelope, narrowed to the four kinds this file
 * folds — applied straight onto the store rather than routed through a feed,
 * which is what makes this a spec about the *frame* and not about SSE. */
function envelope(seq: number, kind: string, payload: Record<string, unknown> = {}): Event {
  return {
    seq,
    runId: RUN_ID,
    ts: 1_755_500_000_000 + seq,
    kind,
    v: 1,
    epoch: 1,
    payload,
  } as unknown as Event;
}

/**
 * A run in the store, concluded as `aborted` — the exact state the composer
 * was observed describing. Task and provider are folded too, so all three
 * banners have something to render and an assertion that finds none of them is
 * about the route rather than about an empty store.
 */
async function openAbortedRun(shell: MountedShell): Promise<void> {
  const run = useRunStore(shell.pinia);
  run.open(RUN_ID);
  run.applyEvent(
    envelope(1, 'task.submitted', {
      raw: 'Migrate the checkout module',
      handle: null,
      provenance: {
        kind: 'text',
        by: 'ui',
        submittedAt: 1_755_500_000_000,
        cwd: null,
        projectId: null,
      },
    }),
  );
  run.applyEvent(
    envelope(2, 'provider.probed', {
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
    }),
  );
  run.applyEvent(envelope(3, 'run.aborted', { reason: 'operator' }));
  await nextTick();
}

function topbar(shell: MountedShell): HTMLElement {
  const bar = shell.container.querySelector<HTMLElement>('.topbar');
  if (bar === null) throw new Error('the shell mounted without a topbar');
  return bar;
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-28-S13 — the composer describes no run', () => {
  it('shows no provider, no task and no status pill on /projects/:id/new-run', async () => {
    shell = await mountShell({
      at: { name: 'new-run', params: { projectId: PROJECT_ID } },
      client: client(),
    });
    await openAbortedRun(shell);

    const bar = topbar(shell);
    expect(bar.querySelector('[data-run-provider]')).toBeNull();
    expect(bar.querySelector('[data-run-task]')).toBeNull();
    expect(bar.querySelector('[data-run-status-pill]')).toBeNull();
    // The observed symptom, said in the words the operator read on screen.
    expect(bar.textContent).not.toContain(RUN_STATUS_LABELS.aborted);
  });
});

suite('EPIC-28-S14 — every run-less route is covered, not just the composer', () => {
  it.each([
    ['projects', '/projects'],
    ['settings', '/settings'],
    ['gallery', '/gallery'],
    ['not-found', '/no-such-page'],
    ['project-runs', `/projects/${PROJECT_ID}/runs`],
    ['new-run', `/projects/${PROJECT_ID}/new-run`],
  ])('renders none of the three run banners at %s', async (name, at) => {
    shell = await mountShell({ at, client: client() });
    expect(shell.router.currentRoute.value.name).toBe(name);
    await openAbortedRun(shell);

    const bar = topbar(shell);
    expect(bar.querySelector('[data-run-provider]'), `${name}: provider`).toBeNull();
    expect(bar.querySelector('[data-run-task]'), `${name}: task`).toBeNull();
    expect(bar.querySelector('[data-run-status-pill]'), `${name}: status`).toBeNull();
  });
});

suite('EPIC-28-S15 — the run views keep what they have', () => {
  it.each([
    ['run-plan', `/projects/${PROJECT_ID}/runs/${RUN_ID}/plan`],
    ['legacy-run-plan', `/runs/${RUN_ID}`],
  ])('keeps all three banners in the topbar at %s', async (name, at) => {
    shell = await mountShell({ at, client: client() });
    expect(shell.router.currentRoute.value.name).toBe(name);
    await openAbortedRun(shell);

    // KAR-24.4 AC4's "every element survives" contract, unweakened: a run view
    // with no header of its own reads its run off the bar exactly as before.
    const bar = topbar(shell);
    expect(bar.querySelector('[data-run-provider]'), `${name}: provider`).not.toBeNull();
    expect(bar.querySelector('[data-run-task]')?.textContent).toContain(
      'Migrate the checkout module',
    );
    expect(bar.querySelector('[data-run-status-pill]')?.textContent).toContain(
      RUN_STATUS_LABELS.aborted,
    );
  });
});

suite('EPIC-28-S16 — a new route cannot inherit a stale run by accident', () => {
  /** Every route the application registers that has a name of its own — the
   * two redirect records (`/` and the old connectors path) carry none, and a
   * record with no name is one no `route.name` comparison can ever match. */
  const routeNames = routes
    .map((route) => (route as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');

  it('classifies every route in the table', () => {
    const unclassified = routeNames.filter((name) => classifyRunRoute(name) === null);

    expect(
      unclassified,
      `these routes are in neither category in src/router/run-scope.ts: ${unclassified.join(', ')}. ` +
        'Add each one to RUN_HEADER_ROUTE_NAMES (it draws its own run header), ' +
        'RUN_IN_BAR_ROUTE_NAMES (it shows a run with no header of its own) or ' +
        'RUNLESS_ROUTE_NAMES (it shows no run).',
    ).toEqual([]);
  });

  /** Every name the rule claims, in the order the three arrays declare them —
   * so a name in two of them shows up as a duplicate rather than vanishing. */
  const claimed = [...RUN_HEADER_ROUTE_NAMES, ...RUN_IN_BAR_ROUTE_NAMES, ...RUNLESS_ROUTE_NAMES];

  it('names no route the table does not have', () => {
    // `gallery` is registered under `import.meta.env.DEV` only (see
    // `../router/index.ts`), which a browser spec always is — so the table
    // this reads is the full one.
    const stale = claimed.filter((name) => !routeNames.includes(name));

    expect(stale, `named in run-scope.ts but not in the route table: ${stale.join(', ')}`).toEqual(
      [],
    );
  });

  it('puts no route in two categories at once', () => {
    expect(claimed).toHaveLength(new Set(claimed).size);
  });

  it('shows no run for a route name it has never heard of', () => {
    // The safe default, and the whole point of the rule: an unclassified name
    // inherits nothing. The guard above is what stops that default from
    // becoming a silent way to ship a route with no run on a run view.
    expect(classifyRunRoute('some-route-nobody-classified')).toBeNull();
    expect(classifyRunRoute(undefined)).toBeNull();
  });
});
