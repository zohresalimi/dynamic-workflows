/**
 * KAR-25.4 test plan — the "Issue tracker" panel, in a real Chromium, mounted
 * through `/settings` the way an operator actually reaches it.
 *
 * Verifies: EPIC-25-S22 … EPIC-25-S29 · AC1–AC7
 *
 * Supersedes `../../views/connectors.test.ts` (KAR-22.4/KAR-22.6's own test
 * plan, deleted by this story along with `ConnectorsView.vue`): every
 * behavioural claim that file made is re-asserted here, against the new
 * location and the new `<select>` this story adds to name which project a
 * click binds — a missing-scope row renders the daemon's own sentence and
 * its exact resolving command, a connected row renders the daemon's own
 * account and granted scopes, three services render in the daemon's own
 * order, every credential sentence is the daemon's own, a service with no
 * authorisation route offers no button and no link, connecting and
 * disconnecting both round-trip through the daemon. The one claim that is
 * *not* carried over unchanged is the old file's blanket "zero inputs
 * anywhere on the screen": now that this panel shares `/settings` with
 * Execution Defaults' own real numeric `<input>`s (KAR-25.2), that check is
 * re-scoped to what KAR-22.4 AC5 actually requires — no field whose purpose
 * is a credential — and proved with a workspace chosen, the state that
 * actually puts other inputs on the page; see EPIC-25-S26's own comment for
 * why. `../../lib/connector-status.test.ts` is the pure half of the table
 * this file's EPIC-25-S22 suite re-proves in the DOM; see that file's own
 * header comment for why both exist. This file also covers ground the old
 * one never had reason to: a stale response from a project the picker has
 * since moved past must never render under the newly selected one
 * (EPIC-25-S23a), and `unreachable` — one of the daemon's three
 * `ConnectorStateName`s (with `expired`, `not-authorised`) that no browser
 * spec touched at all before this file, only the pure table — gets its own
 * DOM-level assertion, proving the daemon's sentence for it actually
 * renders rather than only its status word.
 *
 * Modelled on `../../views/settings.test.ts`: a small fixed daemon rather than
 * `fetch` monkey-patched or a hand-built typed-client double, because several
 * of these specs assert *which request was made and with what body*.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../../test/shell.ts';
import { createClient } from '../../api/client.ts';

const PROJECT_A = {
  id: 'prj_20260815T101112Z_a1b2c3',
  name: 'checkout',
  path: '/repos/checkout',
  createdAt: '2026-08-15T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
};

const PROJECT_B = {
  id: 'prj_20260816T101112Z_b2c3d4',
  name: 'billing',
  path: '/repos/billing',
  createdAt: '2026-08-16T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
};

const CREDENTIAL = {
  authorisedBy:
    "GitHub's own OAuth application — the GitHub CLI's — through `gh auth login`, which opens " +
    "GitHub's device authorisation page in your own browser.",
  holder: 'The GitHub CLI. DeFlow never reads, copies or transmits the token.',
  livesIn: "The GitHub CLI's own credential store on this machine.",
  deflowStores: 'DeFlow stores no credential: one row holding this project and the word "github".',
  revoke: {
    command: 'gh auth logout --hostname github.com' as string | null,
    affects: 'It also signs out anything else on this machine that uses `gh`.',
  },
};

const AUTHORISATION = {
  kind: 'command' as const,
  command: 'gh auth login --hostname github.com --web --scopes repo',
  url: 'https://github.com/login/device',
  whyNotOneClick:
    'Connecting takes one command rather than one button because DeFlow does not have a ' +
    'registered OAuth application with GitHub.',
};

/** KAR-22.6 — a service that has no route to authorisation, and says why. */
const UNAVAILABLE = {
  kind: 'unavailable' as const,
  whyNotConnectable:
    'DeFlow cannot connect Linear without holding a Linear credential itself, and it does not ' +
    'hold credentials. Linear publishes no first-party command-line tool that would hold one on ' +
    'your behalf, so there is nothing here to press yet.',
};

const LINEAR_CREDENTIAL = {
  ...CREDENTIAL,
  holder: 'Nobody. There is no first-party Linear tool for DeFlow to delegate to.',
  revoke: {
    command: null,
    affects: 'There is nothing to revoke: DeFlow was never granted anything and holds nothing.',
  },
};

interface StateBody {
  readonly state: string;
  readonly account: string | null;
  readonly scopes: readonly string[];
  readonly missingScopes: readonly string[];
  readonly message: string;
  readonly action: string | null;
}

const CONNECTED: StateBody = {
  state: 'connected',
  account: 'octocat',
  scopes: ['gist', 'repo'],
  missingScopes: [],
  message: 'Connected as octocat. The token stays in the GitHub CLI’s own credential store.',
  action: null,
};

const NOT_INSTALLED: StateBody = {
  state: 'not-installed',
  account: null,
  scopes: [],
  missingScopes: ['repo'],
  message: 'The GitHub CLI (`gh`) is not on this machine’s PATH.',
  action: 'Install the GitHub CLI from https://cli.github.com, then reload this page.',
};

const MISSING_SCOPE: StateBody = {
  state: 'missing-scope',
  account: 'octocat',
  scopes: ['gist'],
  missingScopes: ['repo'],
  message: 'The credential `gh` holds is missing the repo scope.',
  action: 'gh auth refresh --hostname github.com --scopes repo',
};

/** One of the daemon's other four `ConnectorStateName`s — no browser spec
 *  touched `expired`, `unreachable` or `not-authorised` at all before this
 *  file; the pure table in `../../lib/connector-status.test.ts` covers the
 *  status word for all six, but nothing checked the DOM renders this state's
 *  own daemon sentence until the spec below. */
const UNREACHABLE: StateBody = {
  state: 'unreachable',
  account: null,
  scopes: [],
  missingScopes: [],
  message: 'GitHub’s API did not answer. Check this machine’s network and try again.',
  action: null,
};

/** KAR-22.6 — what a service DeFlow cannot reach at all reports about itself. */
const UNCONNECTABLE: StateBody = {
  state: 'not-installed',
  account: null,
  scopes: [],
  missingScopes: [],
  message:
    'DeFlow cannot connect Linear without holding a Linear credential, and it does not hold ' +
    'credentials. Reaching Linear needs a personal API key or an OAuth application DeFlow has ' +
    'not registered.',
  action: null,
};

const row = (state: StateBody, connected = false) => ({
  id: 'github',
  label: 'GitHub',
  connected,
  connectedAt: connected ? '2026-08-16T10:11:12.000Z' : null,
  state,
  credential: CREDENTIAL,
  authorisation: AUTHORISATION as typeof AUTHORISATION | typeof UNAVAILABLE,
});

const linearRow = () => ({
  ...row(UNCONNECTABLE),
  id: 'linear',
  label: 'Linear',
  credential: LINEAR_CREDENTIAL,
  authorisation: UNAVAILABLE as typeof AUTHORISATION | typeof UNAVAILABLE,
});

const jiraRow = (connected = false) => ({
  ...row(CONNECTED, connected),
  id: 'jira',
  label: 'Jira',
  authorisation: {
    ...AUTHORISATION,
    command: 'acli jira auth login --site <your-site>.atlassian.net --web',
    url: null,
  } as unknown as typeof AUTHORISATION | typeof UNAVAILABLE,
});

interface Recorded {
  readonly posts: string[];
  readonly deletes: string[];
  /** Every project id a `GET .../connectors` was made for, pushed the moment
   *  the request arrives — *before* a `gatedProjects` wait, if any. Lets a
   *  spec confirm a gated request has actually started (fetch invoked)
   *  without waiting for it to resolve, which for a gated project it never
   *  does until the test itself releases it. */
  readonly gets?: string[];
}

/**
 * A fixed daemon over every path this page and the frame around it reach.
 * `servicesByProject` is a mutable map so a `POST`/`DELETE` in one step is
 * visible to the `GET` this panel's own `load()` makes right after — the
 * same shape `../../views/settings.test.ts`'s `configStore` uses for the same
 * reason.
 *
 * `gatedProjects` lets a spec hold one project's `GET .../connectors`
 * response open until the test itself releases it — see the race spec in
 * "EPIC-25-S22a" below, which needs A's response to resolve *after* B's
 * rather than merely later, and a `setTimeout` race is not that.
 *
 * `configStore`/`knownCwds` answer `GET /api/config`, the way
 * `../../views/settings.test.ts`'s own `settingsDaemon` does — needed only by
 * the credential-scope spec that puts a workspace's own Execution Defaults
 * inputs on the page next to this panel.
 */
function issueTrackerDaemon(options: {
  readonly projects?: readonly (typeof PROJECT_A)[];
  readonly servicesByProject?: Record<string, ReturnType<typeof row>[]>;
  readonly recorded?: Recorded;
  readonly gatedProjects?: Record<string, Promise<void>>;
  readonly configStore?: Record<string, Record<string, unknown>>;
  readonly knownCwds?: readonly string[];
}) {
  const servicesByProject = options.servicesByProject ?? {};
  const configStore = options.configStore ?? {};
  const knownCwds = new Set(options.knownCwds ?? Object.keys(configStore));

  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;

    const serviceMatch = /\/api\/projects\/([^/]+)\/connectors\/([^/]+)$/.exec(path);
    if (serviceMatch) {
      const [, projectId, serviceId] = serviceMatch as unknown as [string, string, string];
      const services = servicesByProject[projectId] ?? [];

      if (method === 'POST') {
        options.recorded?.posts.push(`${projectId}/${serviceId}`);
        servicesByProject[projectId] = services.map((service) =>
          service.id === serviceId
            ? { ...service, connected: true, connectedAt: '2026-08-16T10:11:12.000Z' }
            : service,
        );
        const connector = servicesByProject[projectId]?.find((service) => service.id === serviceId);
        return json(201, { connector });
      }
      if (method === 'DELETE') {
        options.recorded?.deletes.push(`${projectId}/${serviceId}`);
        const removedService = services.find((service) => service.id === serviceId);
        servicesByProject[projectId] = services.map((service) =>
          service.id === serviceId ? { ...service, connected: false, connectedAt: null } : service,
        );
        return json(200, {
          service: serviceId,
          removed: true,
          credentialDeleted: false,
          revoke: removedService?.credential.revoke ?? CREDENTIAL.revoke,
          message: `DeFlow will no longer use ${serviceId} for this project.`,
        });
      }
    }

    const listMatch = /\/api\/projects\/([^/]+)\/connectors$/.exec(path);
    if (listMatch && method === 'GET') {
      const [, projectId] = listMatch as unknown as [string, string];
      options.recorded?.gets?.push(projectId);
      // Held open until the test releases it — see the docblock above.
      await options.gatedProjects?.[projectId];
      return json(200, { services: servicesByProject[projectId] ?? [] });
    }

    if (path.includes('/config')) {
      const cwd = new URL(url).searchParams.get('cwd') ?? '';
      if (!knownCwds.has(cwd)) {
        return json(400, {
          error: {
            code: 'invalid_request',
            message: 'cwd is not a repository this daemon holds a run for',
            detail: { field: 'cwd' },
            retryable: false,
          },
        });
      }
      return json(200, { cwd, config: configStore[cwd] ?? {} });
    }

    if (path.includes('/providers')) return json(200, []);
    if (/\/api\/projects\/[^/?]+\/runs$/.test(path)) return json(200, { runs: [] });
    if (path.includes('/projects')) return json(200, { projects: options.projects ?? [] });
    if (path.includes('/approvals'))
      return json(200, { items: [], counts: { total: 0 }, headSeq: 1 });
    return json(404, { error: { message: 'not found' } });
  };
}

function client(options: Parameters<typeof issueTrackerDaemon>[0]) {
  return createClient({
    baseUrl: 'http://127.0.0.1:7777/api',
    fetch: issueTrackerDaemon(options),
    token: () => 'test-token-Aa0_-Bb1',
  });
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await shell.router.isReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const connectorRow = (id: string): HTMLElement => {
  const found = shell.container.querySelector<HTMLElement>(`[data-connector-row="${id}"]`);
  if (found === null) throw new Error(`the issue tracker panel rendered no ${id} row`);
  return found;
};

const githubRow = (): HTMLElement => connectorRow('github');

const projectPicker = (): HTMLSelectElement =>
  shell.container.querySelector<HTMLSelectElement>(
    '[data-issue-tracker-project]',
  ) as HTMLSelectElement;

async function chooseProject(id: string): Promise<void> {
  await userEvent.selectOptions(projectPicker(), id);
  await settle();
}

suite('EPIC-25-S22 — the resolved status table, all five rows (AC1)', () => {
  it.each([
    { services: [row(CONNECTED, true)], status: 'connected', action: 'disconnect' },
    { services: [row(CONNECTED, false)], status: 'available', action: 'connect' },
    { services: [row(NOT_INSTALLED, true)], status: 'bound · CLI missing', action: 'disconnect' },
    { services: [row(NOT_INSTALLED, false)], status: 'not installed', action: 'none' },
  ])('renders "$status" with action "$action"', async ({ services, status, action }) => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: services },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const github = githubRow();
    expect(github.dataset.connectorStatus).toBe(status);
    expect(github.dataset.connectorAction).toBe(action);
    expect(github.querySelector('[data-connector-connect]') !== null).toBe(action === 'connect');
    expect(github.querySelector('[data-connector-remove]') !== null).toBe(action === 'disconnect');
  });

  it('a service with no authorisation route reads "cannot be connected" with no action', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [linearRow()] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const linear = connectorRow('linear');
    expect(linear.dataset.connectorStatus).toBe('cannot be connected');
    expect(linear.dataset.connectorAction).toBe('none');
  });
});

suite(
  'EPIC-22-S48 — carried over verbatim from the deleted `connectors.test.ts` (KAR-22.4 AC1)',
  () => {
    it('a missing-scope row renders the daemon’s own sentence and the exact resolving command', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [row(MISSING_SCOPE, true)] },
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      const github = githubRow();
      expect(github.textContent).toContain(MISSING_SCOPE.message);
      // The command, in full and copyable — not "grant the missing scope".
      expect(github.textContent).toContain('gh auth refresh --hostname github.com --scopes repo');
    });

    it('a connected row renders the daemon’s own account and granted scopes', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [row(CONNECTED, true)] },
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      const text = githubRow().textContent ?? '';
      expect(CONNECTED.account).not.toBeNull();
      expect(text).toContain(CONNECTED.account as string);
      for (const scope of CONNECTED.scopes) expect(text).toContain(scope);
    });

    it('renders three services in the daemon’s own order, not some other one', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: {
            [PROJECT_A.id]: [row(CONNECTED, true), linearRow(), jiraRow()],
          },
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      const rendered = [
        ...shell.container.querySelectorAll<HTMLElement>('[data-connector-row]'),
      ].map((element) => element.dataset.connectorRow);
      // One registry, one loop, one component — a panel that special-cased a
      // service would show a different number here or a different order.
      expect(rendered).toEqual(['github', 'linear', 'jira']);
    });

    it('an "unreachable" row — untouched by any browser spec before this one — renders its own daemon sentence', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [row(UNREACHABLE, false)] },
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      const github = githubRow();
      expect(github.dataset.connectorStatus).toBe('unreachable');
      expect(github.textContent).toContain(UNREACHABLE.message);
    });
  },
);

suite('EPIC-25-S23 — bound-but-CLI-missing reads as one coherent state (AC2)', () => {
  it('never shows "not-installed" and "connected" as two separate statuses, and names what to install', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(NOT_INSTALLED, true)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const github = githubRow();
    expect(github.textContent).not.toMatch(/not-installed/);
    expect(github.dataset.connectorStatus).toBe('bound · CLI missing');
    // It still offers Disconnect — a coherent, bound-but-broken state, not a
    // reason to hide the binding.
    expect(github.querySelector('[data-connector-remove]')).not.toBeNull();
    expect(github.textContent).toContain('https://cli.github.com');
  });
});

suite(
  'EPIC-25-S24 — not-installed and unbound offers no Disconnect and no "in use since" (AC2)',
  () => {
    it('offers no Disconnect control', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [row(NOT_INSTALLED, false)] },
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      const github = githubRow();
      expect(github.querySelector('[data-connector-remove]')).toBeNull();
      expect(github.querySelector('[data-connector-connect]')).toBeNull();
      expect(github.textContent).not.toContain('in use since');
    });
  },
);

suite(
  'EPIC-25-S23a — a stale response never renders another project’s binding (regression)',
  () => {
    it('never shows A’s "connected"/"in use since" under B when A’s response lands after B’s', async () => {
      // A is bound; B has never so much as installed the CLI. A's own GET is
      // held open (`gate`) until this test releases it, deliberately after
      // B's — already-resolved — response has been applied.
      let releaseA: () => void = () => {
        /* replaced below */
      };
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const recorded: Recorded = { posts: [], deletes: [], gets: [] };

      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A, PROJECT_B],
          servicesByProject: {
            [PROJECT_A.id]: [row(CONNECTED, true)],
            [PROJECT_B.id]: [row(NOT_INSTALLED, false)],
          },
          gatedProjects: { [PROJECT_A.id]: gate },
          recorded,
        }),
      });
      // Mounting starts the panel's own preview `load()` against
      // `projects[0]` — A — once the async `GET /api/projects` this page's
      // own picker needs resolves. That is the in-flight request this spec
      // races B's own switch against; it stays pending until `releaseA()`
      // below, so waiting for the row to render (as `EPIC-25-S28`'s own spec
      // does) is not an option here — the row is exactly what stays absent
      // until then. Poll the daemon's own record of the request instead.
      await settle();
      await expect.poll(() => recorded.gets).toContain(PROJECT_A.id);

      // Pick A explicitly (still the same request, still gated — the picker
      // only names which project a click would *bind*, see the panel's own
      // header comment) then switch straight to B, whose own GET is not
      // gated and resolves immediately.
      await chooseProject(PROJECT_A.id);
      await chooseProject(PROJECT_B.id);
      await expect.poll(() => recorded.gets).toContain(PROJECT_B.id);

      // B is now the selected project, and its own fast response has landed:
      // nothing bound, nothing installed.
      await expect.poll(() => githubRow().dataset.connectorConnected).toBe('false');
      const beforeRelease = githubRow();
      expect(beforeRelease.querySelector('[data-connector-remove]')).toBeNull();
      expect(beforeRelease.textContent).not.toContain('in use since');

      // Now let A's slow response land, after B's fast one already did.
      releaseA();
      await settle();
      // Extra room for A's `.then()` continuation to run and (on the buggy
      // code) overwrite `services.value` — `settle()`'s own two 0ms ticks are
      // enough in practice, but this is the assertion the whole spec turns
      // on, so it gets a wider margin than "in practice".
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The panel must still describe B, not A: `connected` + Disconnect +
      // "in use since" under a project with no binding at all is exactly the
      // contradiction this story exists to remove (see
      // `../../lib/connector-status.ts`'s own header comment) — reintroduced
      // here as a race between two in-flight `GET`s instead of as one
      // daemon response conflating two facts.
      expect(projectPicker().value).toBe(PROJECT_B.id);
      const afterRelease = githubRow();
      expect(afterRelease.dataset.connectorConnected).toBe('false');
      expect(afterRelease.dataset.connectorStatus).not.toBe('connected');
      expect(afterRelease.querySelector('[data-connector-remove]')).toBeNull();
      expect(afterRelease.textContent).not.toContain('in use since');
    });
  },
);

suite('EPIC-25-S25 — every credential sentence is still the daemon’s, verbatim (AC3)', () => {
  it('states whose application authorises, where the token lives and what DeFlow stores', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(NOT_INSTALLED)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const text = githubRow().textContent ?? '';
    expect(text).toContain(CREDENTIAL.authorisedBy);
    expect(text).toContain(CREDENTIAL.holder);
    expect(text).toContain(CREDENTIAL.livesIn);
    expect(text).toContain(CREDENTIAL.deflowStores);
  });

  it('says out loud why connecting is a command rather than a single button, and links to it', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(NOT_INSTALLED)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const github = githubRow();
    expect(github.textContent).toContain(AUTHORISATION.whyNotOneClick);
    expect(github.textContent).toContain(AUTHORISATION.command);
    const link = github.querySelector<HTMLAnchorElement>('[data-connector-authorise]');
    expect(link?.getAttribute('href')).toBe(AUTHORISATION.url);
  });
});

/** A workspace's `.DeFlow/config.yaml`, real enough to put Execution
 *  Defaults' own numeric `UiField`s on the page (KAR-25.2) — a budget
 *  ceiling and a byte threshold, the same shape `../../views/settings.test.ts`'s
 *  own `CONFIG_CHECKOUT` uses. */
const CONFIG = {
  context: { inlineThresholdBytes: 4096 },
  budget: { run: { costUsd: 5, wallclockMs: 600_000 } },
};

suite('EPIC-25-S26 — no field on this page exists to hold a credential (KAR-22.4 AC5)', () => {
  it(
    'the issue tracker panel renders no input at all, and Execution Defaults’ own text ' +
      'inputs — real ones, once a workspace is chosen — are a budget ceiling and a byte ' +
      'threshold, not credentials',
    async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: {
            [PROJECT_A.id]: [row(CONNECTED, true), linearRow(), jiraRow()],
          },
          configStore: { [PROJECT_A.path]: CONFIG },
          knownCwds: [PROJECT_A.path],
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      // The issue tracker panel is where a credential field could plausibly
      // leak in — it is `../ConnectorsPanel.vue`'s own original defect,
      // KAR-22.4/KAR-22.6's screen. That half of the old blanket check is
      // still exactly right and stays a hard zero, workspace or no
      // workspace: the daemon's credential sentences render as text here,
      // never as a box to type a token into.
      const tracker = shell.container.querySelector<HTMLElement>('[data-issue-tracker]');
      expect(tracker?.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);

      // Execution Defaults (KAR-25.2) shares this page and legitimately
      // renders real `<input type="text">` fields once a workspace is
      // chosen — see that panel's own header comment. Every spec in this
      // suite used to leave that picker unset, so the blanket "zero inputs
      // anywhere on [data-settings]" assertion was never exercised in the
      // state the page is actually in once an operator picks a workspace,
      // and it would fail there for a reason that has nothing to do with a
      // leaked credential field. The rule this inherits — KAR-22.4 AC5 —
      // is narrower than "zero inputs" and still honestly testable: no
      // *field whose purpose is a credential*. Choosing a workspace here,
      // the realistic combined state, is what makes that distinction mean
      // anything; asserted below by type (no `password` input anywhere)
      // and by what each visible field's own `<label>` says it is for.
      const workspacePicker = shell.container.querySelector<HTMLSelectElement>(
        '[data-settings-workspace]',
      );
      await userEvent.selectOptions(workspacePicker as HTMLSelectElement, PROJECT_A.path);
      await expect
        .poll(() =>
          shell.container.querySelector('[data-field="context.inlineThresholdBytes"] input'),
        )
        .not.toBeNull();

      const page = shell.container.querySelector<HTMLElement>('[data-settings]');
      const inputs = [...(page?.querySelectorAll<HTMLInputElement>('input') ?? [])];
      // Proves this run actually reached the shared-page state the old
      // check never did — a page with zero inputs here would mean the
      // workspace never got picked, not that the credential rule held.
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((input) => input.type !== 'password')).toBe(true);

      const credentialWords = /token|secret|password|api[\s-]?key|credential/i;
      for (const input of inputs) {
        const label = input.closest('[data-field]')?.querySelector('label')?.textContent ?? '';
        expect(label).not.toMatch(credentialWords);
      }
    },
  );
});

suite(
  'EPIC-25-S27 — a service with no authorisation route offers no button and no link (KAR-22.6)',
  () => {
    it('renders no connect button and no authorisation link on the Linear row', async () => {
      const recorded: Recorded = { posts: [], deletes: [] };
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [linearRow()] },
          recorded,
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      const linear = connectorRow('linear');
      expect(linear.querySelector('[data-connector-connect]')).toBeNull();
      expect(linear.querySelector('[data-connector-authorise]')).toBeNull();
      expect(recorded.posts).toEqual([]);
      expect(linear.textContent).toContain(UNAVAILABLE.whyNotConnectable);
    });

    it('offers a connect button on a service that can be connected, in the same fixture', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [linearRow(), jiraRow()] },
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      expect(connectorRow('jira').querySelector('[data-connector-connect]')).not.toBeNull();
      // `acli --web` opens Atlassian's own page; DeFlow does not know its
      // address and does not guess one.
      expect(connectorRow('jira').querySelector('[data-connector-authorise]')).toBeNull();
    });
  },
);

suite(
  'EPIC-25-S28 — with no project open, binding explains itself and offers nothing (AC6)',
  () => {
    it('explains that binding needs a project, still shows credential facts, and offers no action', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A, PROJECT_B],
          servicesByProject: {
            [PROJECT_A.id]: [row(CONNECTED, true), linearRow(), jiraRow()],
          },
        }),
      });
      await settle();

      // Nothing was chosen — the picker starts empty on every mount.
      expect(projectPicker().value).toBe('');

      const panel = shell.container.querySelector<HTMLElement>('[data-issue-tracker]');
      expect(panel?.textContent).toMatch(/needs a project/i);

      // The facts still render (EPIC-25-S28) — sourced from a project, but not
      // presented as a binding to it. The preview fetch chains through this
      // panel's own `GET /api/projects/:id/connectors` after `projects` itself
      // arrives asynchronously, so this is polled rather than asserted cold.
      await expect
        .poll(() => shell.container.querySelector('[data-connector-row="github"]'))
        .not.toBeNull();
      const github = githubRow();
      expect(github.textContent).toContain(CREDENTIAL.holder);

      // No action anywhere on the panel that would 422 without a chosen
      // project, and the "in use since" line — which belongs to a specific
      // project's own binding — does not appear either.
      expect(panel?.querySelectorAll('[data-connector-connect]')).toHaveLength(0);
      expect(panel?.querySelectorAll('[data-connector-remove]')).toHaveLength(0);
      expect(panel?.textContent).not.toContain('in use since');
    });

    it('offers no rows and says so plainly when there are no projects at all', async () => {
      shell = await mountShell({
        at: '/settings',
        client: client({ projects: [] }),
      });
      await settle();

      const panel = shell.container.querySelector<HTMLElement>('[data-issue-tracker]');
      expect(panel?.textContent).toMatch(/no projects/i);
      expect(panel?.querySelectorAll('[data-connector-row]')).toHaveLength(0);
    });
  },
);

suite('EPIC-25-S29 — the old connectors URL redirects rather than 404s (AC7)', () => {
  it('lands on /settings with the issue-tracker panel in view', async () => {
    shell = await mountShell({
      at: { name: 'project-workflows', params: { projectId: PROJECT_A.id } },
      client: client({ projects: [PROJECT_A] }),
    });
    await settle();

    await shell.router.push(`/projects/${PROJECT_A.id}/connectors`);
    await settle();

    expect(shell.router.currentRoute.value.name).toBe('settings');
    expect(shell.container.querySelector('[data-panel="issue-tracker"]')).not.toBeNull();
    expect(shell.container.querySelector('[data-issue-tracker]')).not.toBeNull();
  });
});

suite(
  'connecting and disconnecting still round-trip through the daemon (regression, KAR-22.4)',
  () => {
    it('sends one post for the project chosen on the picker, and re-reads the state', async () => {
      const recorded: Recorded = { posts: [], deletes: [] };
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [row(CONNECTED, false)] },
          recorded,
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      githubRow().querySelector<HTMLElement>('[data-connector-connect]')?.click();

      await expect.poll(() => githubRow().dataset.connectorConnected).toBe('true');
      expect(recorded.posts).toEqual([`${PROJECT_A.id}/github`]);
      expect(githubRow().dataset.connectorStatus).toBe('connected');
    });

    it('sends one delete and renders the operator’s own revocation command', async () => {
      const recorded: Recorded = { posts: [], deletes: [] };
      shell = await mountShell({
        at: '/settings',
        client: client({
          projects: [PROJECT_A],
          servicesByProject: { [PROJECT_A.id]: [row(CONNECTED, true)] },
          recorded,
        }),
      });
      await settle();
      await chooseProject(PROJECT_A.id);

      githubRow().querySelector<HTMLElement>('[data-connector-remove]')?.click();

      await expect.poll(() => githubRow().dataset.connectorConnected).toBe('false');
      expect(recorded.deletes).toEqual([`${PROJECT_A.id}/github`]);
      const panel = shell.container.querySelector('[data-issue-tracker]');
      expect(panel?.textContent).toContain('gh auth logout --hostname github.com');
    });
  },
);

suite('KAR-26.4 / EPIC-26-S27 — an issue-tracker row is one row with one chip', () => {
  it.each([
    { name: 'connected', services: [row(CONNECTED, true)], id: 'github', status: 'connected' },
    { name: 'available', services: [row(CONNECTED, false)], id: 'github', status: 'available' },
    {
      name: 'bound · CLI missing',
      services: [row(NOT_INSTALLED, true)],
      id: 'github',
      status: 'bound · CLI missing',
    },
    {
      name: 'not installed',
      services: [row(NOT_INSTALLED, false)],
      id: 'github',
      status: 'not installed',
    },
    {
      name: 'cannot be connected',
      services: [linearRow()],
      id: 'linear',
      status: 'cannot be connected',
    },
  ])('"$name" renders exactly one status chip carrying it', async ({ services, id, status }) => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: services },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const target = connectorRow(id);
    const chips = target.querySelectorAll('.ui-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent?.trim()).toBe(status);
    // The mono subline: the daemon's own account (or an honest dash) and its
    // own scope list — never a composed claim.
    const subline = target.querySelector('[data-connector-subline]');
    expect(subline).not.toBeNull();
  });

  it('the subline carries the account and granted scopes for a connected row', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(CONNECTED, true)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const subline = githubRow().querySelector('[data-connector-subline]');
    expect(subline?.textContent).toContain('octocat');
    expect(subline?.textContent).toContain('gist, repo');
  });

  it('a missing-scope subline names the missing scope, never only the granted one', async () => {
    // The owner's original defect, guarded against its densified re-entry:
    // `scopes` is the *granted* list, so an unlabelled `octocat · gist`
    // beside a "missing scope" chip shows the operator exactly the one scope
    // they already have. The subline for this state must carry the daemon's
    // own `missingScopes`, labelled as missing.
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(MISSING_SCOPE, true)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const subline = githubRow().querySelector('[data-connector-subline]');
    expect(subline?.textContent).toContain('octocat');
    expect(subline?.textContent).toContain('missing scope: repo');
    // The granted list alone, unlabelled, is the composed claim — it must
    // not stand beside the "missing scope" chip as the row's only scope name.
    expect(subline?.textContent).not.toMatch(/·\s*gist\s*$/);
  });

  it('keeps the labelled granted-scopes line, verbatim, in the disclosure', async () => {
    // KAR-26.4 AC3 — demoted, not deleted: the pre-density page rendered
    // "Granted scopes: …" as its own labelled line. That line lives in the
    // disclosure now, and renders once it opens.
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(CONNECTED, true)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const github = githubRow();
    const scopes = github.querySelector('[data-connector-scopes]') as HTMLElement;
    expect(scopes).not.toBeNull();
    expect(scopes.textContent?.replace(/\s+/g, ' ').trim()).toBe('Granted scopes: gist, repo');
    expect(scopes.checkVisibility()).toBe(false);

    await userEvent.click(github.querySelector('.ui-disclosure__trigger') as HTMLElement);
    await expect.poll(() => scopes.checkVisibility()).toBe(true);
  });

  it('the subline is an honest dash when the daemon reports no account', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(NOT_INSTALLED, false)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const subline = githubRow().querySelector('[data-connector-subline]');
    expect(subline?.textContent?.trim()).toBe('—');
  });
});

suite('KAR-26.4 / EPIC-26-S28 — GitHub’s provenance survives, demoted into the disclosure', () => {
  it('keeps all four credential facts and the command in the document, rendered only once open', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        servicesByProject: { [PROJECT_A.id]: [row(NOT_INSTALLED)] },
      }),
    });
    await settle();
    await chooseProject(PROJECT_A.id);

    const github = githubRow();
    // Closed: every fact is still in the row's textContent (the disclosure
    // keeps its content in the document) but none is rendered.
    for (const fact of [
      CREDENTIAL.authorisedBy,
      CREDENTIAL.holder,
      CREDENTIAL.livesIn,
      CREDENTIAL.deflowStores,
      AUTHORISATION.command,
    ]) {
      expect(github.textContent).toContain(fact);
    }
    const credential = github.querySelector('.connector__credential') as HTMLElement;
    expect(credential.checkVisibility()).toBe(false);

    // Open: the same facts, intact, now rendered.
    await userEvent.click(github.querySelector('.ui-disclosure__trigger') as HTMLElement);
    await expect.poll(() => credential.checkVisibility()).toBe(true);
    const commandBlock = github.querySelector('.connector__command') as HTMLElement;
    expect(commandBlock.checkVisibility()).toBe(true);
    expect(commandBlock.textContent).toContain(AUTHORISATION.command);
  });
});
