/**
 * KAR-25.5 — the composer's own page, in a real Chromium: the claims that
 * belong to it being a *route* rather than the overlay it used to be.
 *
 * `./composer.test.ts` is still the contract for everything the composer
 * *does* (the three intake shapes, the picker, the refusal, the submit
 * chord) — this file is only the shell of story-specific behaviour that
 * exists because the composer stopped being a dialog: no dialog role, no
 * focus trap, `Esc` does nothing, `/` reaches the prompt, and the adapter
 * picker renders only what `GET /api/providers/routes` actually sends.
 *
 * Verifies: AC1, AC4, AC5, EPIC-25-S34
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';
const PROJECT_PATH = '/repos/checkout';

interface PickerRow {
  readonly id: string;
  readonly available: boolean;
  readonly route: 'acp' | 'shim' | null;
  readonly routes: { readonly acp: string; readonly shim: string };
  readonly reason: string;
  readonly action: string | null;
  readonly limitation: string | null;
}

const usable = (over: Partial<PickerRow> = {}): PickerRow => ({
  id: 'mock',
  available: true,
  route: 'shim',
  routes: { acp: 'available', shim: 'available' },
  reason: '"deflow-mock-agent" — the binary DeFlow spawns — resolves at /usr/local/bin/x.',
  action: null,
  limitation: null,
  ...over,
});

const ABSENT: PickerRow = {
  id: 'gamma',
  available: false,
  route: null,
  routes: { acp: 'missing', shim: 'missing' },
  reason: 'gamma is not installed here: no executable "gamma" was found on PATH.',
  action: 'npm install -g @example/gamma',
  limitation: null,
};

/** A client answering just what `NewRunView`/`RunComposer` read on mount. */
function newRunClient(providers: readonly PickerRow[] = [usable()]): ApiClient {
  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  return {
    providers: { routes: { $get: () => json(200, { providers }) } },
    projects: Object.assign(
      {
        $get: () =>
          json(200, {
            projects: [
              {
                id: PROJECT_ID,
                name: 'checkout',
                path: PROJECT_PATH,
                createdAt: '2026-08-15T10:11:12.000Z',
                health: { state: 'ok', message: null },
                lastRun: null,
              },
            ],
          }),
      },
      {
        ':id': {
          connectors: {
            $get: () => json(200, { services: [] }),
          },
        },
      },
    ),
    runs: { $get: () => json(200, { runs: [], cursor: null, more: false }) },
    approvals: { $get: () => json(200, { items: [] }) },
  } as unknown as ApiClient;
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

const one = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountNewRun(providers?: readonly PickerRow[]): Promise<void> {
  shell = await mountShell({
    at: { name: 'new-run', params: { projectId: PROJECT_ID } },
    client: newRunClient(providers),
  });
  await settle();
}

suite('AC1 — the composer is a page, not a dialog', () => {
  it('renders with no modal dialog anywhere on the page', async () => {
    await mountNewRun();

    expect(one('[data-composer]')).not.toBeNull();
    // The combined selector, not `[role="dialog"]` alone: the adapter
    // popover (Reka's `PopoverContent`) carries a bare `role="dialog"` the
    // same way any Reka popover does, force-mounted so its rows stay
    // reachable — but it is not modal, traps no focus and sets no
    // `aria-modal`. What AC1 forbids is `UiModal`'s whole-page dialog, which
    // this combined check is what `frame.test.ts`'s own fixed point uses.
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  });

  it('does nothing on Escape: no navigation, no overlay, nothing dismissed', async () => {
    await mountNewRun();
    const before = shell.router.currentRoute.value.fullPath;

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();

    expect(shell.router.currentRoute.value.fullPath).toBe(before);
    expect(shell.ui.overlays).toEqual([]);
    // The composer is still right here — Escape closed nothing because there
    // was nothing for it to own.
    expect(one('[data-composer]')).not.toBeNull();
  });
});

suite(
  'AC5 — the prompt is focused on arrival, and "/" reaches it from anywhere on the page',
  () => {
    it('focuses the prompt the moment the route is entered', async () => {
      await mountNewRun();

      await expect
        .poll(() => document.activeElement)
        .toBe(document.querySelector('[data-composer-text]'));
    });

    it('"/" focuses the prompt even when focus is elsewhere on the page', async () => {
      await mountNewRun();

      const prompt = one('[data-composer-text]') as HTMLTextAreaElement;
      prompt.blur();
      document.body.focus();
      expect(document.activeElement).not.toBe(prompt);

      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
      await settle();

      expect(document.activeElement).toBe(prompt);
    });
  },
);

/**
 * AC4 — the model picker cannot be "grouped by provider, showing each
 * model's context size" from `GET /api/providers/routes` alone: that route
 * answers with one row per *adapter*, not per model, and carries no vendor
 * taxonomy and no context-window field (`test/no-context-window-table.test.ts`
 * forbids inventing the latter — KAR-09.7 AC2). What it renders instead is the
 * one grouping the wire shape actually supports: usable first, then the rest,
 * which is the same order `GET /api/providers/routes` already returns them in.
 */
suite('AC4 — the adapter picker renders only what the daemon actually sends', () => {
  it('groups usable adapters ahead of unusable ones, and names both groups', async () => {
    await mountNewRun([usable({ id: 'alpha' }), ABSENT]);

    expect(one('[data-composer-providers]')?.textContent).toContain('Usable here');
    expect(one('[data-composer-providers]')?.textContent).toContain('Not usable here');
    expect(one('[data-provider-row="alpha"]')).not.toBeNull();
    expect(one('[data-provider-row="gamma"]')).not.toBeNull();
  });

  it('names no model, no vendor group and no context window anywhere on the page', async () => {
    await mountNewRun([usable({ id: 'alpha' }), ABSENT]);

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+k context/i);
    expect(text).not.toMatch(/claude-|gpt-|llama\d/i);
  });

  it('shows the trigger reading the selected adapter, not a model name', async () => {
    await mountNewRun([usable({ id: 'alpha' })]);

    await expect
      .poll(() => one('[data-composer-provider-trigger]')?.textContent?.trim())
      .toBe('alpha');
  });
});
