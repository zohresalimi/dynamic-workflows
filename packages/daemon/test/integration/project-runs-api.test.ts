/**
 * KAR-22.3 — a project's run history, against a real booted daemon and a real
 * file-backed ledger.
 *
 * Integration rather than unit for the reason `./projects-api.test.ts` gives:
 * every claim here is about **durable state and the outside world**. "Is this
 * history still there after a restart", "does a project whose directory was
 * deleted still remember what ran in it", and "is a run that belongs to no
 * project still reachable" are all questions an in-memory fake answers however
 * you taught it to.
 *
 * The endpoint under test is `GET /api/projects/:id/runs`, and its whole reason
 * for existing is the red in KAR-22.3's test plan row 6: *"history is the global
 * run list filtered client-side, and a project with three runs among three
 * hundred cannot be read"*. So the assertions below are about what the **server**
 * returned, not about what a page could have sieved out of `GET /api/runs`.
 *
 * Verifies: EPIC-22-S39, EPIC-22-S40, EPIC-22-S45, EPIC-22-S47 ·
 * KAR-22.3 AC4, AC5 · test plan #6, #7
 */
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

interface HistoryRow {
  readonly runId: string;
  readonly status: string;
  readonly label: string;
  readonly title: string;
  readonly createdAt: string;
  readonly cost: { readonly run: { readonly costUsd: unknown } };
}

interface HistoryBody {
  readonly runs: readonly HistoryRow[];
}

interface Envelope {
  readonly error: { readonly code: string; readonly message: string };
}

async function bootAt(dataDir: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  await mkdir(dataDir, { recursive: true });
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => booted.shutdown() };
}

async function createProject(origin: string, name: string, path: string): Promise<string> {
  const response = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

/** One text run, with or without a project. Returns the run id. */
async function submitRun(
  origin: string,
  cwd: string,
  text: string,
  projectId?: string,
): Promise<string> {
  const response = await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { kind: 'text', text },
      cwd,
      permission: 'worktree',
      ...(projectId === undefined ? {} : { projectId }),
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { runId: string }).runId;
}

async function history(origin: string, projectId: string): Promise<readonly HistoryRow[]> {
  const response = await fetch(`${origin}/api/projects/${projectId}/runs`);
  expect(response.status).toBe(200);
  return ((await response.json()) as HistoryBody).runs;
}

suite('EPIC-22-S39 — run history for the project, newest first', () => {
  it("lists exactly this project's three runs, with outcome, time, cost and task", async ({
    tmp,
  }) => {
    const mine = await makeRepo({ dir: join(tmp, 'mine') });
    const other = await makeRepo({ dir: join(tmp, 'other') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const projectId = await createProject(daemon.origin, 'mine', mine.dir);
      const otherId = await createProject(daemon.origin, 'other', other.dir);

      const first = await submitRun(daemon.origin, mine.dir, 'migrate the login view', projectId);
      const second = await submitRun(daemon.origin, mine.dir, 'add a smoke test', projectId);
      const third = await submitRun(daemon.origin, mine.dir, 'tidy the imports', projectId);
      const elsewhere = await submitRun(daemon.origin, other.dir, 'not mine', otherId);

      const runs = await history(daemon.origin, projectId);

      // Newest first, and exactly three: the fourth run belongs to another
      // project and a history that showed it would make "which project is this"
      // unanswerable from the page.
      expect(runs.map((run) => run.runId)).toEqual([third, second, first]);
      expect(runs.map((run) => run.runId)).not.toContain(elsewhere);

      const newest = runs[0];
      // The outcome, in both the form a client branches on and the sentence
      // every surface prints (`runStatusLabel`, KAR-19.1 AC6).
      expect(newest?.status).toBe('created');
      expect(newest?.label).toBe('submitted — waiting to be framed');
      // When it ran.
      expect(Date.parse(newest?.createdAt ?? '')).not.toBeNaN();
      // What it was given — the operator's own words, off `task.submitted`.
      expect(newest?.title).toBe('tidy the imports');
      // What it cost, passed through whole rather than flattened to a number.
      // The whole `BudgetRollup`, not a flattened number: subscription quota
      // and real currency are two substances (`./run-summary.ts`), and an
      // unmeasurable provider contributes `null` rather than `0`.
      expect(newest?.cost.run).toHaveProperty('costUsd');
    } finally {
      await daemon.stop();
    }
  });

  it('answers 404 for a project this daemon does not hold', async ({ tmp }) => {
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await fetch(
        `${daemon.origin}/api/projects/prj_20260101T000000Z_ffffff/runs`,
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as Envelope).error.code).toBe('project_not_found');
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S40 — history survives a daemon restart', () => {
  it('reads the same three runs back from a fresh daemon over the same data directory', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const first = await bootAt(dataDir);
    let projectId = '';
    let before: readonly HistoryRow[] = [];
    try {
      projectId = await createProject(first.origin, 'checkout', repo.dir);
      await submitRun(first.origin, repo.dir, 'one', projectId);
      await submitRun(first.origin, repo.dir, 'two', projectId);
      await submitRun(first.origin, repo.dir, 'three', projectId);
      before = await history(first.origin, projectId);
      expect(before).toHaveLength(3);
    } finally {
      await first.stop();
    }

    const second = await bootAt(dataDir);
    try {
      // Identical, not merely non-empty: history that lived in the tab would be
      // empty here, and history rebuilt from a different source would reorder.
      expect(await history(second.origin, projectId)).toEqual(before);
    } finally {
      await second.stop();
    }
  });
});

suite('EPIC-22-S45 — a project whose path has gone still shows its history', () => {
  it('lists both runs, reports the missing path, and refuses a new run with that reason', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const projectId = await createProject(daemon.origin, 'checkout', repo.dir);
      const first = await submitRun(daemon.origin, repo.dir, 'one', projectId);
      const second = await submitRun(daemon.origin, repo.dir, 'two', projectId);

      await rm(repo.dir, { recursive: true, force: true });

      // The past does not depend on the present.
      expect((await history(daemon.origin, projectId)).map((run) => run.runId)).toEqual([
        second,
        first,
      ]);

      // And the page is told why, in the daemon's own sentence.
      const listed = (await (await fetch(`${daemon.origin}/api/projects`)).json()) as {
        projects: readonly { id: string; health: { state: string; message: string | null } }[];
      };
      const project = listed.projects.find((row) => row.id === projectId);
      expect(project?.health.state).toBe('missing');
      expect(project?.health.message ?? '').toContain(repo.dir);

      // Starting a new run from it is refused — with that same reason, rather
      // than with a second sentence written at the refusal site.
      const refused = await fetch(`${daemon.origin}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text: 'work in a directory that is gone' },
          cwd: repo.dir,
          permission: 'worktree',
          projectId,
        }),
      });
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as Envelope;
      expect(body.error.message).toBe(project?.health.message);

      // And nothing was recorded: a refused submission must not add a fourth
      // row to the history it was refused on behalf of.
      expect(await history(daemon.origin, projectId)).toHaveLength(2);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S47 — a run belonging to no project is still reachable', () => {
  it('lists it in GET /api/runs, opens it, and claims it for no project', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const projectId = await createProject(daemon.origin, 'checkout', repo.dir);
      const owned = await submitRun(daemon.origin, repo.dir, 'belongs to a project', projectId);
      // The shape every run submitted before projects existed has: a
      // `task.submitted` with no `projectId` on its provenance.
      const orphan = await submitRun(daemon.origin, repo.dir, 'belongs to nobody');

      const runs = (await (await fetch(`${daemon.origin}/api/runs`)).json()) as {
        runs: readonly { runId: string }[];
      };
      expect(runs.runs.map((run) => run.runId)).toContain(orphan);

      // Openable — the whole run, not a stub.
      expect((await fetch(`${daemon.origin}/api/runs/${orphan}`)).status).toBe(200);

      // And no project workspace claims it.
      expect((await history(daemon.origin, projectId)).map((run) => run.runId)).toEqual([owned]);
    } finally {
      await daemon.stop();
    }
  });
});
