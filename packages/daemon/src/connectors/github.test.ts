/**
 * KAR-22.4 test plan #8 — the state parse, as a pure function over what `gh`
 * actually printed.
 *
 * A unit spec and not an integration one because there is nothing about the
 * outside world in it: the outside world is `gh`'s exit code and its two
 * streams, and those are the *input*. `packages/daemon/test/integration/
 * connectors-api.test.ts` is where a real `gh`-shaped binary produces them.
 *
 * The reason this function exists at all is AC4's second half. "Insufficient
 * permissions" is not a diagnosis, and neither is "authentication failed" when
 * the truth is that the laptop is on a train. Six states, each with a sentence
 * and at most one command, and the parse is what keeps them apart.
 *
 * Verifies: EPIC-22-S52, EPIC-22-S53 · KAR-22.4 AC1, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { GITHUB, readGithubIssues, readGithubState } from './github.ts';

/** `gh api -i user`'s shape on success: headers, a blank line, then the body. */
function ghSuccess(scopes: string, login = 'octocat'): string {
  return [
    'HTTP/2.0 200 OK',
    'Content-Type: application/json; charset=utf-8',
    `X-Oauth-Scopes: ${scopes}`,
    'X-Accepted-Oauth-Scopes: ',
    '',
    JSON.stringify({ login, id: 583231 }),
    '',
  ].join('\n');
}

const ran = (over: Partial<Parameters<typeof readGithubState>[0]> = {}) =>
  readGithubState({ spawned: true, exitCode: 0, stdout: '', stderr: '', ...over });

suite('KAR-22.4 AC1 — gh is not installed', () => {
  it('reports not-installed rather than not-authorised, and names the install page', () => {
    const state = readGithubState({ spawned: false, exitCode: null, stdout: '', stderr: '' });

    expect(state.state).toBe('not-installed');
    expect(state.account).toBeNull();
    // The distinction matters: `gh auth login` cannot be run by somebody who
    // has no `gh`, and telling them to run it is a dead end.
    expect(state.action).not.toContain('gh auth login');
    expect(state.message).toContain('GitHub CLI');
  });
});

suite('KAR-22.4 AC1, AC4 — gh is installed but nobody has authorised it', () => {
  it('reports not-authorised and names the one command that fixes it', () => {
    const state = ran({
      exitCode: 4,
      stderr:
        'To get started with GitHub CLI, please run:  gh auth login\n' +
        'Alternatively, populate the GH_TOKEN environment variable with a GitHub API ' +
        'authentication token.\n',
    });

    expect(state.state).toBe('not-authorised');
    expect(state.action).toBe(GITHUB.authorisation.command);
  });
});

suite('EPIC-22-S52 — an expired token says so', () => {
  it('reads gh’s own 401 as expired, not as never-authorised', () => {
    const state = ran({ exitCode: 1, stderr: 'gh: Bad credentials (HTTP 401)\n' });

    expect(state.state).toBe('expired');
    // AC4 — *which*, and what to do. An operator whose token was revoked in a
    // browser tab three weeks ago needs to be told to log in again, not told
    // that authentication failed.
    expect(state.message).toContain('no longer accepted');
    expect(state.action).toBe(GITHUB.authorisation.command);
  });
});

suite('KAR-22.4 AC1 — gh ran and could not reach GitHub', () => {
  it('reports unreachable rather than blaming the credential', () => {
    const state = ran({
      exitCode: 1,
      stderr: 'error connecting to api.github.com\ncheck your internet connection\n',
    });

    expect(state.state).toBe('unreachable');
    // gh's own words are carried through rather than paraphrased: this is the
    // one state where DeFlow genuinely does not know what happened.
    expect(state.message).toContain('error connecting to api.github.com');
    expect(state.action).toBeNull();
  });
});

suite('EPIC-22-S53 — a missing scope names the scope', () => {
  it('names the scope by name and the command that grants it', () => {
    const state = ran({ stdout: ghSuccess('gist, read:org') });

    expect(state.state).toBe('missing-scope');
    expect(state.missingScopes).toEqual(['repo']);
    expect(state.message).toContain('repo');
    // The exact command, with the scope in it — not "grant the missing scope".
    expect(state.action).toBe('gh auth refresh --hostname github.com --scopes repo');
    // The account is still known: the token works, it is just too narrow.
    expect(state.account).toBe('octocat');
  });
});

suite('KAR-22.4 AC1 — connected', () => {
  it('reads the account and the granted scopes off gh’s own response headers', () => {
    const state = ran({ stdout: ghSuccess('gist, read:org, repo', 'hubot') });

    expect(state.state).toBe('connected');
    expect(state.account).toBe('hubot');
    expect(state.scopes).toEqual(['gist', 'read:org', 'repo']);
    expect(state.missingScopes).toEqual([]);
    expect(state.action).toBeNull();
  });

  it('accepts the header in any casing, because Go canonicalises it and GitHub does not', () => {
    const lower = ran({ stdout: 'HTTP/2.0 200 OK\nx-oauth-scopes: repo\n\n{"login":"a"}\n' });
    expect(lower.state).toBe('connected');
    expect(lower.scopes).toEqual(['repo']);
  });

  it('does not read a scope out of the body, only out of the headers', () => {
    // A repository *named* "repo" in the body must not satisfy the scope check.
    const state = ran({
      stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: gist\n\n{"login":"a","company":"repo"}\n',
    });
    expect(state.state).toBe('missing-scope');
  });
});

suite('KAR-22.4 AC2 — the registry carries the credential statement, not the credential', () => {
  it('states whose application authorises, where the token lives and who holds it', () => {
    // ADR-0003's amendment of 2026-08-16 in the type system: a service cannot
    // be registered without answering these, which is KAR-22.6 test 4's whole
    // point — the second and third services inherit the obligation.
    expect(GITHUB.credential.authorisedBy).toContain('gh auth login');
    expect(GITHUB.credential.holder).toContain('GitHub CLI');
    expect(GITHUB.credential.livesIn).toContain('gh');
    expect(GITHUB.credential.deflowStores).toContain('no');
  });

  it('the state a connector reports carries no credential material of any kind', () => {
    const state = ran({ stdout: ghSuccess('repo') });
    // Every field, serialised — there is no token to leak because there is no
    // token, and this asserts the *shape* rather than trusting the reading.
    expect(Object.keys(state).sort()).toEqual([
      'account',
      'action',
      'message',
      'missingScopes',
      'scopes',
      'state',
    ]);
  });
});

suite('KAR-22.4 AC3 — gh issue list’s rows become the one issue vocabulary', () => {
  const rows = JSON.stringify([
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

  it('shows key, title and state, with the key derived from GitHub’s own url', () => {
    expect(readGithubIssues(rows)).toEqual([
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
  });

  it('skips a row it cannot key, rather than offering a half-blank entry', () => {
    // A picker that lists an entry with no reference is a picker that submits a
    // run against nothing.
    const partial = JSON.stringify([{ title: 'no number', state: 'OPEN' }, { number: 3 }]);
    expect(readGithubIssues(partial)).toEqual([]);
  });

  it('answers with nothing at all for output that is not the JSON gh promised', () => {
    expect(readGithubIssues('not json')).toEqual([]);
    expect(readGithubIssues('{"issues":[]}')).toEqual([]);
  });
});
