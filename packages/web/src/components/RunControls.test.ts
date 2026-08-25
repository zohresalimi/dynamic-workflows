/**
 * KAR-27.7 — the buttons that pause, resume and stop a run, and what each one
 * puts on the wire.
 *
 * Verifies: EPIC-27-S34, EPIC-27-S35, EPIC-27-S36, EPIC-27-S37 · AC1–AC5
 *
 * The client here is the **real** typed one (`../api/client.ts`) over an
 * injected `fetch`, for the reason `../views/run-gate-answer.test.ts` gives:
 * what AC1 claims is that the browser reaches *the endpoints that already
 * exist*, and a hand-written fake with a `pause()` method on it cannot say
 * anything about a URL. Every assertion below is against the request that
 * actually left.
 *
 * The one thing this file deliberately does not test is the state on screen
 * changing: this component is told its status by its caller and holds no fold
 * of its own, so "the run's state follows the ledger" is asserted where the
 * ledger is — `../views/run-controls.test.ts`.
 */
import type { RunStatus } from '@DeFlow/core';
import { beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-vue';
import type { ApiClient } from '../api/client.ts';
import { createClient } from '../api/client.ts';
import { API_CLIENT } from '../api/provide.ts';
import { RUN_CONTROL_STOP_MODE, STOP_CONFIRMATION } from '../lib/run-controls.ts';
import '../styles/theme.css';
import RunControls from './RunControls.vue';

const RUN = 'run_20260825T090000Z_b17e55';
const ORIGIN = 'http://daemon.test';

interface SentRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

const sent: SentRequest[] = [];
let refuseWith: { readonly status: number; readonly body: unknown } | null = null;
/**
 * How long the daemon takes to answer.
 *
 * Zero for every case except the in-flight one, which is the only claim here
 * that is *about* a request still being open: with an instant answer the
 * component is idle again before anything can be asserted, and one with no hold
 * at all would pass.
 */
let answerAfterMs = 0;

async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : String((input as Request).url ?? input));
  const raw = init?.body;
  sent.push({
    method: (init?.method ?? 'GET').toUpperCase(),
    pathname: url.pathname,
    body: typeof raw === 'string' && raw !== '' ? (JSON.parse(raw) as unknown) : null,
  });

  if (answerAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
  const refusal = refuseWith;
  const [body, status] =
    refusal === null
      ? [{ runId: RUN, seq: 41, appended: true }, 200]
      : [refusal.body, refusal.status];
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const client = (): ApiClient => createClient({ baseUrl: `${ORIGIN}/api`, fetch: serve });

function mount(status: RunStatus | null) {
  return render(RunControls, {
    props: { runId: RUN, status },
    global: { provide: { [API_CLIENT as symbol]: client() } },
  });
}

const button = (root: ParentNode, action: string): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`[data-run-control="${action}"]`);

/** The confirmation lives in a portal, so it is looked for in the document. */
const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[data-run-control-confirm]');

/**
 * Its two answers, which the modal renders in a footer outside that body.
 *
 * Pressed with a plain `.click()` rather than `userEvent.click`, which is the
 * pattern `../views/projects.test.ts` already uses for the buttons inside
 * `UiModal`: Reka's dismissable layer sets `pointer-events: none` on the body
 * while a modal is open, and a synthesised pointer sequence against a portalled
 * footer button lands nowhere. The *trigger* is still a real click, because
 * that is what moves focus and opens the dialog the way an operator does.
 */
const pressDialog = (which: 'accept' | 'cancel'): void => {
  const control = document.body.querySelector<HTMLElement>(`[data-run-control-confirm-${which}]`);
  if (control === null) throw new Error(`the confirmation has no ${which} action`);
  control.click();
};

const posts = (): SentRequest[] => sent.filter((request) => request.method === 'POST');

beforeEach(() => {
  sent.length = 0;
  refuseWith = null;
  answerAfterMs = 0;
});

suite('EPIC-27-S34 — the controls are offered in the states they apply to (AC1)', () => {
  it('shows pause and stop on a running run', () => {
    const screen = mount('running');

    expect(button(screen.container, 'pause')).not.toBeNull();
    expect(button(screen.container, 'stop')).not.toBeNull();
    expect(button(screen.container, 'resume')).toBeNull();
  });

  it('shows resume and stop on a paused run', () => {
    const screen = mount('paused');

    expect(button(screen.container, 'resume')).not.toBeNull();
    expect(button(screen.container, 'stop')).not.toBeNull();
    expect(button(screen.container, 'pause')).toBeNull();
  });

  it('shows neither pause nor stop on a concluded run', () => {
    const screen = mount('completed');

    expect(button(screen.container, 'pause')).toBeNull();
    expect(button(screen.container, 'resume')).toBeNull();
    expect(button(screen.container, 'stop')).toBeNull();
  });
});

suite('EPIC-27-S35 — each control calls the endpoint that exists (AC1, AC2)', () => {
  it('pauses through POST /api/runs/:id/pause, once', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    expect(posts()[0]?.pathname).toBe(`/api/runs/${RUN}/pause`);
  });

  it('resumes through POST /api/runs/:id/resume, once', async () => {
    const screen = mount('paused');

    await userEvent.click(button(screen.container, 'resume') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    expect(posts()[0]?.pathname).toBe(`/api/runs/${RUN}/resume`);
  });

  it('stops through POST /api/runs/:id/cancel, stating the forceful ladder', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'stop') as HTMLElement);
    await expect.poll(() => dialog(), { timeout: 5_000 }).not.toBeNull();
    pressDialog('accept');
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    expect(posts()[0]?.pathname).toBe(`/api/runs/${RUN}/cancel`);
    // Explicit, never the endpoint's default — the whole point of the button.
    expect(posts()[0]?.body).toMatchObject({ mode: RUN_CONTROL_STOP_MODE });
  });

  it('holds every control while a request is in flight, so one press is one request', async () => {
    answerAfterMs = 300;
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    // Mid-flight: neither control can start a second request.
    expect(button(screen.container, 'pause')?.disabled).toBe(true);
    expect(button(screen.container, 'stop')?.disabled).toBe(true);

    // And the hold is released when the daemon answers, not left latched.
    await expect
      .poll(() => button(screen.container, 'pause')?.disabled, { timeout: 5_000 })
      .toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it('claims nothing about the run’s state on its own: the button does not flip', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    // The daemon accepted, and the surface still offers pause: what turns this
    // into a resume is the `run.paused` frame, not a 200 (AC2).
    expect(button(screen.container, 'pause')).not.toBeNull();
    expect(button(screen.container, 'resume')).toBeNull();
  });
});

suite('EPIC-27-S36 — a refusal is shown, not swallowed (AC2)', () => {
  it('renders the daemon’s own sentence when it refuses', async () => {
    refuseWith = {
      status: 409,
      body: {
        error: {
          code: 'run_not_pausable',
          message: 'this run is completed, so it cannot be paused: nothing was appended',
        },
      },
    };
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement);

    const shown = await expect
      .poll(() => screen.container.querySelector('[data-run-control-error]')?.textContent ?? '', {
        timeout: 5_000,
      })
      .toContain('this run is completed, so it cannot be paused');
    void shown;
  });

  it('says something rather than nothing when the refusal carries no message', async () => {
    refuseWith = { status: 500, body: { nope: true } };
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement);

    await expect
      .poll(() => screen.container.querySelector('[data-run-control-error]')?.textContent ?? '', {
        timeout: 5_000,
      })
      .toContain('500');
  });
});

suite('AC3 — a disabled control says why, on screen', () => {
  it('disables pause on a run whose spec is not approved, with the reason beside it', () => {
    const screen = mount('created');
    const pause = button(screen.container, 'pause');

    expect(pause?.disabled).toBe(true);
    const reason = screen.container.querySelector('[data-run-control-reason="pause"]');
    expect(reason?.textContent ?? '').toContain('spec/approve');
    expect((reason as HTMLElement).getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it('sends nothing when a disabled control is pressed', async () => {
    const screen = mount('created');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(posts()).toEqual([]);
  });
});

suite('EPIC-27-S37 — stop asks first, pause does not (AC4)', () => {
  it('sends nothing until the confirmation is accepted', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'stop') as HTMLElement);
    await expect.poll(() => dialog(), { timeout: 5_000 }).not.toBeNull();

    expect(posts()).toEqual([]);
    expect(dialog()?.textContent ?? '').toContain('truncated');
  });

  it('sends nothing at all when the confirmation is declined', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'stop') as HTMLElement);
    await expect.poll(() => dialog(), { timeout: 5_000 }).not.toBeNull();
    pressDialog('cancel');
    await expect.poll(() => dialog(), { timeout: 5_000 }).toBeNull();

    expect(posts()).toEqual([]);
  });

  it('names the cost in the dialog, in the one place that sentence is written', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'stop') as HTMLElement);
    await expect.poll(() => dialog(), { timeout: 5_000 }).not.toBeNull();

    const text = dialog()?.textContent ?? '';
    expect(text).toContain(STOP_CONFIRMATION.warning);
    expect(text).toContain(STOP_CONFIRMATION.irreversible);
  });

  it('pauses with no confirmation at all, because pause is reversible', async () => {
    const screen = mount('running');

    await userEvent.click(button(screen.container, 'pause') as HTMLElement);
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    expect(dialog()).toBeNull();
  });
});

suite('AC5 — reachable by keyboard, named for assistive technology', () => {
  it('renders real buttons, each with an accessible name that says what it acts on', async () => {
    const screen = mount('running');

    for (const action of ['pause', 'stop']) {
      const control = button(screen.container, action);
      expect(control?.tagName).toBe('BUTTON');
      const name = control?.getAttribute('aria-label') ?? control?.textContent ?? '';
      expect(name.toLowerCase()).toContain('run');
    }

    await expect.element(screen.getByRole('button', { name: 'Pause this run' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Stop this run' })).toBeVisible();
  });

  it('groups the controls under a name, so they are not two loose buttons', () => {
    const screen = mount('running');
    const group = screen.container.querySelector('[data-run-controls]');

    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('aria-label')?.trim()).not.toBe('');
  });

  it('pauses from the keyboard alone', async () => {
    const screen = mount('running');
    (button(screen.container, 'pause') as HTMLElement).focus();

    expect(document.activeElement).toBe(button(screen.container, 'pause'));
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => posts().length, { timeout: 5_000 }).toBe(1);

    expect(posts()[0]?.pathname).toBe(`/api/runs/${RUN}/pause`);
  });
});
