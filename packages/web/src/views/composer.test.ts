/**
 * KAR-22.2 — the composer, in a real Chromium, mounted in the real shell.
 *
 * The daemon half of this story is asserted against a real booted daemon in
 * `packages/daemon/test/integration/composer-intake.test.ts` and
 * `packages/cli/test/integration/composer-picker.test.ts`. What only a browser
 * can answer is the half an operator touches: which request the form made, that
 * the refusal is *rendered* rather than swallowed, that an unavailable adapter
 * cannot be submitted, that submitting takes them to the run and that the run
 * then streams — and that all of it is reachable without a mouse.
 *
 * The client is injected rather than `fetch` monkey-patched, for the reason
 * `./projects.test.ts` states: what most of these specs assert is *which request
 * the view made*, and the typed client is the thing that decides that.
 *
 * Verifies: EPIC-22-S18, EPIC-22-S19, EPIC-22-S22, EPIC-22-S23, EPIC-22-S24,
 * EPIC-22-S25, EPIC-22-S26, EPIC-22-S27, EPIC-22-S28, EPIC-22-S29,
 * EPIC-22-S30, EPIC-22-S32 · AC1–AC7 · test plan #1, #5, #6, #8, #9, #10
 */
import type { Event } from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';

const PROJECT_ID = 'prj_20260815T101112Z_a1b2c3';
const PROJECT_PATH = '/repos/checkout';
const RUN_ID = 'run_20260815T120000Z_aaaaaa';

interface PickerRow {
  readonly id: string;
  readonly available: boolean;
  readonly route: 'acp' | 'shim' | null;
  readonly routes: { readonly acp: string; readonly shim: string };
  readonly reason: string;
  readonly action: string | null;
  readonly limitation: string | null;
}

interface PostedRun {
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
}

interface Recorded {
  readonly posts: PostedRun[];
  /** Every `q` the issue picker asked the connector for (KAR-22.4 AC3). */
  readonly searches: string[];
}

interface IssueRow {
  readonly key: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

/** What a connected GitHub answers with, in the one issue vocabulary. */
const ISSUES: readonly IssueRow[] = [
  {
    key: 'acme/checkout#41',
    title: 'Retry the flaky worktree reaper',
    state: 'open',
    url: 'https://github.com/acme/checkout/issues/41',
  },
  {
    key: 'acme/checkout#7',
    title: 'Document the data directory',
    state: 'closed',
    url: 'https://github.com/acme/checkout/issues/7',
  },
];

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
  reason:
    'gamma is not installed here: no executable "gamma" was found on PATH — install it with ' +
    '"npm install -g @example/gamma".',
  action: 'npm install -g @example/gamma',
  limitation: null,
};

interface ClientOptions {
  readonly providers?: readonly PickerRow[];
  /** The answers `POST /api/runs` gives, in order. Defaults to one 201. */
  readonly postAnswers?: readonly ({ status: number; body: unknown } | 'network-error')[];
  /** Never resolve the first POST, so a second submit can race it. */
  readonly hangFirstPost?: boolean;
  /** KAR-22.4 — whether this project has a connected connector. */
  readonly connected?: boolean;
  readonly issues?: readonly IssueRow[];
}

/**
 * A client answering the four routes the composer touches, recording the runs
 * it was asked to create.
 */
function composerClient(options: ClientOptions = {}): ApiClient & { readonly recorded: Recorded } {
  const recorded: Recorded = { posts: [], searches: [] };
  const answers = [...(options.postAnswers ?? [])];
  let hung = options.hangFirstPost === true;

  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  const client = {
    providers: {
      routes: { $get: () => json(200, { providers: options.providers ?? [usable()] }) },
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
        // KAR-22.4 — the two routes the issue picker reads. A project with no
        // connector answers the first with `connected: false`, and the composer
        // then offers nothing but the paste box, which is AC6 in one object.
        ':id': {
          connectors: Object.assign(
            {
              $get: () =>
                json(200, {
                  services: [
                    {
                      id: 'github',
                      label: 'GitHub',
                      connected: options.connected === true,
                      connectedAt: null,
                      state: {
                        state: 'connected',
                        account: 'octocat',
                        scopes: ['repo'],
                        missingScopes: [],
                        message: 'Connected as octocat.',
                        action: null,
                      },
                      credential: {
                        authorisedBy: '',
                        holder: '',
                        livesIn: '',
                        deflowStores: '',
                        revoke: { command: '', affects: '' },
                      },
                      authorisation: { command: '', url: '', whyNotOneClick: '' },
                    },
                  ],
                }),
            },
            {
              ':service': {
                issues: {
                  $get: (args: { query?: { q?: string } }) => {
                    recorded.searches.push(args.query?.q ?? '');
                    return json(200, { issues: options.issues ?? ISSUES });
                  },
                },
              },
            },
          ),
        },
      },
    ),
    runs: Object.assign(
      {
        $get: () => json(200, { runs: [], cursor: null, more: false }),
        $post: (
          args: { json: unknown },
          init?: { headers?: Record<string, string> },
        ): Promise<unknown> => {
          recorded.posts.push({
            body: args.json,
            idempotencyKey: init?.headers?.['Idempotency-Key'],
          });
          if (hung) {
            hung = false;
            return new Promise(() => {});
          }
          const answer = answers.shift() ?? {
            status: 201,
            body: { runId: RUN_ID, seq: 1, status: 'awaiting-spec-approval' },
          };
          if (answer === 'network-error') {
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          return json(answer.status, answer.body);
        },
      },
      { ':id': { $get: () => json(200, {}) } },
    ),
    approvals: { $get: () => json(200, { items: [] }) },
  };

  return Object.defineProperty(client, 'recorded', { get: () => recorded }) as never;
}

/** A feed that records which run it was opened for and hands back its sink. */
function recordingFeed(): { factory: RunFeedFactory; opened: string[]; push: (e: Event) => void } {
  const opened: string[] = [];
  let sink: RunFeedOptions['sink'] | null = null;

  const factory: RunFeedFactory = (feedOptions: RunFeedOptions): RunFeed => {
    opened.push(feedOptions.runId);
    sink = feedOptions.sink;
    return { runId: feedOptions.runId, ready: Promise.resolve(), close: () => {} };
  };

  return {
    factory,
    opened,
    push: (event: Event) => {
      sink?.applyEvent(event);
    },
  };
}

/** A `task.submitted` frame, as the stream delivers it. */
const submittedFrame = (text: string): Event =>
  ({
    seq: 1,
    runId: RUN_ID,
    ts: 1_755_000_000_000,
    kind: 'task.submitted',
    v: 1,
    epoch: 1,
    payload: {
      sha256: 'a'.repeat(64),
      raw: text,
      provenance: {
        kind: 'text',
        by: 'ui',
        submittedAt: 1_755_000_000_000,
        cwd: PROJECT_PATH,
        projectId: PROJECT_ID,
      },
    },
  }) as unknown as Event;

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
  setActivePinia(undefined as never);
});

const one = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Opens the composer the way the keyboard map does, from wherever we are. */
async function openComposer(): Promise<void> {
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
  await settle();
  await expect.poll(() => one('[data-composer]')).not.toBeNull();
}

const prompt = (): HTMLTextAreaElement => {
  const box = one('[data-composer-text]');
  if (box === null) throw new Error('the composer rendered no prompt box');
  return box as HTMLTextAreaElement;
};

/** Types into `element` the way a person does, so Vue's v-model updates. */
function type(element: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

const submitChord = (): void => {
  prompt().dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
  );
};

const providerRow = (id: string): HTMLElement => {
  const row = one(`[data-provider-row="${id}"]`);
  if (row === null) throw new Error(`the picker has no row for ${id}`);
  return row;
};

async function mount(options: {
  readonly client: ApiClient;
  readonly at?: string;
  readonly feed?: RunFeedFactory;
}): Promise<void> {
  shell = await mountShell({
    at: options.at ?? '/projects',
    client: options.client,
    ...(options.feed === undefined ? {} : { feed: options.feed }),
  });
  setActivePinia(shell.pinia);
  await settle();
}

suite('EPIC-22-S18 — a prompt typed in the browser becomes a running run', () => {
  it('makes exactly one POST, routes to the run, and renders its first frame', async () => {
    const client = composerClient();
    const feed = recordingFeed();
    await mount({ client, feed: feed.factory });

    (window as unknown as Record<string, unknown>).__composerSentinel = 'alive';

    await openComposer();
    type(prompt(), 'Migrate the checkout module');
    submitChord();
    await settle();

    expect(client.recorded.posts).toHaveLength(1);
    // AC4 — no manual navigation to /runs/<id>: the router is already there.
    await expect.poll(() => shell.router.currentRoute.value.path).toBe(`/runs/${RUN_ID}`);
    expect(feed.opened).toEqual([RUN_ID]);

    // The first frame off that subscription renders. Until this line the story
    // is "a POST was made"; this is the line that says the operator can see it.
    feed.push(submittedFrame('Migrate the checkout module'));
    await settle();
    await expect
      .poll(() => one('[data-run-task]')?.textContent)
      .toContain('Migrate the checkout module');

    // And none of it was a page load.
    expect((window as unknown as Record<string, unknown>).__composerSentinel).toBe('alive');
  });
});

suite('EPIC-22-S19 — the composer builds the API’s own body, not one of its own', () => {
  it('sends exactly the fields RunIntakeBodySchema declares', async () => {
    const client = composerClient();
    await mount({ client });
    await openComposer();
    type(prompt(), 'Migrate the checkout module');
    submitChord();
    await settle();

    // `toEqual` and not `toMatchObject`: `RunIntakeBodySchema` is a
    // `strictObject`, so a field it does not declare is a 400 rather than a
    // field the daemon ignores. The identical literal is posted to a real
    // daemon in `packages/daemon/test/integration/composer-intake.test.ts`,
    // which is what ties this expectation to the schema itself.
    expect(client.recorded.posts[0]?.body).toEqual({
      input: { kind: 'text', text: 'Migrate the checkout module' },
      cwd: PROJECT_PATH,
      projectId: PROJECT_ID,
      permission: 'worktree',
      provider: 'mock',
    });
  });

  it('sends the file and issue shapes through the same body', async () => {
    const client = composerClient();
    await mount({ client });

    await openComposer();
    one('[data-composer-shape="file"]')?.click();
    await settle();
    const path = one('[data-composer-path]') as HTMLInputElement;
    type(path, 'docs/spec.md');
    one('[data-composer-submit]')?.click();
    await settle();

    expect(client.recorded.posts[0]?.body).toMatchObject({
      input: { kind: 'file', path: 'docs/spec.md' },
      cwd: PROJECT_PATH,
    });
    // The page reads no file and resolves no path: what it sends is the string
    // the operator typed, and intake's realpath containment check is what
    // decides whether it is inside the project.
  });
});

suite('EPIC-22-S22 — each provider’s route is named in words', () => {
  it('renders the route the producer reported, spelled the way doctor spells it', async () => {
    const client = composerClient({
      providers: [
        usable({ id: 'alpha', route: 'acp', routes: { acp: 'available', shim: 'available' } }),
        usable({ id: 'beta', route: 'shim', routes: { acp: 'missing', shim: 'available' } }),
      ],
    });
    await mount({ client });
    await openComposer();

    expect(providerRow('alpha').textContent).toContain('ACP adapter');
    expect(providerRow('beta').textContent).toContain('exec shim');
    // "available" on its own is not enough to plan with, which is why the row
    // says which route rather than a green dot.
    expect(providerRow('beta').dataset.providerRoute).toBe('shim');
  });
});

suite('EPIC-22-S23 — an unavailable provider is not silently selectable', () => {
  it('shows the reason and the fixing command, and refuses to submit on it', async () => {
    const client = composerClient({ providers: [usable(), ABSENT] });
    await mount({ client });
    await openComposer();

    const row = providerRow('gamma');
    expect(row.dataset.providerAvailable).toBe('false');
    // AC3 — the reason *and* the command. Greyed out with no explanation leaves
    // the operator's next move to guesswork.
    expect(row.textContent).toContain('gamma is not installed here');
    expect(row.textContent).toContain('npm install -g @example/gamma');

    const input = row.querySelector<HTMLInputElement>('[data-provider-select]');
    expect(input?.disabled).toBe(true);

    // And selecting it by force — which is what a disabled radio still allows
    // through a keyboard in some browsers — issues nothing.
    input?.removeAttribute('disabled');
    input?.click();
    type(prompt(), 'Migrate the checkout module');
    submitChord();
    await settle();
    expect(client.recorded.posts).toHaveLength(0);
    expect(one('[data-composer-error]')?.textContent).toContain('gamma');
  });
});

suite('EPIC-22-S25 — an admission refusal is shown in the CLI’s own words', () => {
  it('renders the message verbatim, names the run, and keeps the draft', async () => {
    const message =
      'DeFlow cannot start this run: no agent adapter on this machine can serve it. (This is ' +
      'what DeFlowd found when it started — if you have installed one since, restart it with ' +
      '"deflow up".)';
    const client = composerClient({
      postAnswers: [
        {
          status: 422,
          body: {
            error: {
              code: 'no_usable_provider',
              message,
              detail: { runId: RUN_ID, providers: [] },
            },
          },
        },
      ],
    });
    await mount({ client });
    await openComposer();
    type(prompt(), 'Migrate the checkout module');
    submitChord();
    await settle();

    const error = one('[data-composer-error]');
    expect(error?.textContent).toContain(message);
    // It does not claim the run started, and it did not navigate.
    expect(shell.router.currentRoute.value.path).toBe('/projects');
    // The run exists and was aborted, so its id is reachable rather than lost.
    expect(one('[data-composer-refused-run]')?.textContent).toContain(RUN_ID);
    // A paragraph is not retyped because a machine is missing an adapter.
    expect(prompt().value).toBe('Migrate the checkout module');
  });
});

suite('EPIC-22-S26 — a human gate announces itself in KAR-19.12’s words', () => {
  it('names the node and the options, exactly as the run list and the CLI do', async () => {
    const client = composerClient();
    const feed = recordingFeed();
    await mount({ client, feed: feed.factory, at: `/runs/${RUN_ID}` });

    feed.push({
      seq: 2,
      runId: RUN_ID,
      ts: 1_755_000_000_001,
      kind: 'human.requested',
      v: 1,
      epoch: 1,
      payload: {
        node: 'spec-approval',
        prompt: 'Approve this spec?',
        options: [
          { id: 'approve', label: 'Approve and start', effect: 'proceed' },
          { id: 'edit', label: 'Edit the spec first', effect: 'amend' },
        ],
        reason: null,
      },
    } as unknown as Event);
    await settle();

    const banner = one('[data-run-gate-banner]');
    expect(banner?.textContent).toContain('spec-approval');
    expect(banner?.textContent).toContain('approve');
    expect(banner?.textContent).toContain('edit');
  });
});

suite('EPIC-22-S27 — what was submitted is still readable afterwards', () => {
  it('renders the task off the run’s own task.submitted, not off a copy the page kept', async () => {
    const client = composerClient();
    const feed = recordingFeed();
    // Mounted straight onto the run, with no composer ever used. If the banner
    // were a copy the composer kept, there would be nothing to render here —
    // which is exactly the difference this scenario is about.
    await mount({ client, feed: feed.factory, at: `/runs/${RUN_ID}` });

    feed.push(submittedFrame('Migrate the checkout module'));
    await settle();
    await expect
      .poll(() => one('[data-run-task]')?.textContent)
      .toContain('Migrate the checkout module');

    // Away and back. The panel closes its feed on the way out and re-opens it
    // on the way back (`../app/useRunFeed.ts`), and the projection is the tab's
    // picture of the run throughout — which is why the answer survives the
    // round trip rather than having to be re-fetched to be shown.
    await shell.router.push('/projects');
    await settle();
    await shell.router.push(`/runs/${RUN_ID}`);
    await settle();
    expect(feed.opened).toEqual([RUN_ID, RUN_ID]);

    // Re-delivered on the reconnect, exactly as a real hydrate re-delivers the
    // head of the run. The banner shows it because it folded the event, not
    // because anything on the page remembered it: nothing on this page ever
    // submitted anything.
    feed.push(submittedFrame('Migrate the checkout module'));
    await settle();
    await expect
      .poll(() => one('[data-run-task]')?.textContent)
      .toContain('Migrate the checkout module');
  });
});

suite('EPIC-22-S28 — keyboard only: reach the composer, type, submit', () => {
  it('submits a run with no pointer event dispatched at any point', async () => {
    const client = composerClient();
    await mount({ client, at: '/' });

    const pointerEvents: string[] = [];
    const record = (event: globalThis.Event) => pointerEvents.push(event.type);
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      document.addEventListener(name, record, true);
    }

    try {
      // AC7 — from another route, by shortcut. The map lives on `document` for
      // the life of the application, so this works wherever the operator is.
      await userEvent.keyboard('c');
      await settle();
      await expect.poll(() => one('[data-composer]')).not.toBeNull();

      // Focus is *in* the box the moment it opens: a composer that needs a
      // click to start typing is not keyboard-first.
      await expect.poll(() => document.activeElement).toBe(prompt());

      await userEvent.keyboard('ship it');
      await settle();
      expect(prompt().value).toBe('ship it');

      await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
      await settle();

      expect(client.recorded.posts).toHaveLength(1);
      expect(pointerEvents).toEqual([]);
    } finally {
      for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
        document.removeEventListener(name, record, true);
      }
    }
  });
});

suite('EPIC-22-S29 — a failed submission keeps the draft and says what happened', () => {
  it('keeps the text, names the failure, and lets a retry through', async () => {
    const client = composerClient({ postAnswers: ['network-error'] });
    await mount({ client });
    await openComposer();
    type(prompt(), 'Migrate the checkout module');
    submitChord();
    await settle();

    expect(prompt().value).toBe('Migrate the checkout module');
    expect(one('[data-composer-error]')?.textContent).toMatch(
      /could not be reached|Failed to fetch/,
    );
    expect(shell.router.currentRoute.value.path).toBe('/projects');

    submitChord();
    await settle();
    expect(client.recorded.posts).toHaveLength(2);
  });
});

suite('EPIC-22-S30 — an empty submission is refused before a request is made', () => {
  it('issues nothing and says what it needs', async () => {
    const client = composerClient();
    await mount({ client });
    await openComposer();
    submitChord();
    await settle();

    expect(client.recorded.posts).toEqual([]);
    expect(one('[data-composer-error]')?.textContent).toMatch(/prompt|file|issue/i);
  });
});

suite('EPIC-22-S32 — double submission creates one run', () => {
  it('makes one request, or two carrying the same Idempotency-Key', async () => {
    const client = composerClient({ hangFirstPost: true });
    await mount({ client });
    await openComposer();
    type(prompt(), 'Migrate the checkout module');

    submitChord();
    submitChord();
    await settle();

    const posts = client.recorded.posts;
    expect(posts.length).toBeGreaterThan(0);
    if (posts.length === 1) return;
    // Two is allowed only when the daemon can collapse them, which is what
    // `Idempotency-Key` is for — and the two keys have to be the same one.
    expect(posts).toHaveLength(2);
    expect(posts[0]?.idempotencyKey).toBeDefined();
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
  });
});

suite('AC7 — the composer is reachable from anywhere in the project', () => {
  it.each(['/', '/projects', `/runs/${RUN_ID}`])('opens on %s', async (at) => {
    const client = composerClient();
    await mount({ client, at, feed: recordingFeed().factory });
    await openComposer();
    expect(one('[data-composer]')).not.toBeNull();
    expect(all('[data-provider-row]').length).toBeGreaterThan(0);
  });
});

/**
 * KAR-22.4 AC3 — the issue input becomes a list once a connector is connected,
 * and stays a paste box either way.
 *
 * The failure this guards against is the obvious one: a list that *replaces*
 * the paste path, leaving an operator with a URL in their clipboard and a
 * picker that does not contain it — for an issue in another repository, or in
 * a repository DeFlow's connector cannot see.
 *
 * Verifies: EPIC-22-S51 · KAR-22.4 AC3, AC6 · test plan #4
 */
suite('EPIC-22-S51 — connected: the issue input is a searchable list', () => {
  it('offers this project’s issues with key, title and state', async () => {
    const client = composerClient({ connected: true });
    shell = await mountShell({ at: '/', client });
    await openComposer();

    one('[data-composer-shape="issue"]')?.click();
    await settle();
    await expect.poll(() => all('[data-composer-issue]').length).toBe(2);

    const [first] = all('[data-composer-issue]');
    expect(first?.textContent).toContain('acme/checkout#41');
    expect(first?.textContent).toContain('Retry the flaky worktree reaper');
    expect(first?.textContent).toContain('open');
  });

  it('sends what was typed to the connector rather than filtering in the browser', async () => {
    const client = composerClient({ connected: true });
    shell = await mountShell({ at: '/', client });
    await openComposer();

    one('[data-composer-shape="issue"]')?.click();
    await settle();
    type(one('[data-composer-url]') as HTMLInputElement, 'reaper');
    await settle();

    // A repository with three hundred issues must not become three hundred
    // rows on the wire and a filter here.
    await expect.poll(() => client.recorded.searches).toContain('reaper');
  });

  it('picking an entry submits that issue, by the reference the service gave', async () => {
    const client = composerClient({ connected: true });
    shell = await mountShell({ at: '/', client });
    await openComposer();

    one('[data-composer-shape="issue"]')?.click();
    await settle();
    await expect.poll(() => all('[data-composer-issue]').length).toBe(2);
    all('[data-composer-issue]')[0]?.click();
    await settle();
    one('[data-composer-submit]')?.click();
    await settle();

    await expect.poll(() => client.recorded.posts).toHaveLength(1);
    expect((client.recorded.posts[0]?.body as { input: unknown }).input).toEqual({
      kind: 'issue',
      url: 'https://github.com/acme/checkout/issues/41',
    });
  });

  it('still submits a pasted reference, connected or not', async () => {
    const client = composerClient({ connected: true });
    shell = await mountShell({ at: '/', client });
    await openComposer();

    one('[data-composer-shape="issue"]')?.click();
    await settle();
    // A URL from a repository this connector never listed.
    type(one('[data-composer-url]') as HTMLInputElement, 'https://github.com/other/repo/issues/9');
    await settle();
    one('[data-composer-submit]')?.click();
    await settle();

    await expect.poll(() => client.recorded.posts).toHaveLength(1);
    expect((client.recorded.posts[0]?.body as { input: unknown }).input).toEqual({
      kind: 'issue',
      url: 'https://github.com/other/repo/issues/9',
    });
  });
});

suite('EPIC-22-S56 — with no connector, the composer is exactly what it was (AC6)', () => {
  it('offers no list, asks the connector for nothing, and still submits a pasted reference', async () => {
    const client = composerClient({ connected: false });
    shell = await mountShell({ at: '/', client });
    await openComposer();

    one('[data-composer-shape="issue"]')?.click();
    await settle();

    expect(all('[data-composer-issue]')).toHaveLength(0);
    expect(client.recorded.searches).toEqual([]);

    type(
      one('[data-composer-url]') as HTMLInputElement,
      'https://github.com/acme/checkout/issues/1',
    );
    await settle();
    one('[data-composer-submit]')?.click();
    await settle();

    await expect.poll(() => client.recorded.posts).toHaveLength(1);
  });
});
