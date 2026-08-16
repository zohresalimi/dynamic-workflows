/**
 * KAR-22.4 — the connectors surface, against a real booted daemon, a real
 * file-backed ledger, real `git init` repositories and a real `gh`-shaped
 * binary on a real `PATH`.
 *
 * Integration rather than unit for the reason KAR-22.1's own API spec gives:
 * every claim here is about the **outside world**. "Is `gh` installed", "did
 * DeFlow spawn it", "is the token anywhere on disk" and "does removing a
 * connector stop the child process happening" are all questions a mocked
 * `child_process` answers however you taught it to — which is why
 * docs/14-testing-strategy.md §3.3 forbids mocking it and this file writes a
 * shell script instead.
 *
 * ## What stands in for GitHub's authorisation server
 *
 * `gh` does. That is not a shortcut, it is the design: DeFlow has no registered
 * OAuth application with GitHub, never speaks to an authorisation server, and
 * reaches GitHub only by spawning the operator's own GitHub CLI. So the thing
 * that holds a credential in these specs is a fake `gh` with a fake credential
 * store next to it, and the interesting assertion is that a distinctive token
 * sitting in that store — and printable by `gh auth token`, exactly as the real
 * one is — never appears in DeFlow's ledger, its logs or its data directory,
 * and that `gh auth token` is never invoked at all.
 *
 * Verifies: EPIC-22-S50, EPIC-22-S52, EPIC-22-S53, EPIC-22-S54, EPIC-22-S55,
 * EPIC-22-S56, EPIC-22-S69 · KAR-22.4 AC1–AC6 · test plan #3, #5, #6, #7, #9
 */
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { execFile } from 'node:child_process';
import { mkdir, readFile, symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';
import { writeFakeGh } from '../support/fake-gh-bin.ts';
import { walk } from './support/walk.ts';

const fetch = authorizedFetch();

/** The token the fake `gh` holds. Distinctive so a byte search cannot miss it. */
const STORED_TOKEN = 'gho_KAR224FAKETOKENDONOTSTORETHISANYWHERE';

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
    readonly revoke: { readonly command: string; readonly affects: string };
  };
  readonly authorisation: {
    readonly command: string;
    readonly url: string;
    readonly whyNotOneClick: string;
  };
}

interface Envelope {
  readonly error: { readonly code: string; readonly message: string };
}

/** `gh api -i user`'s output for a token carrying `scopes`. */
const userResponse = (scopes: string, login = 'octocat'): string =>
  ['HTTP/2.0 200 OK', `X-Oauth-Scopes: ${scopes}`, '', JSON.stringify({ login, id: 1 }), ''].join(
    '\n',
  );

const ISSUES = JSON.stringify([
  {
    number: 41,
    title: 'Retry the flaky worktree reaper',
    state: 'OPEN',
    url: 'https://github.com/acme/checkout/issues/41',
  },
  {
    number: 7,
    title: 'Document the data directory',
    state: 'CLOSED',
    url: 'https://github.com/acme/checkout/issues/7',
  },
]);

/**
 * A fake `gh` that answers the probe with `scopes`, lists two issues, and — like
 * the real one — will print its stored token if anybody runs `gh auth token`.
 *
 * That last route is the point of the fixture. Without it, "DeFlow never
 * captures the token" would be unfalsifiable: there would be no token for it to
 * capture. With it, a future implementation that decided to cache the
 * credential has an obvious way to do so, and this file's assertions notice.
 */
const connectedGh = (scopes = 'gist, repo') => ({
  credentialToken: STORED_TOKEN,
  routes: [
    { match: 'api -i user', stdout: userResponse(scopes) },
    { match: 'issue list', stdout: ISSUES },
    { match: 'auth token', stdout: `${STORED_TOKEN}\n` },
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

/**
 * `PATH` is the test process's own, because `boot()` runs in it and the child
 * inherits it. Restored in `afterEach` so one spec's fake `gh` is not another
 * spec's ambient one.
 */
const originalPath = process.env.PATH;

/**
 * A `PATH` on which there is **no `gh` at all**, and on which `git` still works.
 *
 * Emptying `PATH` would be the obvious way to say "gh is not installed" and it
 * is wrong twice: it also removes `git`, which every project in this file needs,
 * and it would make these specs pass on a machine where `gh` *is* installed for
 * the wrong reason. One directory holding a symlink to the real `git` says
 * exactly what it means.
 */
async function pathWithoutGh(tmp: string): Promise<string> {
  const dir = join(tmp, 'nogh-bin');
  await mkdir(dir, { recursive: true });
  const git = await new Promise<string>((resolve, reject) => {
    execFile('/usr/bin/which', ['git'], (error, stdout) =>
      error === null ? resolve(stdout.trim()) : reject(error),
    );
  });
  await symlink(git, join(dir, 'git'));
  return dir;
}

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

const github = async (origin: string, projectId: string): Promise<ConnectorRow> => {
  const row = (await connectors(origin, projectId)).find((service) => service.id === 'github');
  if (row === undefined) throw new Error('the connectors route listed no github service');
  return row;
};

const connect = (origin: string, projectId: string): Promise<Response> =>
  fetch(`${origin}/api/projects/${projectId}/connectors/github`, { method: 'POST' });

const disconnect = (origin: string, projectId: string): Promise<Response> =>
  fetch(`${origin}/api/projects/${projectId}/connectors/github`, { method: 'DELETE' });

const searchIssues = (origin: string, projectId: string, q = ''): Promise<Response> =>
  fetch(`${origin}/api/projects/${projectId}/connectors/github/issues?q=${encodeURIComponent(q)}`);

suite('EPIC-22-S48, S69 — the connectors screen’s own data (AC1)', () => {
  it('reports not-installed, and says so rather than failing, when there is no gh at all', async ({
    tmp,
  }) => {
    process.env.PATH = await pathWithoutGh(tmp);

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

    const row = await github(daemon.origin, projectId);
    expect(row.state.state).toBe('not-installed');
    expect(row.connected).toBe(false);
    // AC1 — the row still carries the whole credential statement, because an
    // operator deciding whether to install `gh` deserves to know what
    // connecting would actually mean.
    expect(row.credential.holder).toContain('GitHub CLI');
    expect(row.authorisation.url).toBe('https://github.com/login/device');
    expect(row.authorisation.whyNotOneClick).toContain('does not have one');
  });

  it('reports connected, with the account and the scopes gh’s own headers carried', async ({
    tmp,
  }) => {
    const fake = await writeFakeGh(tmp, connectedGh('gist, repo'));
    process.env.PATH = fake.pathEnv;

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));
    expect((await connect(daemon.origin, projectId)).status).toBe(201);

    const row = await github(daemon.origin, projectId);
    expect(row.state.state).toBe('connected');
    expect(row.state.account).toBe('octocat');
    expect(row.state.scopes).toEqual(['gist', 'repo']);
    expect(row.connected).toBe(true);
    expect(row.connectedAt).not.toBeNull();
  });
});

suite('EPIC-22-S50 — the token is nowhere DeFlow can be inspected (AC2)', () => {
  it('leaves no byte of it in the ledger, in any log line or anywhere in the data directory', async ({
    tmp,
  }) => {
    const fake = await writeFakeGh(tmp, connectedGh());
    process.env.PATH = fake.pathEnv;

    // Every byte the daemon writes to stdout for the duration, which is where
    // pino writes (`../../src/logging.ts` configures no transport).
    const logged: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;

    const dataDir = join(tmp, 'data');
    try {
      const daemon = await bootAt(dataDir);
      await makeRepo({ dir: join(tmp, 'repo') });
      const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));

      // The whole path an operator walks: connect, look at the screen, search.
      expect((await connect(daemon.origin, projectId)).status).toBe(201);
      await github(daemon.origin, projectId);
      expect((await searchIssues(daemon.origin, projectId, 'reaper')).status).toBe(200);
    } finally {
      process.stdout.write = realWrite;
    }

    // The token is genuinely on this machine, in `gh`'s own store — so this
    // search is looking for something that exists.
    const store = await readFile(fake.credentialStore, 'utf8');
    expect(store).toContain(STORED_TOKEN);

    // Every file, not a file somebody remembered to name: the ledger, the WAL,
    // the lock, the daemon file and anything a later story adds beside them.
    const files = await walk(dataDir);
    expect(files.length).toBeGreaterThan(0);
    for (const relativePath of files) {
      const bytes = await readFile(join(dataDir, relativePath));
      expect(
        bytes.includes(STORED_TOKEN),
        `${relativePath} contains the token gh holds — DeFlow must never store it`,
      ).toBe(false);
    }
    expect(logged.join('')).not.toContain(STORED_TOKEN);

    // And the reason it is nowhere: DeFlow never asked for it. `gh auth token`
    // was available the whole time and was not run.
    const invocations = await fake.invocations();
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.filter((argv) => argv.includes('auth'))).toEqual([]);
  });
});

suite('EPIC-22-S52, S53 — a connector that cannot work says which, before a run (AC4)', () => {
  it('names expiry, and refuses an issue read rather than failing during framing', async ({
    tmp,
  }) => {
    const fake = await writeFakeGh(tmp, {
      credentialToken: STORED_TOKEN,
      routes: [
        { match: 'api -i user', stderr: 'gh: Bad credentials (HTTP 401)\n', exitCode: 1 },
        { match: 'issue list', stderr: 'gh: Bad credentials (HTTP 401)\n', exitCode: 1 },
      ],
    });
    process.env.PATH = fake.pathEnv;

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));
    await connect(daemon.origin, projectId);

    const row = await github(daemon.origin, projectId);
    expect(row.state.state).toBe('expired');
    expect(row.state.action).toContain('gh auth login');

    // AC4 — the refusal arrives at the *ask*, not an hour into a run.
    const refused = await searchIssues(daemon.origin, projectId);
    expect(refused.status).toBe(422);
    const envelope = (await refused.json()) as Envelope;
    expect(envelope.error.code).toBe('connector_unusable');
    expect(envelope.error.message).toContain('no longer accepted');
  });

  it('names the missing scope by name, and the command that grants it', async ({ tmp }) => {
    const fake = await writeFakeGh(tmp, connectedGh('gist, read:org'));
    process.env.PATH = fake.pathEnv;

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));
    await connect(daemon.origin, projectId);

    const row = await github(daemon.origin, projectId);
    expect(row.state.state).toBe('missing-scope');
    expect(row.state.missingScopes).toEqual(['repo']);
    // "insufficient permissions" is not a diagnosis; this is.
    expect(row.state.action).toBe('gh auth refresh --hostname github.com --scopes repo');

    const refused = await searchIssues(daemon.origin, projectId);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as Envelope).error.message).toContain('repo');
  });
});

suite('EPIC-22-S51 — a connected project’s issues, in one vocabulary (AC3)', () => {
  it('answers with key, title and state, and asked gh for this project’s own repository', async ({
    tmp,
  }) => {
    const fake = await writeFakeGh(tmp, connectedGh());
    process.env.PATH = fake.pathEnv;

    const daemon = await bootAt(join(tmp, 'data'));
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const projectId = await makeProject(daemon.origin, 'checkout', repo);
    await connect(daemon.origin, projectId);

    const response = await searchIssues(daemon.origin, projectId, 'reaper');
    expect(response.status).toBe(200);
    const { issues } = (await response.json()) as {
      issues: readonly { key: string; title: string; state: string; url: string }[];
    };

    expect(issues).toEqual([
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
    ]);

    // The search term reached `gh` rather than being filtered in DeFlow: a
    // repository with three hundred issues must not become three hundred rows
    // on the wire.
    const listed = (await fake.invocations()).filter((argv) => argv.includes('issue list'));
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('reaper');
  });
});

suite('EPIC-22-S55 — connectors are per project (AC5, test plan #9)', () => {
  it('leaves a second project unconnected, and refuses its issue read', async ({ tmp }) => {
    const fake = await writeFakeGh(tmp, connectedGh());
    process.env.PATH = fake.pathEnv;

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'a') });
    await makeRepo({ dir: join(tmp, 'b') });
    const a = await makeProject(daemon.origin, 'a', join(tmp, 'a'));
    const b = await makeProject(daemon.origin, 'b', join(tmp, 'b'));

    await connect(daemon.origin, a);

    expect((await github(daemon.origin, a)).connected).toBe(true);
    expect((await github(daemon.origin, b)).connected).toBe(false);

    const refused = await searchIssues(daemon.origin, b);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as Envelope).error.code).toBe('connector_not_connected');
  });
});

suite('EPIC-22-S54 — removal ends DeFlow’s access rather than hiding it (AC5)', () => {
  it('spawns nothing at all afterwards, and names the operator’s own revocation command', async ({
    tmp,
  }) => {
    const fake = await writeFakeGh(tmp, connectedGh());
    process.env.PATH = fake.pathEnv;

    const daemon = await bootAt(join(tmp, 'data'));
    await makeRepo({ dir: join(tmp, 'repo') });
    const projectId = await makeProject(daemon.origin, 'checkout', join(tmp, 'repo'));
    await connect(daemon.origin, projectId);
    expect((await searchIssues(daemon.origin, projectId)).status).toBe(200);

    const removed = await disconnect(daemon.origin, projectId);
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as {
      removed: boolean;
      credentialDeleted: boolean;
      revoke: { command: string; affects: string };
    };
    expect(body.removed).toBe(true);
    // Honest about what DeFlow did *not* do: the credential is the operator's.
    expect(body.credentialDeleted).toBe(false);
    expect(body.revoke.command).toBe('gh auth logout --hostname github.com');
    expect(body.revoke.affects).toContain('anything else on this machine');

    const before = (await fake.invocations()).length;
    const refused = await searchIssues(daemon.origin, projectId);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as Envelope).error.code).toBe('connector_not_connected');

    // The assertion that makes "removed" mean something: no child process ran.
    expect((await fake.invocations()).length).toBe(before);
  });
});

suite('EPIC-22-S56 — no connector is required (AC6, test plan #7)', () => {
  it('creates a project, submits a pasted issue reference and lists runs with no gh present', async ({
    tmp,
  }) => {
    // No `gh` anywhere: the zero-config machine EPIC-22 has to keep working.
    process.env.PATH = await pathWithoutGh(tmp);

    const daemon = await bootAt(join(tmp, 'data'));
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const projectId = await makeProject(daemon.origin, 'checkout', repo);

    // KAR-22.2's paste path, unchanged and unconnected.
    const submitted = await fetch(`${daemon.origin}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { kind: 'text', text: 'work with no connector at all' },
        cwd: repo,
        permission: 'worktree',
        projectId,
      }),
    });
    expect(submitted.status).toBe(201);

    const runs = await fetch(`${daemon.origin}/api/projects/${projectId}/runs`);
    expect(runs.status).toBe(200);
    expect(((await runs.json()) as { runs: readonly unknown[] }).runs).toHaveLength(1);

    // And the screen is reachable and honest rather than absent or broken.
    expect((await github(daemon.origin, projectId)).connected).toBe(false);
  });
});
