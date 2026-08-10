/**
 * KAR-15.6 AC6 — `GET /api/runs/:id/diff`: the change a run has made, as
 * `text/x-patch`.
 *
 * Integration, against a **real** repository, because the assertion that
 * matters is not "the response looks like a diff" but *"git accepts it"*: the
 * failure this test exists to catch is a patch assembled by string
 * concatenation, which renders convincingly and applies to nothing. So the
 * response is handed back to `git apply --check` in a clone of the same base,
 * and git decides.
 *
 * Verifies: KAR-15.6 AC6 · test plan #7
 */
import type { RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type Db, type EventDraft, openLedger } from '@DeFlow/ledger';
import { authorizedFetch, git, it, makeRepo, TEST_DAEMON_TOKEN, tryGit } from '@DeFlow/testkit';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260810T121500Z_ac1560');
const NODE = NodeIdSchema.parse('n-impl');
const T0 = 1_754_812_800_000;

interface Served {
  readonly origin: string;
  readonly db: Db;
  readonly repo: string;
  close(): Promise<void>;
}

/**
 * A real repository with one committed file, then an uncommitted edit and one
 * new file — the state a node leaves its worktree in mid-run.
 */
async function serveRepoRun(tmp: string): Promise<Served> {
  const repo = join(tmp, 'repo');
  await makeRepo({ dir: repo });
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await git(repo, ['add', 'a.txt']);
  await git(repo, ['commit', '-m', 'base']);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();

  await writeFile(join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  await writeFile(join(repo, 'b.txt'), 'a brand new file\n');

  const db = openLedger(tmp);
  const draft = (kind: string, payload: unknown, over: Partial<EventDraft> = {}): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload, ...over }) as EventDraft;

  appendEvents(db, [
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'change one line',
        scope: { included: [] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'the diff is applicable' }],
        knownFailureModes: [],
        approvedBy: null,
        specHash: `sha256-${'4'.repeat(64)}`,
      },
      cwd: repo,
      repo: { head, branch: 'main' },
    }),
    draft('node.scheduled', {
      node: NODE,
      provider: 'claude',
      permission: 'worktree',
      worktree: repo,
    }),
  ]);

  const view = openLedgerView(tmp);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    repo,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('the run diff (AC6, test plan #7)', () => {
  it('returns text/x-patch that git apply --check accepts', async ({ tmp }) => {
    served = await serveRepoRun(tmp);
    const target = served;

    const response = await fetch(`${target.origin}/api/runs/${RUN}/diff?cumulative=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/x-patch');

    const patch = await response.text();
    expect(patch).toContain('diff --git a/a.txt b/a.txt');
    expect(patch).toContain('+TWO');
    expect(patch).toContain('b.txt');

    // The assertion the whole endpoint exists for: git, not a regex, decides
    // whether this is a patch. A clean checkout of the same base plus this
    // patch must be exactly the worktree the run produced.
    const clean = join(tmp, 'clean');
    await git(tmp, ['clone', target.repo, clean]);
    await git(clean, ['checkout', '--detach', 'HEAD']);
    await writeFile(join(clean, 'the-patch.diff'), patch);
    const check = await tryGit(clean, ['apply', '--check', 'the-patch.diff']);
    expect(check.exitCode, check.stderr).toBe(0);
  });

  it('scopes the diff to one node’s worktree', async ({ tmp }) => {
    served = await serveRepoRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/diff?node=${NODE}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('diff --git a/a.txt b/a.txt');
  });

  it('refuses a request that names no selector, and one that names two', async ({ tmp }) => {
    served = await serveRepoRun(tmp);

    for (const query of ['', '?node=n-impl&cumulative=1']) {
      const response = await fetch(`${served.origin}/api/runs/${RUN}/diff${query}`);
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code, query).toBe(
        'invalid_request',
      );
    }
  });

  it('refuses a worktree this run never held', async ({ tmp }) => {
    served = await serveRepoRun(tmp);

    // The daemon is bearer-token protected and the agents it spawned are
    // inside that boundary: a diff endpoint that ran `git -C <anything>` would
    // be a repository reader with a different name.
    const response = await fetch(
      `${served.origin}/api/runs/${RUN}/diff?worktree=${encodeURIComponent('/etc')}`,
    );
    expect(response.status).toBe(400);
  });

  it('answers node_not_found for a node this run does not have', async ({ tmp }) => {
    served = await serveRepoRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/diff?node=n-nope`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'node_not_found',
    );
  });
});
