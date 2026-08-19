/**
 * KAR-22.1 — the projects page, in a real Chromium.
 *
 * The API half of this story is asserted against a real daemon in
 * `packages/daemon/test/integration/projects-api.test.ts`. What only a browser
 * can answer is the half the operator actually touches: does the form make one
 * request with the two fields, is the refusal *rendered* rather than swallowed,
 * is an unhealthy project visible rather than filtered away, and does the
 * destructive action say what it does before it does it.
 *
 * The client is injected rather than `fetch` monkey-patched, because what these
 * specs assert is **which request the view made**, and the typed client is the
 * thing that decides that.
 *
 * Verifies: EPIC-22-S17 · KAR-22.1 AC1, AC4, AC5, AC6 · test plan #16, #17
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: { readonly state: string; readonly message: string | null };
  readonly lastRun: { readonly runId: string; readonly label: string } | null;
}

interface Recorded {
  readonly posts: { name: string; path: string }[];
  readonly deletes: string[];
}

const healthy = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: PROJECT_ID,
  name: 'checkout',
  path: '/repos/checkout',
  createdAt: '2026-08-15T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
  ...over,
});

/**
 * A client answering the four projects routes, recording what it was asked.
 *
 * `postAnswers` is a queue: the first submission gets the first answer, so a
 * spec can make one create fail and the next succeed without a second client.
 */
function projectsClient(options: {
  readonly projects?: readonly ProjectRow[];
  readonly postAnswers?: readonly { status: number; body: unknown }[];
}): ApiClient & { readonly recorded: Recorded } {
  const recorded: Recorded = { posts: [], deletes: [] };
  let listed = [...(options.projects ?? [])];
  const answers = [...(options.postAnswers ?? [])];

  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  const client = {
    projects: Object.assign(
      {
        $get: () => json(200, { projects: listed }),
        $post: (args: { json: { name: string; path: string } }) => {
          recorded.posts.push({ ...args.json });
          const answer = answers.shift() ?? {
            status: 201,
            body: {
              project: healthy({ name: args.json.name, path: args.json.path }),
              init: { ran: true, paths: [] },
            },
          };
          if (answer.status < 400) {
            listed = [...listed, (answer.body as { project: ProjectRow }).project];
          }
          return json(answer.status, answer.body);
        },
      },
      {
        ':id': {
          $delete: (args: { param: { id: string } }) => {
            recorded.deletes.push(args.param.id);
            listed = listed.filter((project) => project.id !== args.param.id);
            return json(200, {
              id: args.param.id,
              removed: true,
              filesDeleted: false,
              message: 'no files were deleted',
            });
          },
          $patch: () => json(200, { project: healthy() }),
        },
      },
    ),
    runs: { $get: () => json(200, { runs: [], cursor: null, more: false }) },
    approvals: { $get: () => json(200, { items: [] }) },
  };

  return Object.defineProperty(client, 'recorded', { get: () => recorded }) as never;
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

/** Types `value` into `input` the way a person does, so Vue's v-model updates. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/*
 * KAR-25.6 — the form lives inside `UiModal`'s `DialogPortal`, which
 * teleports to `document.body` rather than into `shell.container` (the
 * portal target `UiModal.vue` never overrides). Every query that reaches
 * *into* the form goes through `document`, the way `app/frame.test.ts`
 * already does for the one other Reka dialog in this package; queries for
 * the projects grid itself are untouched, because the grid is not teleported.
 */
const field = (name: string): HTMLInputElement => {
  const input = document.querySelector<HTMLInputElement>(`[data-project-${name}]`);
  if (input === null) throw new Error(`the projects form has no ${name} field`);
  return input;
};

const submitForm = (): void => {
  const form = document.querySelector<HTMLFormElement>('[data-project-form]');
  if (form === null) throw new Error('the projects route rendered no create form');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

const rows = (): HTMLElement[] => [
  ...shell.container.querySelectorAll<HTMLElement>('[data-project-row]'),
];

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await shell.router.isReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The header's "New project" trigger — every dismissal scenario opens from here. */
function headerTrigger(): HTMLElement {
  const button = shell.container.querySelector<HTMLElement>('[data-project-new-header]');
  if (button === null) throw new Error('no header "New project" trigger in the rendered page');
  return button;
}

/**
 * Opens the modal from `trigger` and waits for the form to be reachable.
 *
 * `userEvent.click`, not a raw `.click()`: Reka's `DialogContentImpl` records
 * "the trigger" as whatever element is focused at the moment the dialog
 * mounts, and only a real (or `userEvent`-synthesised) click actually moves
 * focus to a button the way AC4's focus-return depends on — a programmatic
 * `.click()` fires the click event without it.
 */
async function openModal(trigger: HTMLElement): Promise<void> {
  await userEvent.click(trigger);
  await expect.poll(() => document.querySelector('[data-project-form]')).not.toBeNull();
}

suite('EPIC-22-S17 — creating a project from the form', () => {
  // KAR-25.6, EPIC-25-S38 — setup changed, claim did not: the form now lives
  // in a modal, so it has to be opened before it can be filled in. What was
  // asserted about the request and the resulting row is untouched.
  it('makes exactly one request with the two fields and shows the new row', async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();
    await openModal(headerTrigger());

    type(field('name'), 'checkout');
    type(field('path'), '/repos/checkout');
    submitForm();
    await settle();

    expect(client.recorded.posts).toEqual([{ name: 'checkout', path: '/repos/checkout' }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('/repos/checkout');
    // AC3, EPIC-25-S38 — new assertion, not a change to an existing one: on
    // success the modal closes, so the form it held is gone from the document.
    expect(document.querySelector('[data-project-form]')).toBeNull();
  });
});

suite('EPIC-22-S17 — the refusal is rendered, not swallowed', () => {
  // KAR-25.6, EPIC-25-S40 — setup changed, claim did not: opening the modal is
  // new; the message, the preserved path and the empty grid are the same
  // assertions this suite made before the form moved.
  it('shows the message verbatim and keeps the typed path', async () => {
    const message = "deflow init: not inside a git working tree (run 'git init' first)";
    const client = projectsClient({
      postAnswers: [
        {
          status: 400,
          body: { error: { code: 'invalid_request', message, detail: { field: 'path' } } },
        },
      ],
    });
    shell = await mountShell({ at: '/projects', client });
    await settle();
    await openModal(headerTrigger());

    type(field('name'), 'nope');
    type(field('path'), '/tmp/not-a-repo');
    submitForm();
    await settle();

    const error = document.querySelector('[data-project-error]');
    expect(error?.textContent?.trim()).toBe(message);
    expect(field('path').value).toBe('/tmp/not-a-repo');
    expect(rows()).toHaveLength(0);
    // EPIC-25-S40 — new assertion: a refusal leaves the modal open, unlike a
    // success. The form's earlier claims (message, preserved path) are above,
    // unchanged; this is the one fact only the modal wrapper adds.
    expect(document.querySelector('[data-project-form]')).not.toBeNull();
  });
});

suite('EPIC-22-S17 — removing states what is and is not deleted', () => {
  it('names the path, says no files are deleted, and dismissing issues nothing', async () => {
    const client = projectsClient({ projects: [healthy()] });
    shell = await mountShell({ at: '/projects', client });
    await settle();

    shell.container.querySelector<HTMLElement>('[data-project-remove]')?.click();
    await settle();

    const confirmation = shell.container.querySelector('[data-project-remove-confirm]');
    expect(confirmation).not.toBeNull();
    expect(confirmation?.textContent).toContain('/repos/checkout');
    expect(confirmation?.textContent).toMatch(/no files/i);

    shell.container.querySelector<HTMLElement>('[data-project-remove-cancel]')?.click();
    await settle();
    expect(client.recorded.deletes).toEqual([]);
    expect(rows()).toHaveLength(1);

    shell.container.querySelector<HTMLElement>('[data-project-remove]')?.click();
    await settle();
    shell.container.querySelector<HTMLElement>('[data-project-remove-accept]')?.click();
    await settle();
    expect(client.recorded.deletes).toEqual([PROJECT_ID]);
    expect(rows()).toHaveLength(0);
  });
});

suite('EPIC-22-S17 — an unhealthy project is visible, not hidden', () => {
  it('renders the row and its health message', async () => {
    const client = projectsClient({
      projects: [
        healthy(),
        healthy({
          id: 'prj_20260815T101113Z_b2c3d4',
          name: 'gone',
          path: '/repos/gone',
          health: { state: 'missing', message: '/repos/gone is no longer there' },
        }),
      ],
    });
    shell = await mountShell({ at: '/projects', client });
    await settle();

    expect(rows()).toHaveLength(2);
    const unhealthy = rows().find((row) => row.textContent?.includes('gone'));
    expect(unhealthy?.textContent).toContain('/repos/gone is no longer there');
    expect(unhealthy?.dataset.projectHealth).toBe('missing');
  });
});

/**
 * KAR-25.6 — the form moved into `UiModal`. `UiModal`'s own chrome (focus
 * trap, `aria-modal`, `Esc`, outside-click, focus return) is
 * `ui/a11y.test.ts`'s contract and is not re-proven here; what belongs to
 * this view is that the form exists only while the modal is open, that all
 * three triggers reach the same modal, and that each dismissal this view
 * wires up actually closes it.
 *
 * Verifies: EPIC-25-S38, EPIC-25-S39, EPIC-25-S41
 */
suite('EPIC-25-S38 — the form exists only while the modal is open', () => {
  it('is absent on load, and appears with the name field focused once opened', async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();

    // AC1 — nothing to reach in the document before the modal opens.
    expect(document.querySelector('[data-project-form]')).toBeNull();

    await openModal(headerTrigger());

    expect(document.querySelector('[data-project-form]')).not.toBeNull();
    await expect.poll(() => document.activeElement).toBe(field('name'));
  });
});

suite('EPIC-25-S39 — all three triggers open one modal', () => {
  it('opens from the dashed grid tile when the grid has projects', async () => {
    const client = projectsClient({ projects: [healthy()] });
    shell = await mountShell({ at: '/projects', client });
    await settle();

    const tile = shell.container.querySelector<HTMLElement>('[data-project-new-tile-action]');
    if (tile === null) throw new Error('no dashed-tile "Add project" trigger');
    await openModal(tile);

    expect(document.querySelectorAll('[data-project-form]')).toHaveLength(1);
  });

  it("opens from the empty state's action when the grid has no projects", async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();

    const action = shell.container.querySelector<HTMLElement>('[data-project-new-empty-action]');
    if (action === null) throw new Error('no empty-state "New project" trigger');
    await openModal(action);

    expect(document.querySelectorAll('[data-project-form]')).toHaveLength(1);
  });

  /*
   * AC4 says focus returns to *the trigger*, and there are three of them. The
   * dismissal suite below proves it for the header button only, which is a
   * weaker claim than the AC makes: `UiModal` returns focus to whatever was
   * focused when the dialog mounted, so the property is a fact about the
   * opener rather than about the modal, and it is the opener that differs
   * three ways here. Cheap to assert for all three; the alternative is
   * trusting that no future edit gives one trigger its own handler.
   */
  it.each([
    ['the dashed grid tile', '[data-project-new-tile-action]', [healthy()]],
    ["the empty state's action", '[data-project-new-empty-action]', []],
  ] as const)('returns focus to %s after Escape', async (_name, selector, projects) => {
    const client = projectsClient(projects.length > 0 ? { projects: [...projects] } : {});
    shell = await mountShell({ at: '/projects', client });
    await settle();

    const trigger = shell.container.querySelector<HTMLElement>(selector);
    if (trigger === null) throw new Error(`no trigger for ${selector}`);
    await openModal(trigger);

    await userEvent.keyboard('{Escape}');

    await expect.poll(() => document.querySelector('[data-project-form]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(trigger);
  });
});

suite('EPIC-25-S41 — Escape, outside-click and Cancel all close the modal and return focus', () => {
  it('closes on Escape', async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();
    const trigger = headerTrigger();
    await openModal(trigger);

    await userEvent.keyboard('{Escape}');

    await expect.poll(() => document.querySelector('[data-project-form]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(trigger);
  });

  it('closes on an outside click', async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();
    const trigger = headerTrigger();
    await openModal(trigger);

    // The overlay covers the viewport and grid-centres the panel inside it;
    // a click near a corner lands on the backdrop rather than the panel —
    // `ui/a11y.test.ts` uses the same position for the same reason.
    const overlay = document.querySelector<HTMLElement>('.ui-modal__overlay');
    if (overlay === null) throw new Error('no modal overlay to click outside on');
    await userEvent.click(overlay, { position: { x: 4, y: 4 } });

    await expect.poll(() => document.querySelector('[data-project-form]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(trigger);
  });

  it('closes on Cancel', async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();
    const trigger = headerTrigger();
    await openModal(trigger);

    const cancel = document.querySelector<HTMLElement>('[data-project-create-cancel]');
    if (cancel === null) throw new Error('no Cancel action in the modal');
    cancel.click();

    await expect.poll(() => document.querySelector('[data-project-form]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(trigger);
  });
});
