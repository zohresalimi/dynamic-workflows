/**
 * KAR-10.1 — resolving `{ kind: 'issue' }` via a fake `gh`, never a real
 * network call (docs/14-testing-strategy.md §3.3).
 *
 * Verifies: KAR-10.1 AC2, AC5 (issue failure), EPIC-10-S4's issue scenarios
 */
import { it, TestClock } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { IssueResolutionFailed, resolveIssue } from '../../src/intake/resolve-issue.ts';
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
