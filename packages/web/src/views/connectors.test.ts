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
 * Verifies: EPIC-22-S48, EPIC-22-S68 · KAR-22.4 AC1, AC2, AC5
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
    command: 'gh auth logout --hostname github.com',
    affects: 'It also signs out anything else on this machine that uses `gh`.',
  },
};

const AUTHORISATION = {
  command: 'gh auth login --hostname github.com --web --scopes repo',
  url: 'https://github.com/login/device',
  whyNotOneClick:
    'Connecting takes one command rather than one button because DeFlow does not have a ' +
    'registered OAuth application with GitHub.',
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
  authorisation: AUTHORISATION,
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

const githubRow = (): HTMLElement => {
  const found = shell.container.querySelector<HTMLElement>('[data-connector-row="github"]');
  if (found === null) throw new Error('the connectors screen rendered no GitHub row');
  return found;
};

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
