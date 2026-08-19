/**
 * KAR-24.4 — the app frame, mounted whole: the rail, the switcher and the
 * topbar, in the real shell rather than in isolation.
 *
 * Verifies: EPIC-24-S14, EPIC-24-S15, EPIC-24-S16, EPIC-24-S17, EPIC-24-S18 ·
 * AC1–AC7
 *
 * Modelled on `./shell-boot.test.ts` and `./keyboard.test.ts`: `mountShell`
 * from `../../test/shell.ts` assembles the one real application
 * (`../app/create-app.ts`), so what is under test here is the frame as it
 * actually ships rather than a component tree of its own devising. Neither of
 * those two files is touched — they are the contract this rewrite has to keep,
 * and a green run of both alongside this file is the proof that keeping it
 * did not cost the keyboard map or the shell's own boot behaviour.
 *
 * The client is a small fixed daemon rather than `fetch` monkey-patched, for
 * the reason `../views/projects.test.ts` states: what several of these specs
 * assert is *which request the frame made*, and the typed client is the thing
 * that decides that.
 *
 * ## EPIC-24-S18's viewport, and why it is not `Emulation.setDeviceMetricsOverride`
 *
 * Vitest's browser mode does not mount a spec's DOM into the tab's own
 * top-level document — it mounts it into a "Tester" `<iframe data-vitest>`
 * held at a fixed logical size (measured here at 414×896) so a screenshot is
 * reproducible regardless of the host window. A CDP
 * `Emulation.setDeviceMetricsOverride` resizes the *tab*, not that iframe, so
 * `@media (max-width: …)` inside it never sees the change — confirmed by
 * hand: the override was sent and acknowledged, and `window.innerWidth`
 * inside the mounted app stayed at 414 regardless of the width asked for.
 *
 * What the iframe *does* answer to is its own box size, because the
 * "fixed-for-screenshots" logical size is a CSS width/height on the iframe
 * element itself, not a re-derived viewport: this file's own `window` is that
 * iframe's `window`, so `window.frameElement` is the very element to resize,
 * same-origin and reachable with no CDP session at all. `atViewport()` below
 * does exactly that and nothing else, and `restoreViewport()` puts the
 * original size back so a spec that resized it does not move S18's failure
 * into whichever file the runner picks up next.
 */
import { type Event, RUN_STATUS_LABELS } from '@DeFlow/core';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { nextTick } from 'vue';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import { MAIN_CONTENT_ID, SEARCH_INPUT_ID } from '../app/ids.ts';
import { routes } from '../router/index.ts';
import { useRunStore } from '../stores/useRunStore.ts';

/** The Tester iframe this spec's own `window` lives inside — see the header
 *  comment. Same-origin, so `frameElement` is never null in this harness. */
function testerFrame(): HTMLElement {
  // Not `instanceof HTMLIFrameElement`: `window.frameElement` belongs to the
  // *parent* window's realm, so its prototype chain runs through the
  // parent's own `HTMLIFrameElement` constructor — a different object from
  // this window's — and `instanceof` across that boundary is always false.
  // `tagName` is a plain string and crosses realms without incident.
  const el = window.frameElement;
  if (el === null || el.tagName !== 'IFRAME') {
    throw new Error("EPIC-24-S18 expected this window's frameElement to be the Tester iframe");
  }
  return el as unknown as HTMLElement;
}

let savedFrameSize: { readonly width: string; readonly height: string } | null = null;

/** Resizes the Tester iframe's own box, which is what the app's `@media`
 *  rules actually see. Two frames of settle time: one for the resize to
 *  reflow, one for Vue's own post-mount tick if a test calls this before
 *  `mountShell`. */
async function atViewport(width: number, height = 900): Promise<void> {
  const frame = testerFrame();
  savedFrameSize ??= { width: frame.style.width, height: frame.style.height };
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function restoreViewport(): void {
  if (savedFrameSize === null) return;
  const frame = testerFrame();
  frame.style.width = savedFrameSize.width;
  frame.style.height = savedFrameSize.height;
  savedFrameSize = null;
}

const RUN_ID = 'run_20260818T090000Z_aaaaaa';
const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: { readonly state: string; readonly message: string | null };
  readonly lastRun: { readonly runId: string; readonly label: string } | null;
}

interface ProviderRow {
  readonly provider: string;
  readonly installed: boolean;
  readonly version?: string | null;
  readonly enabled?: boolean;
}

const PROJECT: ProjectRow = {
  id: PROJECT_ID,
  name: 'checkout',
  path: '/repos/checkout',
  createdAt: '2026-08-15T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
};

const PROVIDERS: readonly ProviderRow[] = [{ provider: 'claude', installed: true, version: '4.6' }];

/** Every path the frame's own pieces are allowed to reach — `AppRail.vue`'s
 * runtimes list, `ProjectSwitcher.vue`'s list, `App.vue`'s own approvals
 * count — answered from one fixed daemon rather than three separate mocks. */
function frameDaemon(options: {
  readonly projects?: readonly ProjectRow[];
  readonly providers?: readonly ProviderRow[];
  readonly approvals?: number;
  readonly sent?: string[];
}) {
  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    options.sent?.push(url);

    // `/api/providers/routes` (the composer's picker) before the general
    // `/api/providers` (the rail's runtimes list) — two different shapes off
    // two different paths that both contain the word "providers".
    if (url.includes('/providers/routes')) {
      return json(200, {
        providers: (options.providers ?? []).map((row) => ({
          id: row.provider,
          available: row.installed,
          route: row.installed ? 'shim' : null,
          routes: { acp: 'unavailable', shim: row.installed ? 'available' : 'unavailable' },
          reason: row.installed ? 'installed' : 'not installed',
          action: null,
          limitation: null,
        })),
      });
    }
    // `enabled` defaults to `true`, matching `GET /api/providers`' own default
    // for a provider with no `provider_setting` row (`../api/queries.ts`'s
    // `ProviderRow` doc) — a fixture row that does not care about the toggle
    // does not have to spell it out.
    if (url.includes('/providers')) {
      return json(
        200,
        (options.providers ?? []).map((row) => ({ ...row, enabled: row.enabled ?? true })),
      );
    }
    // KAR-25.5 — both checked before the general `/projects` catch-all, whose
    // own path (`/projects/:id/connectors`, `/projects/:id/runs`) also
    // `.includes('/projects')`. `ProjectWorkflowsView` and the composer's
    // page both mount for real now that "Start a run" navigates rather than
    // opening an overlay, and each reads one of these unconditionally on
    // mount.
    if (url.includes('/connectors')) return json(200, { services: [] });
    if (url.includes('/projects/') && url.includes('/runs')) return json(200, { runs: [] });
    if (url.includes('/projects')) return json(200, { projects: options.projects ?? [] });
    if (url.includes('/approvals')) {
      const items = options.approvals ?? 0;
      // KAR-25.7 — `human-node`, the real answerable `ApprovalKind`, with the
      // fields `useApprovalsStore`'s hydrate keeps: `kind: 'human'` matched no
      // real kind and would now be filtered out.
      return json(200, {
        items: Array.from({ length: items }, (_unused, index) => ({
          runId: `run_${index}`,
          kind: 'human-node',
          node: `node_${index}`,
          prompt: `node_${index} needs a decision`,
          options: [{ id: 'approve', label: 'Approve' }],
          seq: index + 1,
        })),
        counts: { total: items },
        headSeq: 1,
      });
    }
    return json(404, { error: { message: 'not found' } });
  };
}

/** A `task.submitted`/`provider.probed` pair, applied straight onto the store
 * rather than routed through a feed — `../stores/useRunStore.test.ts`'s own
 * `opened()`/`applyEvent` pattern, which needs no SSE origin and no run route
 * to prove what `RunTaskBanner`/`RunProviderBanner` render off a folded event. */
function envelope(seq: number, kind: string, payload: Record<string, unknown>): Event {
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

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
  // AC7 — the same discipline `theme.test.ts` keeps for `commands.emulateMedia`:
  // a spec left at 760px would move S18's failure into whichever spec the
  // runner picks up next.
  restoreViewport();
});

suite('EPIC-24-S14 — the rail and the topbar, on the landing route', () => {
  it('shows the brand, the switcher, the nav and the identity footer', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const rail = shell.container.querySelector('[data-frame-rail]');
    expect(rail).not.toBeNull();
    expect(rail?.textContent).toContain('DeFlow');
    expect(rail?.textContent).toContain('LOCAL');

    expect(shell.container.querySelector('[data-project-switcher]')).not.toBeNull();

    const nav = shell.container.querySelector('.rail__nav');
    expect(nav?.querySelectorAll('a').length).toBeGreaterThanOrEqual(2);

    const footer = shell.container.querySelector('.rail__identity');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toMatch(/daemon/i);
  });

  it('shows the run status pill on a tab that is only following a run', async () => {
    // AC5, and the reason KAR-24.4 touched the store at all. `useRunStore`'s
    // `runState` is the scrubber's answer and is filled by `scrubTo()` alone,
    // so a tab that merely opened a run and is watching it has none — which is
    // exactly the tab this pill exists for. Nothing is scrubbed here on
    // purpose: the assertion is that a *live* run reaches the frame.
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({}),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const run = useRunStore(shell.pinia);
    expect(shell.container.querySelector('[data-run-status-pill]')).toBeNull();

    run.open(RUN_ID);
    run.applyEvent(envelope(1, 'run.created', { runId: RUN_ID }));
    await nextTick();

    const pill = shell.container.querySelector('[data-run-status-pill]');
    expect(pill).not.toBeNull();
    // The daemon's own word for the status, through `RUN_STATUS_LABELS` — the
    // pill invents no second vocabulary for it.
    expect(pill?.textContent).toContain(RUN_STATUS_LABELS.created);

    run.applyEvent(envelope(2, 'human.requested', { nodeId: 'n1' }));
    await nextTick();
    expect(shell.container.querySelector('[data-run-status-pill]')?.textContent).toContain(
      RUN_STATUS_LABELS['needs-human'],
    );
  });

  it('shows the breadcrumb in the topbar', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({}),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const crumb = shell.container.querySelector('.topbar__crumb');
    expect(crumb).not.toBeNull();
    expect(crumb?.textContent?.trim().length).toBeGreaterThan(0);
  });
});

suite(
  'KAR-25.3 AC8 — the RUNTIMES glance names a disabled runtime, not only an installed one',
  () => {
    it('reports "disabled" for a runtime that is installed but toggled off', async () => {
      shell = await mountShell({
        client: createClient({
          baseUrl: 'http://127.0.0.1:7777/api',
          fetch: frameDaemon({
            projects: [PROJECT],
            providers: [{ provider: 'claude', installed: true, version: '4.6', enabled: false }],
          }),
          token: () => 'test-token-Aa0_-Bb1',
        }),
      });

      const row = () => shell.container.querySelector('[data-runtime-row]');
      await expect.poll(() => row()).not.toBeNull();
      // The bug this AC forbids: an installed-but-disabled runtime reading
      // exactly as an installed-and-enabled one, with no signal a run through
      // it would actually be refused.
      expect(row()?.textContent).not.toContain('4.6');
      expect(row()?.textContent).toContain('disabled');
      expect(row()?.getAttribute('data-runtime-enabled')).toBe('false');
      expect(row()?.querySelector('.rail__runtime-dot')?.getAttribute('data-enabled')).toBe(
        'false',
      );
    });

    it('shows the version, not "disabled", for an installed runtime that is enabled', async () => {
      shell = await mountShell({
        client: createClient({
          baseUrl: 'http://127.0.0.1:7777/api',
          fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
          token: () => 'test-token-Aa0_-Bb1',
        }),
      });

      const row = () => shell.container.querySelector('[data-runtime-row]');
      await expect.poll(() => row()?.textContent).toContain('4.6');
      expect(row()?.textContent).not.toContain('disabled');
      expect(row()?.getAttribute('data-runtime-enabled')).toBe('true');
    });
  },
);

suite('EPIC-24-S15 — the nav names only routes this application has', () => {
  it('resolves every rail item to a real route, and none of them is "Builder"', async () => {
    const routeNames = new Set(routes.map((route) => route.name as string));

    shell = await mountShell({
      at: { name: 'project-workflows', params: { projectId: PROJECT_ID } },
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const links = [...shell.container.querySelectorAll<HTMLAnchorElement>('.rail__nav-item')];
    // Projects, Settings, and — because the route above carries a
    // `projectId` — Workflows and Runs (AC2's own item set).
    expect(links.length).toBeGreaterThanOrEqual(4);

    for (const link of links) {
      const label = link.textContent?.trim() ?? '';
      expect(label.toLowerCase()).not.toBe('builder');

      const resolved = shell.router.resolve(link.getAttribute('href') ?? '');
      expect(routeNames.has(String(resolved.name))).toBe(true);
    }
  });

  it('says the same of the topbar’s own nav, which stands in below 820px', async () => {
    const routeNames = new Set(routes.map((route) => route.name as string));

    // `project-connectors` used to be the route this spec mounted, but
    // KAR-25.4 turned it into a redirect to `/settings` — a global route
    // with no project-scoped nav to assert on. `project-workflows` is the
    // same project-scoped route the spec above already mounts successfully
    // against this fixture, kept for the same claim this spec has always
    // made: a project-scoped URL shows the project-scoped nav in the topbar.
    shell = await mountShell({
      at: { name: 'project-workflows', params: { projectId: PROJECT_ID } },
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const links = [...shell.container.querySelectorAll<HTMLAnchorElement>('.topbar__nav-item')];
    expect(links.length).toBeGreaterThanOrEqual(4);
    for (const link of links) {
      expect((link.textContent?.trim() ?? '').toLowerCase()).not.toBe('builder');
      const resolved = shell.router.resolve(link.getAttribute('href') ?? '');
      expect(routeNames.has(String(resolved.name))).toBe(true);
    }
  });
});

suite('EPIC-24-S16 — nothing the old shell did is lost', () => {
  it('keeps the theme toggle, working', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({}),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const toggle = shell.container.querySelector<HTMLButtonElement>('.topbar__theme');
    expect(toggle).not.toBeNull();
    const before = toggle?.getAttribute('aria-pressed');

    toggle?.click();
    await expect.poll(() => toggle?.getAttribute('aria-pressed')).not.toBe(before);

    // `useTheme()` persists to `localStorage` and flips a class on `<html>`
    // for the life of the *page*, not this test — `../app/theme.test.ts` resets
    // both in its own `afterEach` for the same reason. Clicking back is the
    // cheapest way to leave the page as this test found it, so a colour
    // assertion in a spec the runner picks up next is not quietly run against
    // the wrong theme.
    toggle?.click();
    await expect.poll(() => toggle?.getAttribute('aria-pressed')).toBe(before);
  });

  it('keeps the approvals badge, with its aria-label', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ approvals: 3 }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const badge = () => shell.container.querySelector('[data-approvals]');
    await expect.poll(() => badge()?.getAttribute('data-approvals')).toBe('3');
    expect(badge()?.getAttribute('aria-label')).toMatch(/waiting/i);
  });

  it('keeps the search field, labelled for a screen reader', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({}),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const input = shell.container.querySelector(`#${SEARCH_INPUT_ID}`);
    expect(input).not.toBeNull();
    expect(shell.container.querySelector('.topbar__search-label')?.textContent).toMatch(/search/i);
  });

  it('keeps the provider banner and the task banner, folded from the run’s own ledger', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({}),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

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

    await expect
      .poll(() => shell.container.querySelector('[data-run-task]')?.textContent)
      .toContain('Migrate the checkout module');
    expect(shell.container.querySelector('[data-run-provider]')).not.toBeNull();
  });
});

suite('EPIC-24-S17 — the skip-link, and a tab with no token', () => {
  it('is first in the tab order and moves focus to the main region', async () => {
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    await userEvent.tab();
    const focused = document.activeElement as HTMLElement;
    expect(focused.tagName).toBe('A');
    expect(focused.getAttribute('href')).toBe(`#${MAIN_CONTENT_ID}`);
    expect(focused.textContent).toMatch(/skip/i);

    focused.click();
    expect(document.activeElement?.id).toBe(MAIN_CONTENT_ID);
  });

  it('renders TokenRequired and issues no project (or provider) request', async () => {
    const sent: string[] = [];
    shell = await mountShell({
      anonymous: true,
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS, sent }),
        token: () => null,
      }),
    });

    expect(shell.container.querySelector('#token-required-url')).not.toBeNull();
    expect(shell.container.querySelector('[data-frame-rail]')).toBeNull();

    // Give anything that was going to fire on mount a turn to fire in.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sent.some((url) => url.includes('/projects'))).toBe(false);
    expect(sent.some((url) => url.includes('/providers'))).toBe(false);
  });
});

suite('EPIC-24-S18 — the rail across three widths (AC7)', () => {
  it('is full at 1440px', async () => {
    await atViewport(1440);
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const rail = shell.container.querySelector<HTMLElement>('[data-frame-rail]');
    expect(rail).not.toBeNull();
    expect(getComputedStyle(rail as HTMLElement).display).not.toBe('none');
    expect((rail as HTMLElement).getBoundingClientRect().width).toBeGreaterThan(200);

    const label = shell.container.querySelector<HTMLElement>('.rail__nav-label');
    expect(label && getComputedStyle(label).position).not.toBe('absolute');

    const runsLink = shell.container.querySelector<HTMLAnchorElement>('.rail__nav-item');
    expect(runsLink?.getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it('is icon-only at 1000px, with the nav still reachable', async () => {
    await atViewport(1000);
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const rail = shell.container.querySelector<HTMLElement>('[data-frame-rail]');
    expect(rail).not.toBeNull();
    const width = (rail as HTMLElement).getBoundingClientRect().width;
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(120);

    // The label is clipped off-screen, not `display:none` — still in the
    // accessible name, never in the sighted layout.
    const label = shell.container.querySelector<HTMLElement>('.rail__nav-label');
    expect(label && getComputedStyle(label).position).toBe('absolute');

    const runsLink = shell.container.querySelector<HTMLAnchorElement>('.rail__nav-item');
    expect(runsLink?.getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it('is absent at 760px, with the nav reachable through the topbar instead', async () => {
    await atViewport(760);
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const rail = shell.container.querySelector<HTMLElement>('[data-frame-rail]');
    expect(rail).not.toBeNull();
    expect(getComputedStyle(rail as HTMLElement).display).toBe('none');

    const topbarNav = shell.container.querySelector<HTMLElement>('.topbar__nav');
    expect(topbarNav).not.toBeNull();
    expect(getComputedStyle(topbarNav as HTMLElement).display).not.toBe('none');

    const runsLink = shell.container.querySelector<HTMLAnchorElement>('.topbar__nav-item');
    expect(runsLink).not.toBeNull();
    expect((runsLink as HTMLAnchorElement).getBoundingClientRect().width).toBeGreaterThan(0);
  });
});

/**
 * EPIC-24-S16's last case, deliberately last in the *file*: it navigates the
 * shell, and running it before anything that depends on a clean `Tab` order
 * (`EPIC-24-S17`) keeps this file's own ordering concern — described in the
 * KAR-24.8 era by the composer's now-removed focus trap — from becoming a new
 * one over a route change instead.
 */
suite('EPIC-24-S16 — nothing the old shell did is lost (continued)', () => {
  it('keeps the composer button, and it still opens the composer', async () => {
    shell = await mountShell({
      at: { name: 'project-workflows', params: { projectId: PROJECT_ID } },
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: frameDaemon({ projects: [PROJECT], providers: PROVIDERS }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const button = shell.container.querySelector<HTMLButtonElement>('[data-composer-open]');
    expect(button).not.toBeNull();

    // KAR-25.5 — no `UiModal`, no overlay: the button now navigates to the
    // composer's own route. AC1 says there is no dialog role for this
    // assertion to have found any more — the button surviving, and landing
    // where it says it will, is what "still opens the composer" means now.
    button?.click();
    await expect.poll(() => shell.router.currentRoute.value.name).toBe('new-run');
    expect(shell.router.currentRoute.value.params['projectId']).toBe(PROJECT_ID);
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  });
});
