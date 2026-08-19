/**
 * KAR-25.2 — the way home: the rail's brand mark and the topbar's breadcrumb,
 * mounted in the real shell.
 *
 * Verifies: EPIC-25-S12, EPIC-25-S13 · AC4, AC5, AC6, AC7
 *
 * Modelled on `./frame.test.ts` and `./nav-scope.test.ts`: `mountShell`
 * assembles the one real application, so what is under test here is the rail
 * and the topbar as they actually ship.
 *
 * **AC6 below 820px.** The rail — and its brand mark — is `display: none`
 * below that width (`AppRail.vue` AC7); the topbar's own nav stands in
 * instead, and it already carries a "Projects" item pointing at `/projects`,
 * the same place `/` redirects to (KAR-25.1). So the brand mark's own tests
 * below widen the Tester iframe past 820px, the way `./frame.test.ts` and
 * `./nav-scope.test.ts` already do for rail-only assertions — and the last
 * case in the AC6 suite proves the narrow width is not left with no way home
 * at all, just a differently-labelled one.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';

/** `./frame.test.ts`'s own trick, copied rather than imported: the Tester
 *  iframe this spec's `window` lives inside is held at a fixed logical size
 *  (measured at 414×896), narrower than the rail's 820px breakpoint, so the
 *  rail — and the brand mark inside it — does not render by default. */
let savedFrameSize: { readonly width: string; readonly height: string } | null = null;

function testerFrame(): HTMLElement {
  const el = window.frameElement;
  if (el === null || el.tagName !== 'IFRAME') {
    throw new Error('EPIC-25-S12 expected this window’s frameElement to be the Tester iframe');
  }
  return el as unknown as HTMLElement;
}

async function atFullWidth(): Promise<void> {
  const frame = testerFrame();
  savedFrameSize ??= { width: frame.style.width, height: frame.style.height };
  frame.style.width = '1440px';
  frame.style.height = '900px';
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function restoreViewport(): void {
  if (savedFrameSize === null) return;
  const frame = testerFrame();
  frame.style.width = savedFrameSize.width;
  frame.style.height = savedFrameSize.height;
  savedFrameSize = null;
}

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: { readonly state: string; readonly message: string | null };
  readonly lastRun: null;
}

const PROJECT: ProjectRow = {
  id: PROJECT_ID,
  name: 'checkout',
  path: '/repos/checkout',
  createdAt: '2026-08-15T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
};

/** Every path the frame's own pieces reach, answered from one fixed daemon —
 *  `./frame.test.ts`'s own `frameDaemon`, copied rather than imported. */
function frameDaemon(options: { readonly projects?: readonly ProjectRow[] }) {
  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/providers')) return json(200, []);
    if (/\/api\/projects\/[^/?]+\/runs$/.test(url)) return json(200, { runs: [] });
    if (url.includes('/projects')) return json(200, { projects: options.projects ?? [] });
    if (url.includes('/approvals'))
      return json(200, { items: [], counts: { total: 0 }, headSeq: 1 });
    return json(404, { error: { message: 'not found' } });
  };
}

function client() {
  return createClient({
    baseUrl: 'http://127.0.0.1:7777/api',
    fetch: frameDaemon({ projects: [PROJECT] }),
    token: () => 'test-token-Aa0_-Bb1',
  });
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
  restoreViewport();
});

suite('EPIC-25-S12 — the brand mark goes home, by mouse and by keyboard (AC4)', () => {
  it('is a real link to / with an accessible name', async () => {
    await atFullWidth();
    shell = await mountShell({ at: '/settings', client: client() });

    const brand = shell.container.querySelector<HTMLAnchorElement>('.rail__brand');
    expect(brand?.tagName).toBe('A');
    expect(brand?.getAttribute('href')).toBe('/');
    expect(brand?.getAttribute('aria-label')).toBe('DeFlow — home');
  });

  it('is reachable and activatable from the keyboard', async () => {
    await atFullWidth();
    shell = await mountShell({ at: '/settings', client: client() });

    const brand = shell.container.querySelector<HTMLAnchorElement>('.rail__brand');
    // `userEvent.tab()`, not a programmatic `.focus()`: this is the same real
    // keyboard walk `../app/frame.test.ts`'s own skip-link case makes, and it
    // is what actually moves this Tester iframe's own focus rather than only
    // `document.activeElement` in isolation. The skip-link is first in the tab
    // order (`../app/frame.test.ts`'s own EPIC-24-S17 case); the brand mark is
    // the next focusable element after it.
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(brand);

    await userEvent.keyboard('{Enter}');
    await expect.poll(() => shell.router.currentRoute.value.name).toBe('projects');
  });
});

suite('EPIC-25-S12 — / is one click away from anywhere, with no browser history (AC6)', () => {
  it.each([
    '/settings',
    { name: 'project-workflows', params: { projectId: PROJECT_ID } },
    { name: 'project-runs', params: { projectId: PROJECT_ID } },
  ])('lands on the project chooser from %j, via the rail’s brand mark', async (at) => {
    await atFullWidth();
    shell = await mountShell({ at, client: client() });

    const brand = shell.container.querySelector<HTMLAnchorElement>('.rail__brand');
    brand?.click();

    await expect.poll(() => shell.router.currentRoute.value.name).toBe('projects');
    expect(shell.router.currentRoute.value.path).toBe('/projects');
  });

  // Below 820px the rail — and the brand mark with it — is not rendered at
  // all (`AppRail.vue` AC7); the topbar's own nav stands in, and its
  // "Projects" item already points at the same place `/` redirects to, so a
  // narrow tab is never left with no one-click way home, only a
  // differently-labelled one.
  it('still lands on the project chooser below 820px, via the topbar’s own nav', async () => {
    shell = await mountShell({
      at: { name: 'project-runs', params: { projectId: PROJECT_ID } },
      client: client(),
    });

    const projectsItem = [
      ...shell.container.querySelectorAll<HTMLAnchorElement>('.topbar__nav-item'),
    ].find((link) => link.textContent?.trim() === 'Projects');
    projectsItem?.click();

    await expect.poll(() => shell.router.currentRoute.value.name).toBe('projects');
  });
});

suite('EPIC-25-S13 — every breadcrumb segment but the last navigates (AC5)', () => {
  it('is a nav of links, with only the last segment current and unlinked', async () => {
    shell = await mountShell({
      at: { name: 'project-runs', params: { projectId: PROJECT_ID } },
      client: client(),
    });

    const nav = shell.container.querySelector('nav.topbar__crumb');
    expect(nav?.getAttribute('aria-label')).toBe('Breadcrumb');

    const items = [...(nav as HTMLElement).querySelectorAll('li')];
    expect(items).toHaveLength(2);

    const projectLink = items[0]?.querySelector<HTMLAnchorElement>('a');
    expect(projectLink?.textContent?.trim()).toBe(PROJECT_ID);
    expect(projectLink?.getAttribute('href')).toBe(`/projects/${PROJECT_ID}`);
    expect(items[0]?.querySelector('[aria-current]')).toBeNull();

    const viewSegment = items[1]?.querySelector('.topbar__crumb-view');
    expect(viewSegment?.textContent?.trim()).toBe('Runs');
    expect(viewSegment?.getAttribute('aria-current')).toBe('page');
    expect(items[1]?.querySelector('a')).toBeNull();
  });

  it('activating the project segment lands on that project', async () => {
    shell = await mountShell({
      at: { name: 'project-runs', params: { projectId: PROJECT_ID } },
      client: client(),
    });

    const projectLink = shell.container.querySelector<HTMLAnchorElement>('.topbar__crumb-project');
    projectLink?.click();

    await expect.poll(() => shell.router.currentRoute.value.name).toBe('project-workflows');
    expect(shell.router.currentRoute.value.params['projectId']).toBe(PROJECT_ID);
  });

  it('is a single, unlinked segment on the global /settings page', async () => {
    shell = await mountShell({ at: '/settings', client: client() });

    const nav = shell.container.querySelector('nav.topbar__crumb');
    const items = [...(nav as HTMLElement).querySelectorAll('li')];
    expect(items).toHaveLength(1);
    expect(items[0]?.querySelector('a')).toBeNull();
    expect(items[0]?.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('Settings');
  });
});

suite('KAR-25.2 AC7 — /settings stays in the rail’s global set, and is active there', () => {
  it('shows Settings as the active row on /settings', async () => {
    shell = await mountShell({ at: '/settings', client: client() });

    const active = shell.container.querySelector<HTMLAnchorElement>('.rail__nav-item--active');
    expect(active?.getAttribute('href')).toBe('/settings');
    expect(active?.getAttribute('aria-current')).toBe('page');
    expect(active?.textContent?.trim()).toBe('Settings');
  });
});
