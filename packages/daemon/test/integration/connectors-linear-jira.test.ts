/**
 * KAR-22.6 test plan #3, #4, #7 — the second and third services, against a real
 * booted daemon, a real file-backed ledger, real `git init` repositories and
 * real `acli`- and `gh`-shaped binaries on a real `PATH`.
 *
 * Integration for `./connectors-api.test.ts`'s reason: every claim here is
 * about the outside world. "Is `acli` installed", "did DeFlow spawn it", "did
 * DeFlow spawn *anything* for Linear" are questions a mocked `child_process`
 * answers however you taught it to, which is why docs/14-testing-strategy.md
 * §3.3 forbids mocking it and this file writes shell scripts instead.
 *
 * ## The two halves this file exists to keep apart
 *
 * **Jira runs KAR-22.4's whole table over a different binary.** Connect,
 * search, expire, remove — asserted here rather than assumed from GitHub,
 * because "the framework generalises" is the claim KAR-22.4's split was made to
 * stop anybody asserting without evidence.
 *
 * **Linear is asserted to be honestly absent.** DeFlow cannot reach Linear
 * without holding a credential, so the assertions are that the row says so,
 * that connecting is *refused* rather than recorded, and that no child process
 * is spawned on its behalf at all. A button that goes nowhere would pass a
 * screenshot review; it does not pass this.
 *
 * Verifies: EPIC-22-S70, EPIC-22-S71, EPIC-22-S72, EPIC-22-S73 · KAR-22.6
 * AC1–AC4 · test plan #3, #4, #7
 */
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';
import { type FakeCliBin, pathWith, writeFakeCli } from '../support/fake-cli-bin.ts';

const fetch = authorizedFetch();

/** The token the fake `acli` holds. Distinctive so a byte search cannot miss it. */
const STORED_TOKEN = 'atl_KAR226FAKETOKENDONOTSTORETHISANYWHERE';

interface ConnectorRow {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly connectedAt: string | null;
  readonly state: {
    readonly state: string;
    readonly account: string | null;
    readonly scopes: readonly string[];
    readonly missingScopes: readonly string[];
    readonly message: string;
    readonly action: string | null;
  };
  readonly credential: {
    readonly authorisedBy: string;
    readonly holder: string;
    readonly livesIn: string;
    readonly deflowStores: string;
    readonly revoke: { readonly command: string | null; readonly affects: string };
  };
  readonly authorisation:
    | { readonly kind: 'command'; readonly command: string; readonly url: string | null }
    | { readonly kind: 'unavailable'; readonly whyNotConnectable: string };
}

interface Envelope {
  readonly error: { readonly code: string; readonly message: string };
}

const WORK_ITEMS = JSON.stringify([
  {
    key: 'TEAM-41',
    self: 'https://acme.atlassian.net/rest/api/3/issue/10041',
    fields: { summary: 'Retry the flaky worktree reaper', status: { name: 'In Progress' } },
  },
  {
    key: 'TEAM-7',
    self: 'https://acme.atlassian.net/rest/api/3/issue/10007',
    fields: { summary: 'Document the data directory', status: { name: 'Done' } },
  },
]);

/**
 * A fake `acli` that is authorised, searches, and — like the real one — holds a
 * credential of its own in a store beside it.
 *
 * The store is what makes "DeFlow never captures it" falsifiable: without a
 * token on the machine there would be nothing for a byte search to fail to
 * find.
 */
const authorisedAcli = (tmp: string): Promise<FakeCliBin> =>
  writeFakeCli(tmp, 'acli', {
    credentialToken: STORED_TOKEN,
    routes: [
      {
        match: 'jira auth status',
        stdout: 'Logged in to acme.atlassian.net as sam@example.test (API token)\n',
      },
      { match: 'jira workitem search', stdout: WORK_ITEMS },
    ],
  });

/** A fake `gh` that is connected and lists two issues — EPIC-22-S73's other half. */
const authorisedGh = (tmp: string): Promise<FakeCliBin> =>
  writeFakeCli(tmp, 'gh', {
    routes: [
      {
        match: 'api -i user',
        stdout: ['HTTP/2.0 200 OK', 'X-Oauth-Scopes: repo', '', '{"login":"octocat"}', ''].join(
          '\n',
        ),
      },
      {
        match: 'issue list',
        stdout: JSON.stringify([
          {
            number: 41,
            title: 'Retry the flaky worktree reaper',
            state: 'OPEN',
            url: 'https://github.com/acme/checkout/issues/41',
          },
        ]),
      },
    ],
  });

interface Daemon {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

let running: Daemon | null = null;

async function bootAt(dataDir: string): Promise<Daemon> {
  await mkdir(dataDir, { recursive: true });
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  running = { origin: `http://127.0.0.1:${address.port}`, stop: () => booted.shutdown() };
  return running;
}

const originalPath = process.env.PATH;

afterEach(async () => {
  await running?.stop();
  running = null;
  process.env.PATH = originalPath;
});

async function makeProject(origin: string, name: string, path: string): Promise<string> {
  const response = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function connectors(origin: string, projectId: string): Promise<readonly ConnectorRow[]> {
  const response = await fetch(`${origin}/api/projects/${projectId}/connectors`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { services: readonly ConnectorRow[] }).services;
}

const rowFor = async (origin: string, projectId: string, id: string): Promise<ConnectorRow> => {
  const row = (await connectors(origin, projectId)).find((service) => service.id === id);
  if (row === undefined) throw new Error(`the connectors route listed no '${id}' service`);
  return row;
};

const connect = (origin: string, projectId: string, service: string): Promise<Response> =>
  fetch(`${origin}/api/projects/${projectId}/connectors/${service}`, { method: 'POST' });

const disconnect = (origin: string, projectId: string, service: string): Promise<Response> =>
  fetch(`${origin}/api/projects/${projectId}/connectors/${service}`, { method: 'DELETE' });

const searchIssues = (
  origin: string,
  projectId: string,
  service: string,
  q = '',
): Promise<Response> =>
  fetch(
    `${origin}/api/projects/${projectId}/connectors/${service}/issues?q=${encodeURIComponent(q)}`,
  );

suite('EPIC-22-S70 — three rows, one registry (AC1, AC2)', () => {
  it('lists GitHub, Linear and Jira, each naming its own credential holder', async ({ tmp }) => {
    const acli = await authorisedAcli(tmp);
    process.env.PATH = pathWith(acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

    const rows = await connectors(daemon.origin, projectId);
    expect(rows.map((row) => row.id)).toEqual(['github', 'linear', 'jira']);

    // AC2 — every row, connectable or not, answers the four questions. An
    // operator deciding whether to bother deserves the answer before the click.
    for (const row of rows) {
      expect(row.credential.holder.length).toBeGreaterThan(20);
      expect(row.credential.livesIn.length).toBeGreaterThan(20);
      expect(row.credential.deflowStores.toLowerCase()).toContain('no credential');
    }

    expect((await rowFor(daemon.origin, projectId, 'jira')).authorisation.kind).toBe('command');
    expect((await rowFor(daemon.origin, projectId, 'linear')).authorisation.kind).toBe(
      'unavailable',
    );
  });
});

suite('EPIC-22-S71 — Linear says it cannot be connected, and means it (AC2)', () => {
  it('refuses the connect route, writes no row, and spawns nothing at all', async ({ tmp }) => {
    // A fake `acli` is on the PATH throughout, so "nothing was spawned" is a
    // claim about Linear rather than about an empty machine.
    const acli = await authorisedAcli(tmp);
    process.env.PATH = pathWith(acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

    const row = await rowFor(daemon.origin, projectId, 'linear');
    expect(row.connected).toBe(false);
    expect(row.state.state).toBe('not-installed');
    // The sentence, not a euphemism: what is missing is a first-party tool that
    // holds the credential, and DeFlow will not hold it instead.
    expect(row.state.message.toLowerCase()).toContain('credential');
    // No command to run, because there is none that would help.
    expect(row.state.action).toBeNull();
    expect(row.credential.revoke.command).toBeNull();

    // Counted from here, and not from the top of the spec: reading the
    // connectors list probes every service, so Jira legitimately spawns `acli`
    // twice above. What has to be true is narrower and more useful — the two
    // requests that are *about Linear* spawn nothing at all.
    const before = (await acli.invocations()).length;

    const refusedConnect = await connect(daemon.origin, projectId, 'linear');
    expect(refusedConnect.status).toBe(422);
    const envelope = (await refusedConnect.json()) as Envelope;
    expect(envelope.error.code).toBe('connector_unavailable');
    expect(envelope.error.message.toLowerCase()).toContain('credential');

    const refusedIssues = await searchIssues(daemon.origin, projectId, 'linear');
    expect(refusedIssues.status).toBe(409);
    expect(((await refusedIssues.json()) as Envelope).error.code).toBe('connector_not_connected');

    // The assertion that makes all of the above mean something.
    expect((await acli.invocations()).length).toBe(before);

    // Refused rather than recorded: a consent row for a service that can never
    // work is a lie the screen would then have to render. Read last, because
    // reading it probes Jira again.
    expect((await rowFor(daemon.origin, projectId, 'linear')).connected).toBe(false);
  });
});

suite('EPIC-22-S72 — Jira runs KAR-22.4’s whole table over a different binary (AC3, AC4)', () => {
  it('connects, searches with the term acli itself received, and answers in one vocabulary', async ({
    tmp,
  }) => {
    const acli = await authorisedAcli(tmp);
    process.env.PATH = pathWith(acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

    expect((await connect(daemon.origin, projectId, 'jira')).status).toBe(201);

    const row = await rowFor(daemon.origin, projectId, 'jira');
    expect(row.state.state).toBe('connected');
    expect(row.state.account).toBe('sam@example.test');
    expect(row.connected).toBe(true);
    expect(row.connectedAt).not.toBeNull();

    const response = await searchIssues(daemon.origin, projectId, 'jira', 'reaper');
    expect(response.status).toBe(200);
    const { issues } = (await response.json()) as {
      issues: readonly { key: string; title: string; state: string; url: string }[];
    };

    expect(issues).toEqual([
      {
        key: 'TEAM-41',
        title: 'Retry the flaky worktree reaper',
        state: 'in progress',
        url: 'https://acme.atlassian.net/browse/TEAM-41',
      },
      {
        key: 'TEAM-7',
        title: 'Document the data directory',
        state: 'done',
        url: 'https://acme.atlassian.net/browse/TEAM-7',
      },
    ]);

    // The term reached `acli` rather than being filtered on this side: a Jira
    // instance with three hundred work items must not become three hundred rows
    // on the wire.
    const searched = (await acli.invocations()).filter((argv) => argv.includes('workitem search'));
    expect(searched).toHaveLength(1);
    expect(searched[0]).toContain('reaper');
    expect(searched[0]).toContain('--json');

    // And DeFlow never asked `acli` for the credential it holds.
    expect((await acli.invocations()).filter((argv) => argv.includes('auth login'))).toEqual([]);
  });

  it('names an expired credential and refuses the read before a run, as GitHub does', async ({
    tmp,
  }) => {
    const acli = await writeFakeCli(tmp, 'acli', {
      credentialToken: STORED_TOKEN,
      routes: [
        {
          match: 'jira auth status',
          stderr: 'error: request failed with status 401 Unauthorized\n',
          exitCode: 1,
        },
      ],
    });
    process.env.PATH = pathWith(acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));
    await connect(daemon.origin, projectId, 'jira');

    const row = await rowFor(daemon.origin, projectId, 'jira');
    expect(row.state.state).toBe('expired');
    expect(row.state.action).toContain('acli jira auth login');

    const refused = await searchIssues(daemon.origin, projectId, 'jira');
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Envelope).error.code).toBe('connector_unusable');
  });

  it('ends DeFlow’s access on removal — no child runs afterwards, and the command is named', async ({
    tmp,
  }) => {
    const acli = await authorisedAcli(tmp);
    process.env.PATH = pathWith(acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));
    await connect(daemon.origin, projectId, 'jira');
    expect((await searchIssues(daemon.origin, projectId, 'jira')).status).toBe(200);

    const removed = await disconnect(daemon.origin, projectId, 'jira');
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as {
      removed: boolean;
      credentialDeleted: boolean;
      revoke: { command: string | null; affects: string };
    };
    expect(body.removed).toBe(true);
    expect(body.credentialDeleted).toBe(false);
    expect(body.revoke.command).toBe('acli jira auth logout');

    const before = (await acli.invocations()).length;
    const refused = await searchIssues(daemon.origin, projectId, 'jira');
    expect(refused.status).toBe(409);
    expect((await acli.invocations()).length).toBe(before);
  });

  it('reports not-installed on a machine with no acli, and the page still works', async ({
    tmp,
  }) => {
    // A PATH with a `gh` on it and no `acli`: "not installed" has to be about
    // `acli` rather than about an empty PATH.
    const gh = await authorisedGh(tmp);
    process.env.PATH = pathWith(gh);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

    const row = await rowFor(daemon.origin, projectId, 'jira');
    expect(row.state.state).toBe('not-installed');
    expect(row.state.action).toContain('https://developer.atlassian.com/cloud/acli/');
    // The rest of the screen is unaffected: GitHub is still readable.
    expect((await rowFor(daemon.origin, projectId, 'github')).state.state).toBe('connected');
  });
});

suite('EPIC-22-S73 — connectors compose (AC3, AC4, test plan #7)', () => {
  it('serves both services’ issues, each naming its own, and removes them independently', async ({
    tmp,
  }) => {
    const gh = await authorisedGh(tmp);
    const acli = await authorisedAcli(tmp);
    process.env.PATH = pathWith(gh, acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

    expect((await connect(daemon.origin, projectId, 'github')).status).toBe(201);
    expect((await connect(daemon.origin, projectId, 'jira')).status).toBe(201);

    const connectedIds = (await connectors(daemon.origin, projectId))
      .filter((row) => row.connected)
      .map((row) => row.id);
    expect(connectedIds).toEqual(['github', 'jira']);

    // Each route answers for its own service, in the one issue vocabulary —
    // which is what lets the composer merge them and still say where each row
    // came from.
    const fromGithub = (await (await searchIssues(daemon.origin, projectId, 'github')).json()) as {
      issues: readonly { key: string }[];
    };
    const fromJira = (await (await searchIssues(daemon.origin, projectId, 'jira')).json()) as {
      issues: readonly { key: string }[];
    };
    expect(fromGithub.issues.map((issue) => issue.key)).toEqual(['acme/checkout#41']);
    expect(fromJira.issues.map((issue) => issue.key)).toEqual(['TEAM-41', 'TEAM-7']);

    // Removing one leaves the other alone.
    expect((await disconnect(daemon.origin, projectId, 'github')).status).toBe(200);
    expect((await rowFor(daemon.origin, projectId, 'github')).connected).toBe(false);
    expect((await rowFor(daemon.origin, projectId, 'jira')).connected).toBe(true);
    expect((await searchIssues(daemon.origin, projectId, 'jira')).status).toBe(200);

    // And removing the second leaves a project that still works with none.
    expect((await disconnect(daemon.origin, projectId, 'jira')).status).toBe(200);
    expect((await connectors(daemon.origin, projectId)).some((row) => row.connected)).toBe(false);

    const submitted = await fetch(`${daemon.origin}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { kind: 'text', text: 'work with no connector at all' },
        cwd: join(tmp, 'repo'),
        permission: 'worktree',
        projectId,
      }),
    });
    expect(submitted.status).toBe(201);
  });

  it('keeps a second project unconnected to either (AC4)', async ({ tmp }) => {
    const acli = await authorisedAcli(tmp);
    process.env.PATH = pathWith(acli);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'a') });
    await makeRepo({ dir: join(tmp, 'b') });
    const a = await makeProject(daemon.origin, 'a', join(tmp, 'a'));
    const b = await makeProject(daemon.origin, 'b', join(tmp, 'b'));

    await connect(daemon.origin, a, 'jira');

    expect((await rowFor(daemon.origin, a, 'jira')).connected).toBe(true);
    expect((await rowFor(daemon.origin, b, 'jira')).connected).toBe(false);
    expect((await searchIssues(daemon.origin, b, 'jira')).status).toBe(409);
  });
});
