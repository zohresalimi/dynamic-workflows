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
 * Verifies: AC1, AC4, AC5, EPIC-25-S34 · KAR-26.3 AC1, AC3, AC4, AC5, AC6,
 * EPIC-26-S15, EPIC-26-S16, EPIC-26-S18, EPIC-26-S19, EPIC-26-S20,
 * EPIC-26-S21, EPIC-26-S22
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
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

interface RoutesOptions {
  /** `GET /providers/routes`'s `known` envelope field. Defaults to `true`,
   *  which is what a daemon that was told its machine answers. */
  readonly known?: boolean;
  /** Answer the route report request with a 500 instead of a report — the
   *  "no report reached this tab" state, distinct from `known: false`. */
  readonly fail?: boolean;
  /** Fail only the *first* route report request — the retry scenario: the
   *  daemon is up (it answered 500), and asking again succeeds. */
  readonly failFirst?: boolean;
}

/** A client answering just what `NewRunView`/`RunComposer` read on mount. */
function newRunClient(
  providers: readonly PickerRow[] = [usable()],
  routes: RoutesOptions = {},
): ApiClient {
  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  let routeCalls = 0;

  return {
    providers: {
      routes: {
        $get: () => {
          routeCalls += 1;
          const failing = routes.fail === true || (routes.failFirst === true && routeCalls === 1);
          return failing
            ? json(500, { error: { message: 'the daemon fell over' } })
            : json(200, { providers, known: routes.known ?? true });
        },
      },
    },
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

async function mountNewRun(
  providers?: readonly PickerRow[],
  routes: RoutesOptions = {},
): Promise<void> {
  shell = await mountShell({
    at: { name: 'new-run', params: { projectId: PROJECT_ID } },
    client: newRunClient(providers, routes),
  });
  await settle();
}

/** Opens the adapter control the way an operator does — through its trigger
 *  in the composer's bottom bar. The panel is portalled and mounted only
 *  while open, so every read of a `[data-provider-row]` goes through here. */
async function openAdapters(): Promise<void> {
  await userEvent.click(one('[data-composer-provider-trigger]') as HTMLElement);
  await expect.poll(() => one('[data-composer-providers]')).not.toBeNull();
}

suite('AC1 — the composer is a page, not a dialog', () => {
  it('renders with no modal dialog anywhere on the page', async () => {
    await mountNewRun();

    expect(one('[data-composer]')).not.toBeNull();
    // The combined selector, not `[role="dialog"]` alone: the adapter
    // popover (Reka's `PopoverContent`) carries a bare `role="dialog"` the
    // same way any Reka popover does while it is open — but it is not modal,
    // traps no focus and sets no `aria-modal` (and since KAR-26.3 it is not
    // mounted at all until the trigger opens it). What AC1 forbids is
    // `UiModal`'s whole-page dialog, which this combined check is what
    // `frame.test.ts`'s own fixed point uses.
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
    // KAR-26.3 — the rows live in the trigger's popover now, and the usable
    // section is labelled by its route (`exec shim`, doctor's own words)
    // rather than the generic 'Usable here'; the change is recorded in
    // EPIC-26-run-clean.md's KAR-26.3 notes.
    await openAdapters();

    expect(one('[data-composer-providers]')?.textContent).toContain('exec shim');
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
      .toContain('alpha');
  });

  it('invents no model, vendor or context window with the popover open either', async () => {
    // The closed page passing the regex above proves little once the rows are
    // popover-only content: the place an invented field would land is the open
    // panel, so the same regexes run again with it open.
    await mountNewRun([usable({ id: 'alpha' }), ABSENT]);
    await openAdapters();

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+k context/i);
    expect(text).not.toMatch(/claude-|gpt-|llama\d/i);
  });
});

/**
 * KAR-26.3 AC6, EPIC-26-S15 — the composer renders no adapter content outside
 * the bottom-bar control. This is the DOM-level guard the story asks for: the
 * floating card the owner photographed was the popover's force-mounted body
 * sitting in page flow, and this suite is what keeps it from coming back.
 */
suite('KAR-26.3 AC6 — no adapter content outside the bottom-bar control', () => {
  it('renders no adapter rows and no group container while the control is closed', async () => {
    await mountNewRun([usable({ id: 'alpha' }), ABSENT]);

    expect(document.querySelectorAll('[data-provider-row]')).toHaveLength(0);
    expect(one('[data-composer-providers]')).toBeNull();
  });

  it('anchors the trigger inside the composer bottom bar', async () => {
    await mountNewRun([usable({ id: 'alpha' })]);

    expect(one('[data-composer-provider-trigger]')?.closest('[data-composer-bar]')).not.toBeNull();
  });

  it('keeps every row inside the portalled panel and none inside the page-flow composer', async () => {
    await mountNewRun([usable({ id: 'alpha' }), ABSENT]);
    await openAdapters();

    const rows = [...document.querySelectorAll<HTMLElement>('[data-provider-row]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.closest('[data-composer-adapters-panel]')).not.toBeNull();
    }
    // The panel is portalled, so the composer's own subtree holds nothing but
    // the trigger and its accessible note — open or closed.
    expect(
      document.querySelectorAll(
        '[data-composer] [data-provider-row], [data-composer] [data-composer-providers]',
      ),
    ).toHaveLength(0);
  });
});

/**
 * KAR-26.3 AC1, EPIC-26-S16 — grouped by route with section labels, the
 * chosen row marked. The wire carries no vendor and no runtime name
 * (`providerOptions`'s field list is the whole vocabulary), so the section
 * labels are the route labels `doctor` prints — the closest honest analogue
 * of the blueprint's `ANTHROPIC · API`.
 */
suite('KAR-26.3 AC1 — the popover groups by route and ticks the chosen row', () => {
  it('labels each route section with doctor’s own words', async () => {
    await mountNewRun([
      usable({ id: 'alpha', route: 'acp' }),
      usable({ id: 'beta', route: 'shim' }),
      ABSENT,
    ]);
    await openAdapters();

    const panel = one('[data-composer-providers]');
    expect(panel?.textContent).toContain('ACP adapter');
    expect(panel?.textContent).toContain('exec shim');
    expect(panel?.textContent).toContain('Not usable here');
  });

  it('marks the selected row and only the selected row', async () => {
    await mountNewRun([usable({ id: 'alpha' }), usable({ id: 'beta' })]);
    await openAdapters();

    expect(one('[data-provider-row="alpha"] [data-provider-tick]')).not.toBeNull();
    expect(one('[data-provider-row="beta"] [data-provider-tick]')).toBeNull();
  });
});

/**
 * KAR-26.3 AC3, EPIC-26-S19 — `known: false` renders inside the control: the
 * popover body carries the existing sentence, and the trigger carries it as
 * an accessible description, because the popover body is unmounted while
 * closed and can never be an `aria-describedby` target.
 */
suite('KAR-26.3 AC3 — the unknown-machine state lives inside the control', () => {
  it('describes the trigger with the existing sentence, resolvable while closed', async () => {
    await mountNewRun([], { known: false });

    const trigger = one('[data-composer-provider-trigger]');
    const noteId = trigger?.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    const note = document.getElementById(noteId as string);
    expect(note?.textContent).toContain('has not been told which machine it is on');
    expect(note?.closest('[data-composer-bar]')).not.toBeNull();
  });

  it('renders the sentence as the popover body, with no rows and no floating card', async () => {
    await mountNewRun([], { known: false });
    await openAdapters();

    const panel = one('[data-composer-providers]');
    expect(panel?.textContent).toContain('has not been told which machine it is on');
    expect(panel?.textContent).toContain('deflow up');
    expect(document.querySelectorAll('[data-provider-row]')).toHaveLength(0);
  });

  it('a failed route report is named as an absence, not as the unknown machine', async () => {
    // Today the composer collapses "the request failed" into the
    // machine-unknown sentence — a claim about the daemon's boot nobody
    // checked. A failed report gets its own honest wording, the same
    // three-way fact `RuntimesPanel.vue` already keeps.
    await mountNewRun([], { fail: true });
    await openAdapters();

    const panel = one('[data-composer-providers]');
    expect(panel?.textContent).toContain('No route report');
    expect(panel?.textContent).not.toContain('has not been told which machine it is on');
  });
});

/**
 * KAR-26.3 AC3/AC4/AC5, EPIC-26-S18, EPIC-26-S20, EPIC-26-S21 — zero usable
 * adapters: the empty state is inside the control, the unavailable row stays
 * visible with the daemon's reason, and Run is disabled.
 */
suite('KAR-26.3 — no usable adapter: same placement, Run disabled', () => {
  it('leads with the empty state and still renders the disabled row with its reason', async () => {
    await mountNewRun([ABSENT]);
    await openAdapters();

    const panel = one('[data-composer-providers]');
    expect(panel?.textContent).toContain('No adapter on this machine can serve a run');
    const row = one('[data-provider-row="gamma"]');
    expect(row?.dataset.providerAvailable).toBe('false');
    expect(row?.textContent).toContain('gamma is not installed here');
    expect(row?.querySelector<HTMLInputElement>('[data-provider-select]')?.disabled).toBe(true);
  });

  it('disables Run until an available adapter is chosen', async () => {
    await mountNewRun([ABSENT]);

    expect((one('[data-composer-submit]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Run once an available adapter is preselected', async () => {
    await mountNewRun();

    expect((one('[data-composer-submit]') as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * KAR-26.3 AC5, EPIC-26-S22 — overlay behaviour matches the house popovers:
 * Reka's own Escape closes the panel and returns focus to the trigger, and
 * none of it touches the app's overlay stack.
 */
suite('KAR-26.3 AC5 — Escape closes the control like every other Reka popover', () => {
  it('closes on Escape, returns focus to the trigger, and registers no app overlay', async () => {
    await mountNewRun([usable({ id: 'alpha' })]);
    await openAdapters();
    expect(shell.ui.overlays).toEqual([]);

    await userEvent.keyboard('{Escape}');
    await expect.poll(() => one('[data-composer-providers]')).toBeNull();
    expect(document.activeElement).toBe(one('[data-composer-provider-trigger]'));
    expect(shell.ui.overlays).toEqual([]);
    // And the composer page itself is untouched — Escape owned the popover,
    // nothing else (the AC1 suite holds the no-popover-open half).
    expect(one('[data-composer]')).not.toBeNull();
  });
});

/**
 * KAR-26.3 AC5 — the list is *browsable* by keyboard: moving through the
 * options is not committing to one. The radio rows this control first shipped
 * with selected on every arrow press and closed on the resulting `change`, so
 * the first ArrowDown committed a selection and dismissed the control — worse
 * than the plain fieldset they replaced. The rows are activation-committed
 * buttons now, the shape `frame/ProjectSwitcher.vue` and
 * `frame/ApprovalsMenu.vue` use: Tab and the arrow keys move focus, and only
 * Enter/Space/click commits and closes.
 */
suite('KAR-26.3 AC5 — arrow keys browse the options; only activation commits', () => {
  const rowButton = (id: string): HTMLButtonElement =>
    one(`[data-provider-row="${id}"] [data-provider-select]`) as HTMLButtonElement;

  it('moves focus with the arrows without selecting or closing, and Enter commits', async () => {
    await mountNewRun([usable({ id: 'alpha' }), usable({ id: 'beta' }), usable({ id: 'delta' })]);
    await openAdapters();
    rowButton('alpha').focus();

    await userEvent.keyboard('{ArrowDown}');
    // Still open, still alpha: browsing is not choosing.
    expect(one('[data-composer-providers]')).not.toBeNull();
    expect(one('[data-composer-provider-trigger]')?.textContent).toContain('alpha');
    expect(document.activeElement).toBe(rowButton('beta'));

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowButton('delta'));
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(rowButton('beta'));

    await userEvent.keyboard('{Enter}');
    await expect.poll(() => one('[data-composer-providers]')).toBeNull();
    expect(one('[data-composer-provider-trigger]')?.textContent).toContain('beta');
    expect(document.activeElement).toBe(one('[data-composer-provider-trigger]'));
  });

  it('skips unavailable rows when arrowing, and every available row is a real tab stop', async () => {
    await mountNewRun([usable({ id: 'alpha' }), ABSENT, usable({ id: 'beta' })]);
    await openAdapters();
    rowButton('alpha').focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(rowButton('beta'));

    // The disabled row is visible with its reason (AC4) but not focusable —
    // exactly a disabled control's semantics.
    expect(rowButton('gamma').disabled).toBe(true);
    for (const id of ['alpha', 'beta']) {
      expect(rowButton(id).tabIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes the selection state on the rows, not just as a glyph', async () => {
    await mountNewRun([usable({ id: 'alpha' }), usable({ id: 'beta' })]);
    await openAdapters();

    expect(rowButton('alpha').getAttribute('aria-pressed')).toBe('true');
    expect(rowButton('beta').getAttribute('aria-pressed')).toBe('false');
  });
});

/**
 * KAR-26.3 AC5 — pointer behaviour matches the house popovers: a click on any
 * part of a row (the reason line included) commits it, and a click on the
 * already-selected row still closes the control. The first cut put only the
 * head line inside the `<label>` (over half the styled row was inert) and
 * closed on `change`, which an already-checked radio never fires.
 */
suite('KAR-26.3 AC5 — the whole row is the hit target, and every click closes', () => {
  it('selects from a click on the reason line, not just the head', async () => {
    await mountNewRun([usable({ id: 'alpha' }), usable({ id: 'beta' })]);
    await openAdapters();

    await userEvent.click(one('[data-provider-row="beta"] [data-provider-reason]') as HTMLElement);

    await expect.poll(() => one('[data-composer-providers]')).toBeNull();
    expect(one('[data-composer-provider-trigger]')?.textContent).toContain('beta');
  });

  it('closes on a click on the already-selected row, selection unchanged', async () => {
    await mountNewRun([usable({ id: 'alpha' }), usable({ id: 'beta' })]);
    await openAdapters();

    await userEvent.click(one('[data-provider-row="alpha"] [data-provider-select]') as HTMLElement);

    await expect.poll(() => one('[data-composer-providers]')).toBeNull();
    expect(one('[data-composer-provider-trigger]')?.textContent).toContain('alpha');
  });
});

/**
 * KAR-26.3 AC3 — what the trigger *says* when nothing is chosen. 'No adapter'
 * is an affirmative claim about a report's contents; in the two states where
 * the daemon has not answered (`known: false`, no report reached this tab)
 * the honest word names the absence of an answer — the same rule
 * `lib/runtime-state.ts` states for conflating `machine-unknown` with
 * `unreported`. Only a real report with zero usable rows earns 'No adapter'.
 */
suite('KAR-26.3 AC3 — the trigger never claims "No adapter" for an unanswered question', () => {
  it('reads "Adapter unknown" when the daemon has not been told its machine', async () => {
    await mountNewRun([], { known: false });

    const label = one('[data-composer-provider-trigger]')?.textContent ?? '';
    expect(label).toContain('Adapter unknown');
    expect(label).not.toContain('No adapter');
  });

  it('reads "Adapter unknown" when no route report reached this page', async () => {
    await mountNewRun([], { fail: true });

    const label = one('[data-composer-provider-trigger]')?.textContent ?? '';
    expect(label).toContain('Adapter unknown');
    expect(label).not.toContain('No adapter');
  });

  it('still reads "No adapter" when the daemon reported zero usable adapters', async () => {
    await mountNewRun([ABSENT]);

    expect(one('[data-composer-provider-trigger]')?.textContent).toContain('No adapter');
  });
});

/**
 * KAR-26.3 AC3/AC5 — the disabled Run button carries the *reason* it is dead
 * as its accessible description: the same sentence the trigger and the
 * popover body carry, so an AT user who lands on (or reads past) the inert
 * button is told why instead of finding a dead control with no explanation.
 */
suite('KAR-26.3 — the disabled Run button says why, as its accessible description', () => {
  it.each([
    {
      name: 'machine unknown',
      providers: [] as PickerRow[],
      routes: { known: false },
      needle: 'has not been told which machine',
    },
    {
      name: 'no report',
      providers: [] as PickerRow[],
      routes: { fail: true },
      needle: 'No route report',
    },
    { name: 'zero usable', providers: [ABSENT], routes: {}, needle: 'No adapter on this machine' },
  ])('describes Run in the "$name" state', async ({ providers, routes, needle }) => {
    await mountNewRun(providers, routes);

    const submit = one('[data-composer-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const noteId = submit.getAttribute('aria-describedby');
    expect(noteId).toBeTruthy();
    expect(document.getElementById(noteId as string)?.textContent).toContain(needle);
  });

  it('drops the description once Run is live', async () => {
    await mountNewRun();

    const submit = one('[data-composer-submit]') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(submit.getAttribute('aria-describedby')).toBeNull();
  });
});

/**
 * KAR-26.3 AC3 — a failed `GET /providers/routes` is retryable from inside
 * the control. The daemon demonstrably answered (a 500 is an answer), so the
 * state is not permanent — without this the composer was inert until a full
 * page reload, with nothing in the popover to click.
 */
suite('KAR-26.3 — a failed route report offers a retry inside the control', () => {
  it('reloads the report on retry: rows arrive and Run comes alive', async () => {
    await mountNewRun([usable({ id: 'alpha' })], { failFirst: true });

    expect((one('[data-composer-submit]') as HTMLButtonElement).disabled).toBe(true);
    await openAdapters();
    expect(one('[data-composer-providers]')?.textContent).toContain('No route report');

    await userEvent.click(one('[data-composer-adapters-retry]') as HTMLElement);

    await expect.poll(() => one('[data-provider-row="alpha"]')).not.toBeNull();
    await expect
      .poll(() => (one('[data-composer-submit]') as HTMLButtonElement).disabled)
      .toBe(false);
    expect(one('[data-composer-provider-trigger]')?.textContent).toContain('alpha');
  });

  it('offers no retry when the report actually arrived', async () => {
    await mountNewRun([usable({ id: 'alpha' })]);
    await openAdapters();

    expect(one('[data-composer-adapters-retry]')).toBeNull();
  });
});

/**
 * KAR-26.3 AC4/AC5 — the unavailable row's text holds WCAG AA in both themes,
 * measured on the live cascade the way `ui/mixed-surface-contrast.test.ts`
 * measures the chip blends: computed colour and painted background resolved
 * to sRGB bytes through a canvas, ancestor `opacity` folded in by hand
 * (`getComputedStyle().color` does not include it — which is exactly how the
 * first cut's `opacity: 0.6` composite slid under the token-level suite at
 * 2.71:1).
 */
suite('KAR-26.3 AC4/AC5 — the unavailable row reads at AA contrast in both themes', () => {
  const AA_NORMAL_TEXT = 4.5;

  function rgbBytes(cssColor: string, base: string): [number, number, number] {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('no 2d canvas context in this browser');
    context.fillStyle = base;
    context.fillRect(0, 0, 1, 1);
    context.fillStyle = cssColor;
    context.fillRect(0, 0, 1, 1);
    const data = context.getImageData(0, 0, 1, 1).data;
    return [data[0] as number, data[1] as number, data[2] as number];
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    const channel = (byte: number): number => {
      const c = byte / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
    const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
    const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
    return (lighter + 0.05) / (darker + 0.05);
  }

  /** The product of every `opacity` from `element` up to (and including) the
   *  popover panel — the factor the compositor multiplies the text by. */
  function effectiveOpacity(element: HTMLElement): number {
    let opacity = 1;
    for (
      let node: HTMLElement | null = element;
      node !== null && !node.matches('[data-composer-adapters-panel]');
      node = node.parentElement
    ) {
      opacity *= Number.parseFloat(getComputedStyle(node).opacity);
    }
    return opacity;
  }

  const blend = (
    over: [number, number, number],
    under: [number, number, number],
    alpha: number,
  ): [number, number, number] =>
    [0, 1, 2].map((i) =>
      Math.round((over[i] as number) * alpha + (under[i] as number) * (1 - alpha)),
    ) as [number, number, number];

  it('every text line of the disabled row clears 4.5:1, light and dark', async () => {
    await mountNewRun([usable({ id: 'alpha' }), ABSENT]);
    await openAdapters();

    const panel = one('[data-composer-providers]') as HTMLElement;
    const row = one('[data-provider-row="gamma"]') as HTMLElement;
    const parts = [
      '.composer__provider-id',
      '.composer__provider-route',
      '.composer__provider-reason',
      '.composer__provider-action',
    ];

    try {
      for (const theme of ['light', 'dark'] as const) {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        // UiButton (and anything else with a colour transition) settles well
        // inside this; the rows themselves carry none, but measuring mid-fade
        // elsewhere produced bogus ratios once already.
        await new Promise((resolve) => setTimeout(resolve, 250));

        const background = rgbBytes(getComputedStyle(panel).backgroundColor, '#ffffff');
        for (const selector of parts) {
          const element = row.querySelector<HTMLElement>(selector);
          if (element === null) throw new Error(`the disabled row lost ${selector}`);
          const painted = blend(
            rgbBytes(getComputedStyle(element).color, getComputedStyle(panel).backgroundColor),
            background,
            effectiveOpacity(element),
          );
          const ratio = contrastRatio(painted, background);
          expect(
            ratio >= AA_NORMAL_TEXT,
            `${selector} on the unavailable row is ${ratio.toFixed(2)}:1 in ${theme} (needs ${AA_NORMAL_TEXT})`,
          ).toBe(true);
        }
      }
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });
});
