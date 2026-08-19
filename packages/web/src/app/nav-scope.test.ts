/**
 * KAR-25.1 — the nav's scope rule and the active row's readability, mounted
 * in the real shell.
 *
 * Verifies: EPIC-25-S01, EPIC-25-S02, EPIC-25-S03, EPIC-25-S04, EPIC-25-S06 ·
 * AC1–AC5, AC7
 *
 * Modelled on `./frame.test.ts`: `mountShell` assembles the one real
 * application, so what is under test here is the rail and the router as they
 * actually ship. EPIC-24's visual exception (KAR-25 grants no red-test-first
 * requirement for layout or token changes) does not reach this file — every
 * scope rule, the redirect and the contrast fix are behaviour, and this suite
 * is what was red before AppRail.vue, AppTopBar.vue, theme.css and
 * router/legacy-run.ts changed.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';
import { DARK_CLASS } from './theme.ts';

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';
const RUN_ID = 'run_20260818T090000Z_aaaaaa';

/**
 * `./frame.test.ts`'s own trick, copied rather than imported: the Tester
 * iframe this spec's `window` lives inside is held at a fixed logical size
 * (measured at 414×896 — narrower than the rail's 820px breakpoint), so the
 * rail is `display: none` and `.rail__nav-item--active` cannot be hovered by
 * default. S03 is a claim about the *rail*, so this widens the frame past
 * both breakpoints before reading it.
 */
let savedFrameSize: { readonly width: string; readonly height: string } | null = null;

function testerFrame(): HTMLElement {
  const el = window.frameElement;
  if (el === null || el.tagName !== 'IFRAME') {
    throw new Error('EPIC-25-S03 expected this window’s frameElement to be the Tester iframe');
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

/** A daemon that answers exactly what the frame and the legacy-run guard ask
 * for — no more, mirroring `./frame.test.ts`'s own `frameDaemon`. */
function daemon(options: {
  readonly projects?: readonly ProjectRow[];
  readonly runLookup?: Record<string, { status: number; body: unknown }>;
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

    const runMatch = /\/api\/runs\/([^/?]+)$/.exec(url);
    if (runMatch) {
      const answer = options.runLookup?.[runMatch[1] as string];
      if (answer !== undefined) return json(answer.status, answer.body);
      return json(404, { error: { code: 'run_not_found', message: 'no such run' } });
    }
    if (url.includes('/providers')) return json(200, []);
    // Before the general `/projects` branch below: `/api/projects/:id/runs`
    // also contains the substring "/projects" and needs its own shape
    // (`ProjectWorkflowsView`'s history table reads `.runs`, not `.projects`).
    if (/\/api\/projects\/[^/?]+\/runs$/.test(url)) return json(200, { runs: [] });
    if (url.includes('/projects')) return json(200, { projects: options.projects ?? [] });
    if (url.includes('/approvals'))
      return json(200, { items: [], counts: { total: 0 }, headSeq: 1 });
    return json(404, { error: { message: 'not found' } });
  };
}

function railLabels(shell: MountedShell): string[] {
  return [...shell.container.querySelectorAll<HTMLAnchorElement>('.rail__nav-item')].map(
    (link) => link.textContent?.trim() ?? '',
  );
}

let shell: MountedShell;

afterEach(async () => {
  shell?.unmount();
  await commands.emulateMedia({});
  document.documentElement.classList.remove(DARK_CLASS);
  restoreViewport();
});

suite('EPIC-25-S01 — the rail offers only what this scope can do', () => {
  it('shows exactly Projects and Settings at /projects, and the full set inside a project', async () => {
    shell = await mountShell({
      at: '/projects',
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: daemon({ projects: [PROJECT] }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    expect(railLabels(shell)).toEqual(['Projects', 'Settings']);

    await shell.router.push({ name: 'project-workflows', params: { projectId: PROJECT_ID } });
    expect(railLabels(shell)).toEqual(['Projects', 'Workflows', 'Runs', 'Settings']);

    await shell.router.push('/projects');
    expect(railLabels(shell)).toEqual(['Projects', 'Settings']);
  });
});

suite('EPIC-25-S02 — Projects and Settings survive every navigation', () => {
  it.each([
    '/',
    '/projects',
    '/settings',
    { name: 'project-workflows', params: { projectId: PROJECT_ID } },
    { name: 'project-runs', params: { projectId: PROJECT_ID } },
    { name: 'project-run', params: { projectId: PROJECT_ID, runId: RUN_ID } },
  ])('keeps both global items at %j', async (at) => {
    shell = await mountShell({
      at,
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: daemon({ projects: [PROJECT] }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const links = [...shell.container.querySelectorAll<HTMLAnchorElement>('.rail__nav-item')];
    const projects = links.find((link) => link.textContent?.trim() === 'Projects');
    const settings = links.find((link) => link.textContent?.trim() === 'Settings');

    expect(projects?.getAttribute('href')).toBe('/projects');
    expect(settings?.getAttribute('href')).toBe('/settings');
  });
});

suite('EPIC-25-S03 — the active row clears AA, resting and hovered, in both themes', () => {
  function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
    const channel = (byte: number): number => {
      const c = byte / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function contrastRatio(a: string, b: string): number {
    const parse = (colour: string): { r: number; g: number; b: number } => {
      const match = /rgba?\(([^)]+)\)/.exec(colour);
      const [r, g, b] = (match?.[1] ?? '0, 0, 0').split(',').map((part) => Number.parseFloat(part));
      return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
    };
    const lumA = relativeLuminance(parse(a));
    const lumB = relativeLuminance(parse(b));
    const lighter = Math.max(lumA, lumB);
    const darker = Math.min(lumA, lumB);
    return (lighter + 0.05) / (darker + 0.05);
  }

  for (const theme of ['light', 'dark'] as const) {
    it(`the active row is at least 4.5:1, resting and hovered, in ${theme}`, async () => {
      await atFullWidth();
      await commands.emulateMedia({ colorScheme: theme });
      if (theme === 'dark') document.documentElement.classList.add(DARK_CLASS);

      shell = await mountShell({
        at: { name: 'project-workflows', params: { projectId: PROJECT_ID } },
        client: createClient({
          baseUrl: 'http://127.0.0.1:7777/api',
          fetch: daemon({ projects: [PROJECT] }),
          token: () => 'test-token-Aa0_-Bb1',
        }),
      });

      const active = shell.container.querySelector<HTMLElement>('.rail__nav-item--active');
      expect(active).not.toBeNull();

      const resting = getComputedStyle(active as HTMLElement);
      const restingRatio = contrastRatio(resting.color, resting.backgroundColor);
      expect(
        restingRatio,
        `resting ${theme}: ${resting.color} on ${resting.backgroundColor}`,
      ).toBeGreaterThanOrEqual(4.5);

      await userEvent.hover(active as HTMLElement);
      const hovered = getComputedStyle(active as HTMLElement);
      const hoveredRatio = contrastRatio(hovered.color, hovered.backgroundColor);
      expect(
        hoveredRatio,
        `hovered ${theme}: ${hovered.color} on ${hovered.backgroundColor}`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});

suite('EPIC-25-S04 — the active row is legible without colour', () => {
  it('carries aria-current="page" and a heavier weight than an inactive row', async () => {
    shell = await mountShell({
      at: { name: 'project-workflows', params: { projectId: PROJECT_ID } },
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: daemon({ projects: [PROJECT] }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    const links = [...shell.container.querySelectorAll<HTMLAnchorElement>('.rail__nav-item')];
    const active = links.find((link) => link.getAttribute('aria-current') === 'page');
    const inactive = links.find((link) => link.getAttribute('aria-current') !== 'page');

    expect(active).not.toBeUndefined();
    expect(inactive).not.toBeUndefined();

    const activeWeight = Number.parseInt(getComputedStyle(active as HTMLElement).fontWeight, 10);
    const inactiveWeight = Number.parseInt(
      getComputedStyle(inactive as HTMLElement).fontWeight,
      10,
    );
    expect(activeWeight).toBeGreaterThan(inactiveWeight);
  });
});

suite('EPIC-25-S06 — a bookmarked global run URL still resolves', () => {
  it('redirects a project-bound run to its project-scoped equivalent', async () => {
    shell = await mountShell({
      at: `/runs/${RUN_ID}`,
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: daemon({
          projects: [PROJECT],
          runLookup: { [RUN_ID]: { status: 200, body: { runId: RUN_ID, projectId: PROJECT_ID } } },
        }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    expect(shell.router.currentRoute.value.name).toBe('run-plan');
    expect(shell.router.currentRoute.value.params['projectId']).toBe(PROJECT_ID);
    expect(shell.router.currentRoute.value.path).toBe(
      `/projects/${PROJECT_ID}/runs/${RUN_ID}/plan`,
    );
    expect(shell.container.querySelector('.not-found')).toBeNull();
  });

  it('renders not-found for a run that does not exist, with no redirect loop', async () => {
    shell = await mountShell({
      at: '/runs/run_nope',
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: daemon({ projects: [PROJECT] }),
        token: () => 'test-token-Aa0_-Bb1',
      }),
    });

    expect(shell.router.currentRoute.value.name).toBe('legacy-run-plan');
    expect(shell.router.currentRoute.value.path).toBe('/runs/run_nope');
    expect(shell.container.querySelector('.not-found')).not.toBeNull();

    // No loop: a second navigation to the same URL still resolves once rather
    // than bouncing between this route and the catch-all.
    await shell.router.push('/runs/run_nope');
    expect(shell.router.currentRoute.value.path).toBe('/runs/run_nope');
  });
});
