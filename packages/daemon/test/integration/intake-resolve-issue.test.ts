/**
 * KAR-10.1 — resolving `{ kind: 'issue' }` via a fake `gh`, never a real
 * network call (docs/14-testing-strategy.md §3.3).
 *
 * Verifies: KAR-10.1 AC2, AC5 (issue failure), EPIC-10-S4's issue scenarios
 */
import { it, TestClock } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { IssueResolutionFailed, resolveIssue } from '../../src/intake/resolve-issue.ts';
import { writeFakeCli } from '../support/fake-cli-bin.ts';
import { writeFakeGh } from '../support/fake-gh-bin.ts';

const URL = 'https://github.com/acme/web/issues/412';

suite('resolveIssue — success', () => {
  it('returns the raw REST body, httpStatus 200 and the resolver name', async ({ tmp }) => {
    const body = JSON.stringify({ title: 'Fix the flaky checkout test', number: 412 });
    const gh = await writeFakeGh(tmp, { stdout: body });

    const result = await resolveIssue(URL, { clock: new TestClock(), env: { PATH: gh.pathEnv } });

    expect(result).toEqual({ raw: body, httpStatus: 200, resolver: 'gh' });
  });

  it('calls gh api against the REST endpoint for the owner/repo/number in the URL', async ({
    tmp,
  }) => {
    const gh = await writeFakeGh(tmp);
    await resolveIssue(URL, { clock: new TestClock(), env: { PATH: gh.pathEnv } });

    expect(await gh.invocations()).toEqual(['api repos/acme/web/issues/412']);
  });
});

suite('resolveIssue — failure (AC5, EPIC-10-S4)', () => {
  it('throws IssueResolutionFailed naming the URL and resolver on a 404', async ({ tmp }) => {
    const gh = await writeFakeGh(tmp, { stderr: 'gh: Not Found (HTTP 404)' });

    const thrown = await resolveIssue(URL, {
      clock: new TestClock(),
      env: { PATH: gh.pathEnv },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(IssueResolutionFailed);
    const error = thrown as IssueResolutionFailed;
    expect(error.url).toBe(URL);
    expect(error.resolver).toBe('gh');
    expect(error.message).toContain(URL);
    expect(error.message).toContain('HTTP 404');
    // AC5's "may paste the issue text instead" — the operator's next move,
    // one message away.
    expect(error.message).toContain("kind: 'text'");
  });

  it('throws when the network is unavailable, naming the URL and resolver', async ({ tmp }) => {
    const gh = await writeFakeGh(tmp, {
      stderr: 'gh: connect: Could not resolve host: api.github.com',
    });

    const thrown = await resolveIssue(URL, {
      clock: new TestClock(),
      env: { PATH: gh.pathEnv },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(IssueResolutionFailed);
    expect((thrown as IssueResolutionFailed).message).toContain(URL);
    expect((thrown as IssueResolutionFailed).message).toContain('resolve host');
  });

  it('refuses a URL it does not recognise, without spawning gh', async ({ tmp }) => {
    const gh = await writeFakeGh(tmp);

    const thrown = await resolveIssue('https://gitlab.com/acme/web/issues/1', {
      clock: new TestClock(),
      env: { PATH: gh.pathEnv },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(IssueResolutionFailed);
    expect(await gh.invocations()).toEqual([]);
  });
});

/**
 * KAR-22.6 test plan #8 — a Jira work-item URL, resolved through Atlassian's own
 * `acli` at the same one spawn chokepoint `gh` uses.
 *
 * The reason this exists is a defect KAR-22.6 would otherwise have shipped.
 * KAR-22.4's composer writes the picked issue's reference into the box; intake
 * resolved `https://github.com/…/issues/<n>` and nothing else; so every Jira
 * entry in the list would have been an entry that submits a run intake then
 * refuses — a dead end discovered *after* the click, which is worse than no
 * picker at all.
 *
 * Verifies: EPIC-22-S74 · KAR-22.6 AC5
 */
const JIRA_URL = 'https://acme.atlassian.net/browse/TEAM-41';

suite('EPIC-22-S74 — a Jira work item picked from the list submits (AC5)', () => {
  it('resolves the browse URL through acli and reports its own resolver name', async ({ tmp }) => {
    const body = JSON.stringify({
      key: 'TEAM-41',
      fields: { summary: 'Retry the flaky worktree reaper' },
    });
    const acli = await writeFakeCli(tmp, 'acli', { stdout: body });

    const result = await resolveIssue(JIRA_URL, {
      clock: new TestClock(),
      env: { PATH: acli.pathEnv },
    });

    expect(result).toEqual({ raw: body, httpStatus: 200, resolver: 'acli' });
  });

  it('asks acli for the key in the URL, in JSON, and nothing else', async ({ tmp }) => {
    const acli = await writeFakeCli(tmp, 'acli', { stdout: '{}' });

    await resolveIssue(JIRA_URL, { clock: new TestClock(), env: { PATH: acli.pathEnv } });

    expect(await acli.invocations()).toEqual(['jira workitem view TEAM-41 --json']);
  });

  it('refuses in intake’s own sentence when acli is not installed', async ({ tmp }) => {
    // A PATH with a `gh` on it and no `acli`: the refusal has to be about the
    // binary this URL needs, not about an empty machine.
    const gh = await writeFakeGh(tmp);

    const thrown = await resolveIssue(JIRA_URL, {
      clock: new TestClock(),
      env: { PATH: gh.pathEnv },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(IssueResolutionFailed);
    const error = thrown as IssueResolutionFailed;
    expect(error.resolver).toBe('acli');
    expect(error.message).toContain(JIRA_URL);
    // The operator's next move, one message away — unchanged from KAR-10.1.
    expect(error.message).toContain("kind: 'text'");
    expect(await gh.invocations()).toEqual([]);
  });

  it('carries acli’s own words when acli refused the work item', async ({ tmp }) => {
    const acli = await writeFakeCli(tmp, 'acli', {
      stderr: 'error: work item TEAM-41 not found or you do not have permission to view it\n',
    });

    const thrown = await resolveIssue(JIRA_URL, {
      clock: new TestClock(),
      env: { PATH: acli.pathEnv },
    }).catch((error: unknown) => error);

    expect((thrown as IssueResolutionFailed).message).toContain('do not have permission');
  });

  it('still refuses a URL no resolver recognises, without spawning anything', async ({ tmp }) => {
    const acli = await writeFakeCli(tmp, 'acli');

    const thrown = await resolveIssue('https://acme.atlassian.net/jira/software/board/1', {
      clock: new TestClock(),
      env: { PATH: acli.pathEnv },
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(IssueResolutionFailed);
    expect(await acli.invocations()).toEqual([]);
  });
});
