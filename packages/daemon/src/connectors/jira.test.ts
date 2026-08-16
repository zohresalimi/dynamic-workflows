/**
 * KAR-22.6 test plan #6 — `acli`'s state parse and issue parse, as pure
 * functions over what Atlassian's CLI actually printed.
 *
 * A unit spec for `./github.test.ts`'s reason: the outside world here *is* the
 * exit code and the two streams, and those are the input.
 * `packages/daemon/test/integration/connectors-linear-jira.test.ts` is where a
 * real `acli`-shaped binary produces them.
 *
 * ## Why this file is more defensive than `./github.test.ts`
 *
 * `gh api -i user` returns GitHub's own HTTP headers, which are a documented
 * part of GitHub's REST API — the scope check is a fold of two lists and the
 * parse is not guessing. `acli jira auth status` has **no documented
 * machine-readable output**, and `--json`'s exact shape is not specified for
 * `workitem search` either. So the contract this file pins is the one DeFlow
 * can actually keep:
 *
 *  - the exit code decides first, and the message only distinguishes between
 *    failures;
 *  - anything unrecognised is `unreachable` **carrying `acli`'s own sentence**,
 *    never a confident diagnosis that sends an operator to run a command for
 *    nothing;
 *  - the issue parse accepts either plausible `--json` shape and drops any row
 *    it cannot key, because an entry with no reference is an entry that submits
 *    a run against nothing.
 *
 * Verifies: EPIC-22-S72 · KAR-22.6 AC2, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { JIRA, readJiraIssues, readJiraState } from './jira.ts';

const ran = (over: Partial<Parameters<typeof readJiraState>[0]> = {}) =>
  readJiraState({ spawned: true, exitCode: 0, stdout: '', stderr: '', ...over });

suite('KAR-22.6 AC4 — acli is not installed', () => {
  it('reports not-installed, and does not tell somebody without acli to run acli', () => {
    const state = readJiraState({ spawned: false, exitCode: null, stdout: '', stderr: '' });

    expect(state.state).toBe('not-installed');
    expect(state.account).toBeNull();
    expect(state.action).not.toContain('acli jira auth login');
    // The install page Atlassian actually publishes, rather than a package
    // manager incantation nobody checked.
    expect(state.action).toContain('https://developer.atlassian.com/cloud/acli/');
  });
});

suite('KAR-22.6 AC4 — acli is installed and nobody has authorised it', () => {
  it.each([
    'You are not logged in to any Atlassian site. Run `acli jira auth login` to log in.\n',
    'error: no active account\n',
    'Error: not authenticated. Please run acli jira auth login.\n',
  ])('reads %j as not-authorised, and names the login command', (stderr) => {
    const state = ran({ exitCode: 1, stderr });

    expect(state.state).toBe('not-authorised');
    expect(state.action).toBe(
      JIRA.authorisation.kind === 'command' ? JIRA.authorisation.command : '',
    );
  });
});

suite('EPIC-22-S72 — an expired Jira credential says so, as GitHub’s does', () => {
  it.each([
    'error: request failed with status 401 Unauthorized\n',
    'Error: your API token has expired.\n',
    'error: invalid credentials for site acme.atlassian.net\n',
  ])('reads %j as expired rather than as never-authorised', (stderr) => {
    const state = ran({ exitCode: 1, stderr });

    expect(state.state).toBe('expired');
    expect(state.action).toContain('acli jira auth login');
  });
});

suite('KAR-22.6 AC4 — acli said something this parse does not recognise', () => {
  it('reports unreachable and quotes acli rather than guessing', () => {
    const state = ran({ exitCode: 7, stderr: 'error: dial tcp: lookup acme.atlassian.net\n' });

    expect(state.state).toBe('unreachable');
    // `acli`'s own words, because this is the branch where DeFlow genuinely does
    // not know what happened and a paraphrase would be an invention.
    expect(state.message).toContain('dial tcp: lookup acme.atlassian.net');
    expect(state.action).toBeNull();
  });

  it('still says something useful when acli exited silently', () => {
    const state = ran({ exitCode: 3, stderr: '' });

    expect(state.state).toBe('unreachable');
    expect(state.message).toContain('3');
  });
});

suite('EPIC-22-S72 — a working Jira credential', () => {
  it('reports connected, and names the account when acli’s output named one', () => {
    const state = ran({
      stdout: 'Logged in to acme.atlassian.net as sam@example.test (API token)\n',
    });

    expect(state.state).toBe('connected');
    expect(state.account).toBe('sam@example.test');
    expect(state.action).toBeNull();
  });

  it('reports connected with a null account when acli’s output named none', () => {
    const state = ran({ stdout: 'Authenticated.\n' });

    expect(state.state).toBe('connected');
    expect(state.account).toBeNull();
  });

  it('never reports missing-scope, because Atlassian credentials carry no scopes', () => {
    // Recorded as an assertion rather than as a comment: what governs a Jira
    // read is the account's own project permissions, which `acli` reports as an
    // ordinary failure. Declaring a scope DeFlow cannot check would put a name
    // on the screen that nothing on the machine can confirm or deny.
    expect(JIRA.requiredScopes).toEqual([]);
    expect(ran({ stdout: 'Authenticated.\n' }).missingScopes).toEqual([]);
  });
});

suite('EPIC-22-S72 — acli --json, whose shape is not documented', () => {
  const ROWS = [
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
  ];

  const EXPECTED = [
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
  ];

  it('reads a bare array of rows', () => {
    expect(readJiraIssues(JSON.stringify(ROWS))).toEqual(EXPECTED);
  });

  it('reads the REST envelope acli may pass through instead', () => {
    expect(readJiraIssues(JSON.stringify({ issues: ROWS }))).toEqual(EXPECTED);
  });

  it('reads a flattened row, where the fields are not nested', () => {
    const flat = [
      {
        key: 'TEAM-41',
        self: 'https://acme.atlassian.net/rest/api/3/issue/10041',
        summary: 'Retry the flaky worktree reaper',
        status: 'In Progress',
      },
    ];

    expect(readJiraIssues(JSON.stringify(flat))).toEqual([EXPECTED[0]]);
  });

  it('drops a row with no key rather than offering an entry that submits nothing', () => {
    const rows = [{ fields: { summary: 'no key at all', status: { name: 'To Do' } } }, ...ROWS];

    expect(readJiraIssues(JSON.stringify(rows))).toEqual(EXPECTED);
  });

  it('drops a row whose site cannot be derived, for the same reason', () => {
    // Without `self` there is no way to build a browse URL, and a picker entry
    // with no reference is a dead end discovered after the click.
    const rows = [{ key: 'TEAM-9', fields: { summary: 'no self', status: { name: 'To Do' } } }];

    expect(readJiraIssues(JSON.stringify(rows))).toEqual([]);
  });

  it('answers with nothing at all when acli printed something that is not JSON', () => {
    expect(readJiraIssues('acli: unexpected error')).toEqual([]);
    expect(readJiraIssues('')).toEqual([]);
    expect(readJiraIssues('null')).toEqual([]);
  });
});
