/**
 * KAR-22.4 test plan #1 — the connectors screen, in a real Chromium.
 *
 * The API half is asserted against a real daemon and a real `gh`-shaped binary
 * in `packages/daemon/test/integration/connectors-api.test.ts`. What only a
 * browser can answer is the half the operator touches, and for this story that
 * is unusually load-bearing: **the screen is where AC1's amendment is either
 * honest or a lie.**
 *
 * DeFlow has no registered OAuth application with GitHub, so it cannot own the
 * authorisation button. The two things that could go wrong are both rendering
 * problems: a token field appearing to fill the gap, or the screen quietly
 * omitting the fact that connecting takes a command. Both are asserted here.
 *
 * **Extended by KAR-22.6 (test plan #1).** The screen now renders three
 * services from one registry, one of which cannot be connected at all — and the
 * thing a browser is uniquely able to assert about that row is what it does
 * *not* have. A connect button on a service DeFlow cannot reach is the exact
 * failure AC2 forbids, and it is a rendering failure: the daemon can refuse the
 * route perfectly and the page can still offer the click.
 *
 * Verifies: EPIC-22-S48, EPIC-22-S68, EPIC-22-S70 · KAR-22.4 AC1, AC2, AC5 ·
 * KAR-22.6 AC1, AC2
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import type { ApiClient } from '../api/client.ts';

const PROJECT_ID = 'prj_20260816T101112Z_a1b2c3';

const CREDENTIAL = {
  authorisedBy:
    "GitHub's own OAuth application — the GitHub CLI's — through `gh auth login`, which opens " +
    "GitHub's device authorisation page in your own browser.",
  holder: 'The GitHub CLI. DeFlow never reads, copies or transmits the token.',
  livesIn: "The GitHub CLI's own credential store on this machine.",
  deflowStores: 'DeFlow stores no credential: one row holding this project and the word "github".',
  revoke: {
    // `string | null` rather than the inferred literal: KAR-22.6 made the
    // command nullable, because a service DeFlow was never granted anything by
    // has nothing to revoke, and the fixtures have to be able to say so.
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

const row = (state: StateBody, connected = false) => ({
  id: 'github',
  label: 'GitHub',
  connected,
  connectedAt: connected ? '2026-08-16T10:11:12.000Z' : null,
  state,
  credential: CREDENTIAL,
  authorisation: AUTHORISATION as typeof AUTHORISATION | typeof UNAVAILABLE,
});

/** KAR-22.6 — the Linear row, exactly as the daemon sends it. */
const linearRow = () => ({
  ...row(UNCONNECTABLE),
  id: 'linear',
  label: 'Linear',
  credential: LINEAR_CREDENTIAL,
  authorisation: UNAVAILABLE as typeof AUTHORISATION | typeof UNAVAILABLE,
});

/** KAR-22.6 — the Jira row, which is connectable and therefore ordinary. */
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

const CONNECTED: StateBody = {
  state: 'connected',
  account: 'octocat',
  scopes: ['gist', 'repo'],
  missingScopes: [],
  message: 'Connected as octocat. The token stays in the GitHub CLI’s own credential store.',
  action: null,
};

const MISSING_SCOPE: StateBody = {
  state: 'missing-scope',
  account: 'octocat',
  scopes: ['gist'],
  missingScopes: ['repo'],
  message: 'The credential `gh` holds is missing the repo scope.',
  action: 'gh auth refresh --hostname github.com --scopes repo',
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

const NOT_INSTALLED: StateBody = {
  state: 'not-installed',
  account: null,
  scopes: [],
  missingScopes: ['repo'],
  message: 'The GitHub CLI (`gh`) is not on this machine’s PATH.',
  action: 'Install the GitHub CLI from https://cli.github.com, then reload this page.',
};

interface Recorded {
  readonly posts: string[];
  readonly deletes: string[];
}

/**
 * A client answering the connectors routes and the projects list the screen's
 * header needs, recording what it was asked.
 *
 * Injected rather than `fetch` monkey-patched, because what these specs assert
 * is which request the view made, and the typed client decides that.
 */
function connectorsClient(options: {
  readonly services?: readonly ReturnType<typeof row>[];
}): ApiClient & { readonly recorded: Recorded } {
  const recorded: Recorded = { posts: [], deletes: [] };
  let services = [...(options.services ?? [row(NOT_INSTALLED)])];

  const json = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

  const client = {
    projects: Object.assign(
      { $get: () => json(200, { projects: [] }) },
      {
        ':id': {
          connectors: Object.assign(
            { $get: () => json(200, { services }) },
            {
              ':service': Object.assign(
                {
                  $post: (args: { param: { id: string; service: string } }) => {
                    recorded.posts.push(`${args.param.id}/${args.param.service}`);
                    services = services.map((service) =>
                      service.id === args.param.service
                        ? { ...service, connected: true, connectedAt: '2026-08-16T10:11:12.000Z' }
                        : service,
                    );
                    return json(201, { connector: services[0] });
                  },
                  $delete: (args: { param: { id: string; service: string } }) => {
                    recorded.deletes.push(`${args.param.id}/${args.param.service}`);
                    services = services.map((service) =>
                      service.id === args.param.service
                        ? { ...service, connected: false, connectedAt: null }
                        : service,
                    );
                    return json(200, {
                      service: args.param.service,
                      removed: true,
                      credentialDeleted: false,
                      revoke: CREDENTIAL.revoke,
                      message: 'DeFlow will no longer use GitHub for this project.',
                    });
                  },
                },
                { issues: { $get: () => json(200, { issues: [] }) } },
              ),
            },
          ),
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

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await shell.router.isReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const at = `/projects/${PROJECT_ID}/connectors`;

const connectorRow = (id: string): HTMLElement => {
  const found = shell.container.querySelector<HTMLElement>(`[data-connector-row="${id}"]`);
  if (found === null) throw new Error(`the connectors screen rendered no ${id} row`);
  return found;
};

const githubRow = (): HTMLElement => connectorRow('github');

suite('EPIC-22-S48 — the connectors screen renders each state (AC1)', () => {
  it('shows the state, the sentence and the one command that resolves it', async () => {
    shell = await mountShell({ at, client: connectorsClient({ services: [row(MISSING_SCOPE)] }) });
    await settle();

    const github = githubRow();
    expect(github.dataset.connectorState).toBe('missing-scope');
    expect(github.textContent).toContain('missing the repo scope');
    // The command, in full and copyable — not "grant the missing scope".
    expect(github.textContent).toContain('gh auth refresh --hostname github.com --scopes repo');
  });

  it('says the CLI is missing, and does not tell somebody without gh to run gh', async () => {
    shell = await mountShell({ at, client: connectorsClient({ services: [row(NOT_INSTALLED)] }) });
    await settle();

    expect(githubRow().dataset.connectorState).toBe('not-installed');
    expect(githubRow().textContent).toContain('https://cli.github.com');
  });

  it('names the account and the granted scopes once connected', async () => {
    shell = await mountShell({
      at,
      client: connectorsClient({ services: [row(CONNECTED, true)] }),
    });
    await settle();

    const github = githubRow();
    expect(github.dataset.connectorConnected).toBe('true');
    expect(github.textContent).toContain('octocat');
    expect(github.textContent).toContain('repo');
  });
});

suite('EPIC-22-S68 — there is no token field, and the screen says why (AC1, AC2)', () => {
  it('holds no input, textarea or contenteditable anywhere on the screen', async () => {
    shell = await mountShell({ at, client: connectorsClient({}) });
    await settle();

    // The whole screen, not just the GitHub row: a "paste a token" box added
    // anywhere on this page is the failure this assertion exists for.
    const screen = shell.container.querySelector<HTMLElement>('[data-connectors]');
    expect(screen).not.toBeNull();
    expect(screen?.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });

  it('states whose application authorises, where the token lives and what DeFlow stores', async () => {
    shell = await mountShell({ at, client: connectorsClient({}) });
    await settle();

    const text = githubRow().textContent ?? '';
    expect(text).toContain(CREDENTIAL.authorisedBy);
    expect(text).toContain(CREDENTIAL.holder);
    expect(text).toContain(CREDENTIAL.livesIn);
    expect(text).toContain(CREDENTIAL.deflowStores);
  });

  it('says out loud why connecting is a command rather than a single button', async () => {
    shell = await mountShell({ at, client: connectorsClient({}) });
    await settle();

    const github = githubRow();
    expect(github.textContent).toContain(AUTHORISATION.whyNotOneClick);
    expect(github.textContent).toContain(AUTHORISATION.command);
    // The link goes to GitHub's own authorisation page, which exists.
    const link = github.querySelector<HTMLAnchorElement>('[data-connector-authorise]');
    expect(link?.getAttribute('href')).toBe(AUTHORISATION.url);
  });
});

suite('EPIC-22-S54 — removal says what it did and did not do (AC5)', () => {
  it('sends one delete and renders the operator’s own revocation command', async () => {
    const client = connectorsClient({ services: [row(CONNECTED, true)] });
    shell = await mountShell({ at, client });
    await settle();

    githubRow().querySelector<HTMLElement>('[data-connector-remove]')?.click();
    await settle();

    expect(client.recorded.deletes).toEqual([`${PROJECT_ID}/github`]);
    const screen = shell.container.querySelector<HTMLElement>('[data-connectors]');
    // Honest about what DeFlow did not do — the credential is the operator's.
    expect(screen?.textContent).toContain('gh auth logout --hostname github.com');
    expect(githubRow().dataset.connectorConnected).toBe('false');
  });
});

suite('EPIC-22-S48 — connecting records consent and re-reads the state (AC1)', () => {
  it('sends one post for this project and this service', async () => {
    const client = connectorsClient({ services: [row(CONNECTED)] });
    shell = await mountShell({ at, client });
    await settle();

    githubRow().querySelector<HTMLElement>('[data-connector-connect]')?.click();
    await settle();

    expect(client.recorded.posts).toEqual([`${PROJECT_ID}/github`]);
    expect(githubRow().dataset.connectorConnected).toBe('true');
  });
});

suite('EPIC-22-S70 — three services, one row component (KAR-22.6 AC1)', () => {
  it('renders every service the daemon sent, in the order it sent them', async () => {
    shell = await mountShell({
      at,
      client: connectorsClient({ services: [row(CONNECTED, true), linearRow(), jiraRow()] }),
    });
    await settle();

    const rendered = [...shell.container.querySelectorAll<HTMLElement>('[data-connector-row]')].map(
      (element) => element.dataset.connectorRow,
    );
    // One registry, one loop, one component — a screen that special-cased a
    // service would show a different number here or a different order.
    expect(rendered).toEqual(['github', 'linear', 'jira']);
  });

  it('still holds no input, textarea or contenteditable with three services on it', async () => {
    shell = await mountShell({
      at,
      client: connectorsClient({ services: [row(CONNECTED, true), linearRow(), jiraRow()] }),
    });
    await settle();

    // The token box arrives somewhere nobody was looking, and the likeliest
    // somewhere is the row that has nothing else to offer.
    const screen = shell.container.querySelector<HTMLElement>('[data-connectors]');
    expect(screen?.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });
});

suite('EPIC-22-S70 — a service that cannot be connected offers no button (AC2)', () => {
  it('renders no connect button and no authorisation link on that row', async () => {
    const client = connectorsClient({ services: [linearRow()] });
    shell = await mountShell({ at, client });
    await settle();

    const linear = connectorRow('linear');
    // AC2's whole point: a button that goes nowhere is worse than no button,
    // because it makes the product look finished and the operator look wrong.
    expect(linear.querySelector('[data-connector-connect]')).toBeNull();
    expect(linear.querySelector('[data-connector-authorise]')).toBeNull();
    expect(client.recorded.posts).toEqual([]);
  });

  it('says why there is nothing to press, in the daemon’s own sentence', async () => {
    shell = await mountShell({ at, client: connectorsClient({ services: [linearRow()] }) });
    await settle();

    const text = connectorRow('linear').textContent ?? '';
    expect(text).toContain(UNAVAILABLE.whyNotConnectable);
    // And it still answers the questions every row answers, because an operator
    // deciding whether to wait for this deserves to know what it would mean.
    expect(text).toContain(LINEAR_CREDENTIAL.holder);
    expect(text).toContain(LINEAR_CREDENTIAL.deflowStores);
  });

  it('offers a connect button on the services that can be connected', async () => {
    // Non-vacuity for the assertion above: the absence is about this service,
    // not about the button having been deleted from the screen.
    shell = await mountShell({ at, client: connectorsClient({ services: [jiraRow()] }) });
    await settle();

    expect(connectorRow('jira').querySelector('[data-connector-connect]')).not.toBeNull();
  });
});

suite('EPIC-22-S70 — a service whose authorisation page DeFlow cannot name (AC2)', () => {
  it('shows the command and omits the link rather than inventing a URL', async () => {
    shell = await mountShell({ at, client: connectorsClient({ services: [jiraRow()] }) });
    await settle();

    const jira = connectorRow('jira');
    expect(jira.textContent).toContain('acli jira auth login');
    // `acli --web` opens Atlassian's own consent page and DeFlow is not in that
    // conversation, so it does not know the address and does not guess one.
    expect(jira.querySelector('[data-connector-authorise]')).toBeNull();
  });
});
