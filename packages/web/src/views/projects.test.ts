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

const field = (name: string): HTMLInputElement => {
  const input = shell.container.querySelector<HTMLInputElement>(`[data-project-${name}]`);
  if (input === null) throw new Error(`the projects form has no ${name} field`);
  return input;
};

const submitForm = (): void => {
  const form = shell.container.querySelector<HTMLFormElement>('[data-project-form]');
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

suite('EPIC-22-S17 — creating a project from the form', () => {
  it('makes exactly one request with the two fields and shows the new row', async () => {
    const client = projectsClient({});
    shell = await mountShell({ at: '/projects', client });
    await settle();

    type(field('name'), 'checkout');
    type(field('path'), '/repos/checkout');
    submitForm();
    await settle();

    expect(client.recorded.posts).toEqual([{ name: 'checkout', path: '/repos/checkout' }]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('/repos/checkout');
  });
});

suite('EPIC-22-S17 — the refusal is rendered, not swallowed', () => {
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

    type(field('name'), 'nope');
    type(field('path'), '/tmp/not-a-repo');
    submitForm();
    await settle();

    const error = shell.container.querySelector('[data-project-error]');
    expect(error?.textContent?.trim()).toBe(message);
    expect(field('path').value).toBe('/tmp/not-a-repo');
    expect(rows()).toHaveLength(0);
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
