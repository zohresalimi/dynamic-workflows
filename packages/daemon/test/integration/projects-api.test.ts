/**
 * KAR-22.1 — the projects surface, against a real booted daemon, a real
 * file-backed ledger and real `git init` repositories.
 *
 * Integration and not unit, deliberately: every acceptance criterion in this
 * story is a claim about the **outside world**. "Is this a git working tree",
 * "did the directory disappear", "did removing the project delete the operator's
 * code" and "is the project still there after a restart" are all questions a
 * fake filesystem answers however you taught it to.
 *
 * Nothing here narrows `PATH`, and that is a statement about the design rather
 * than an omission: creating a project writes KAR-18.1's workspace files and
 * **does not probe for providers**. A daemon is only told which machine it is on
 * by its caller (`boot`'s `providerRoots`), and a route that searched whatever
 * `PATH` DeFlowd inherited would be a second producer of provider state beside
 * KAR-19.10's — which is the class of mismatch EPIC-19 shipped to end.
 *
 * Verifies: EPIC-22-S1, EPIC-22-S2, EPIC-22-S4, EPIC-22-S5, EPIC-22-S6,
 * EPIC-22-S7, EPIC-22-S8, EPIC-22-S9, EPIC-22-S10, EPIC-22-S11, EPIC-22-S12,
 * EPIC-22-S13, EPIC-22-S14 · KAR-22.1 AC1–AC6 · test plan #1, #2, #4–#12
 */
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { boot } from '../../src/boot.ts';
import { NOT_A_GIT_WORKING_TREE } from '../../src/init/workspace-init.ts';
import { walk } from './support/walk.ts';

const fetch = authorizedFetch();

interface PathReportBody {
  readonly relativePath: string;
  readonly status: string;
}

interface ProjectBody {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: { readonly state: string; readonly message: string | null };
  readonly lastRun: {
    readonly runId: string;
    readonly status: string;
    readonly label: string;
    readonly createdAt: string;
  } | null;
}

interface CreateBody {
  readonly project: ProjectBody;
  readonly init: {
    readonly ran: boolean;
    readonly reason?: string;
    readonly paths: readonly PathReportBody[];
  };
}

interface ListBody {
  readonly projects: readonly ProjectBody[];
}

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: Record<string, unknown>;
  };
}

async function bootAt(dataDir: string): Promise<{ origin: string; stop: () => Promise<void> }> {
  await mkdir(dataDir, { recursive: true });
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${address.port}`, stop: () => booted.shutdown() };
}

async function createProject(origin: string, name: string, path: string): Promise<Response> {
  return fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path }),
  });
}

async function list(origin: string): Promise<readonly ProjectBody[]> {
  const response = await fetch(`${origin}/api/projects`);
  expect(response.status).toBe(200);
  return ((await response.json()) as ListBody).projects;
}

/** One text run against `projectId`, accepted at intake. */
async function submitRun(origin: string, cwd: string, projectId: string): Promise<string> {
  const response = await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { kind: 'text', text: `work in ${projectId}` },
      cwd,
      permission: 'worktree',
      projectId,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { runId: string }).runId;
}

suite('EPIC-22-S1 — a name and a repository become a project', () => {
  it('creates it, mints an id, resolves the path and lists it', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await createProject(daemon.origin, 'checkout', repo.dir);
      expect(response.status).toBe(201);
      const body = (await response.json()) as CreateBody;

      expect(body.project.id).toMatch(/^prj_\d{8}T\d{6}Z_[0-9a-f]{6}$/);
      expect(body.project.name).toBe('checkout');
      expect(body.project.path).toBe(await realpathOf(repo.dir));
      expect(body.project.health.state).toBe('ok');
      expect(Date.parse(body.project.createdAt)).not.toBeNaN();

      const projects = await list(daemon.origin);
      expect(projects.map((project) => project.id)).toEqual([body.project.id]);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S2 — a path that is not a git working tree is refused', () => {
  it("answers 400 with deflow init's own sentence, and writes nothing", async ({ tmp }) => {
    const plain = join(tmp, 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'notes.txt'), 'not a repository\n');
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await createProject(daemon.origin, 'nope', plain);
      expect(response.status).toBe(400);
      const body = (await response.json()) as Envelope;
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.message).toBe(NOT_A_GIT_WORKING_TREE);
      expect(body.error.detail).toMatchObject({ field: 'path' });

      expect(await list(daemon.origin)).toEqual([]);
      // Nothing half-created: a refusal that had already written `.DeFlow/`
      // would leave a directory DeFlow half-owns and no project to explain it.
      expect(await walk(plain)).toEqual(['notes.txt']);
    } finally {
      await daemon.stop();
    }
  });

  it('answers 400 naming a path that does not exist at all', async ({ tmp }) => {
    const daemon = await bootAt(join(tmp, 'data'));
    const missing = join(tmp, 'never-existed');
    try {
      const response = await createProject(daemon.origin, 'nope', missing);
      expect(response.status).toBe(400);
      const body = (await response.json()) as Envelope;
      expect(body.error.message).toContain(missing);
      expect(await list(daemon.origin)).toEqual([]);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S4 — creating a project bootstraps .DeFlow/ and reports it', () => {
  it("writes what deflow init writes, and reports each path's status", async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await createProject(daemon.origin, 'checkout', repo.dir);
      const body = (await response.json()) as CreateBody;

      expect(body.init.ran).toBe(true);
      const reported = body.init.paths.map((entry) => entry.relativePath);
      expect(reported).toContain('.DeFlow/config.yaml');
      expect(reported).toContain('.DeFlow/gates/');
      expect(reported).toContain('.gitignore');
      for (const entry of body.init.paths) {
        expect(['created', 'unchanged', 'updated', 'kept (edited)']).toContain(entry.status);
        expect(entry.relativePath.startsWith('/')).toBe(false);
      }

      const written = await walk(repo.dir);
      expect(written).toContain('.DeFlow/config.yaml');
      expect(written.some((path) => path.startsWith('.DeFlow/schemas/'))).toBe(true);
      expect(await readFile(join(repo.dir, '.gitignore'), 'utf8')).toContain('.DeFlow/');
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S5 — an already-initialised repository is not initialised twice', () => {
  it('skips init for a repository that already carries .DeFlow/', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
    await writeFile(join(repo.dir, '.DeFlow', 'config.yaml'), 'budget:\n  costUsd: 4\n');
    const before = await snapshotOf(repo.dir, '.DeFlow');
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await createProject(daemon.origin, 'checkout', repo.dir);
      expect(response.status).toBe(201);
      const body = (await response.json()) as CreateBody;
      expect(body.init.ran).toBe(false);
      expect(body.init.reason ?? '').toMatch(/already initialised/i);
      expect(await snapshotOf(repo.dir, '.DeFlow')).toEqual(before);
    } finally {
      await daemon.stop();
    }
  });
});

suite("EPIC-22-S6 — an operator's edited config.yaml is never overwritten", () => {
  it('keeps the bytes and never claims to have created or updated it', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      // Initialised first, so `.DeFlow/` exists and only `config.yaml` differs.
      await createProject(daemon.origin, 'first', repo.dir);
      const edited = '# mine\nbudget:\n  costUsd: 12\n';
      await writeFile(join(repo.dir, '.DeFlow', 'config.yaml'), edited);

      // A second repository, initialised through the API, whose config an
      // operator wrote by hand before the project existed.
      const other = await makeRepo({ dir: join(tmp, 'other') });
      await mkdir(join(other.dir, '.DeFlow'), { recursive: true });
      await writeFile(join(other.dir, '.DeFlow', 'config.yaml'), edited);

      const response = await createProject(daemon.origin, 'other', other.dir);
      expect(response.status).toBe(201);
      expect(await readFile(join(other.dir, '.DeFlow', 'config.yaml'), 'utf8')).toBe(edited);

      const body = (await response.json()) as CreateBody;
      const report = body.init.paths.find((entry) => entry.relativePath.endsWith('config.yaml'));
      expect(report?.status ?? 'kept (edited)').not.toBe('created');
      expect(report?.status ?? 'kept (edited)').not.toBe('updated');

      // And the first repository's edited config is still the operator's.
      expect(await readFile(join(repo.dir, '.DeFlow', 'config.yaml'), 'utf8')).toBe(edited);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S7 — projects survive a daemon restart', () => {
  it('reads both back from a fresh daemon over the same data directory', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const one = await makeRepo({ dir: join(tmp, 'one') });
    const two = await makeRepo({ dir: join(tmp, 'two') });

    const first = await bootAt(dataDir);
    let before: readonly ProjectBody[];
    try {
      await createProject(first.origin, 'one', one.dir);
      await createProject(first.origin, 'two', two.dir);
      before = await list(first.origin);
      expect(before).toHaveLength(2);
    } finally {
      await first.stop();
    }

    const second = await bootAt(dataDir);
    try {
      const after = await list(second.origin);
      expect(after.map((project) => [project.id, project.name, project.path])).toEqual(
        before.map((project) => [project.id, project.name, project.path]),
      );
    } finally {
      await second.stop();
    }
  });
});

suite('EPIC-22-S8/S9/S10 — the list tells the truth about each path', () => {
  it('reports ok, missing and not-a-git-repo as three different answers', async ({ tmp }) => {
    const healthy = await makeRepo({ dir: join(tmp, 'healthy') });
    const vanishing = await makeRepo({ dir: join(tmp, 'vanishing') });
    const degitted = await makeRepo({ dir: join(tmp, 'degitted') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      await createProject(daemon.origin, 'healthy', healthy.dir);
      await createProject(daemon.origin, 'vanishing', vanishing.dir);
      await createProject(daemon.origin, 'degitted', degitted.dir);

      await rm(vanishing.dir, { recursive: true, force: true });
      await rm(join(degitted.dir, '.git'), { recursive: true, force: true });

      const projects = await list(daemon.origin);
      expect(projects).toHaveLength(3);
      const byName = Object.fromEntries(projects.map((project) => [project.name, project]));

      expect(byName.healthy?.health.state).toBe('ok');

      expect(byName.vanishing?.health.state).toBe('missing');
      expect(byName.vanishing?.health.message).toContain(vanishing.dir);

      expect(byName.degitted?.health.state).toBe('not-a-git-repo');
      expect(byName.degitted?.health.state).not.toBe('missing');
      expect(byName.degitted?.health.message ?? '').toMatch(/git working tree/i);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S11 — the row names the most recent run', () => {
  it('names the newer of two runs, with the status label every surface prints', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const created = (await (
        await createProject(daemon.origin, 'checkout', repo.dir)
      ).json()) as CreateBody;
      const projectId = created.project.id;

      const empty = await list(daemon.origin);
      expect(empty[0]?.lastRun).toBeNull();

      await submitRun(daemon.origin, repo.dir, projectId);
      const second = await submitRun(daemon.origin, repo.dir, projectId);

      const projects = await list(daemon.origin);
      expect(projects[0]?.lastRun?.runId).toBe(second);
      expect(projects[0]?.lastRun?.status).toBe('created');
      expect(projects[0]?.lastRun?.label).toBe('submitted — waiting to be framed');
      expect(Date.parse(projects[0]?.lastRun?.createdAt ?? '')).not.toBeNaN();
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S12 — a rename moves a label and nothing else', () => {
  it('keeps the id, the path and the run, and survives a restart', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(dataDir);
    let projectId = '';
    let runId = '';
    try {
      const created = (await (
        await createProject(daemon.origin, 'checkout', repo.dir)
      ).json()) as CreateBody;
      projectId = created.project.id;
      runId = await submitRun(daemon.origin, repo.dir, projectId);

      const renamed = await fetch(`${daemon.origin}/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'checkout-v2' }),
      });
      expect(renamed.status).toBe(200);
      const body = (await renamed.json()) as { project: ProjectBody };
      expect(body.project.id).toBe(projectId);
      expect(body.project.name).toBe('checkout-v2');
      expect(body.project.path).toBe(created.project.path);
      expect(body.project.lastRun?.runId).toBe(runId);
    } finally {
      await daemon.stop();
    }

    const again = await bootAt(dataDir);
    try {
      const projects = await list(again.origin);
      expect(projects[0]?.name).toBe('checkout-v2');
      expect(projects[0]?.lastRun?.runId).toBe(runId);
    } finally {
      await again.stop();
    }
  });

  it('refuses an empty name and leaves the stored one alone', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const created = (await (
        await createProject(daemon.origin, 'checkout', repo.dir)
      ).json()) as CreateBody;

      const response = await fetch(`${daemon.origin}/api/projects/${created.project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as Envelope).error.detail).toMatchObject({ field: 'name' });
      expect((await list(daemon.origin))[0]?.name).toBe('checkout');
    } finally {
      await daemon.stop();
    }
  });

  it('answers 404 for a project this daemon does not hold', async ({ tmp }) => {
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const response = await fetch(`${daemon.origin}/api/projects/prj_20260101T000000Z_ffffff`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as Envelope).error.code).toBe('project_not_found');
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S13 — removing a project removes a row and not a single file', () => {
  it('leaves every file, .git and .DeFlow in place, and says so', async ({ tmp }) => {
    const repo = await makeRepo({
      dir: join(tmp, 'repo'),
      files: { 'README.md': '# real work\n', 'src/index.ts': 'export const x = 1;\n' },
    });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const created = (await (
        await createProject(daemon.origin, 'checkout', repo.dir)
      ).json()) as CreateBody;
      const before = await walk(repo.dir);

      const response = await fetch(`${daemon.origin}/api/projects/${created.project.id}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        id: string;
        removed: boolean;
        filesDeleted: boolean;
        message: string;
      };
      expect(body.removed).toBe(true);
      expect(body.filesDeleted).toBe(false);
      expect(body.message).toMatch(/no files/i);

      expect(await list(daemon.origin)).toEqual([]);
      expect(await walk(repo.dir)).toEqual(before);
      expect(before).toContain('src/index.ts');
      expect(await readFile(join(repo.dir, 'src/index.ts'), 'utf8')).toBe('export const x = 1;\n');
    } finally {
      await daemon.stop();
    }
  });

  it('leaves the runs that belonged to it listed and openable', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const created = (await (
        await createProject(daemon.origin, 'checkout', repo.dir)
      ).json()) as CreateBody;
      const first = await submitRun(daemon.origin, repo.dir, created.project.id);
      const second = await submitRun(daemon.origin, repo.dir, created.project.id);

      await fetch(`${daemon.origin}/api/projects/${created.project.id}`, { method: 'DELETE' });

      const runs = (await (await fetch(`${daemon.origin}/api/runs`)).json()) as {
        runs: readonly { runId: string }[];
      };
      expect(runs.runs.map((run) => run.runId).toSorted()).toEqual([first, second].toSorted());
      expect((await fetch(`${daemon.origin}/api/runs/${first}`)).status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-22-S14 — the same directory cannot become two projects', () => {
  it('refuses a trailing slash, a symlink and the plain path alike', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const link = join(tmp, 'link-to-repo');
    await symlink(repo.dir, link, 'dir');
    const daemon = await bootAt(join(tmp, 'data'));
    try {
      const first = (await (
        await createProject(daemon.origin, 'first', repo.dir)
      ).json()) as CreateBody;

      for (const spelling of [repo.dir, `${repo.dir}/`, link]) {
        const response = await createProject(daemon.origin, 'second', spelling);
        expect(response.status).toBe(409);
        const body = (await response.json()) as Envelope;
        expect(body.error.code).toBe('project_exists');
        expect(body.error.detail).toMatchObject({ projectId: first.project.id });
      }

      expect(await list(daemon.origin)).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });
});

/** The realpath of `path`, as the API stores it. */
async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}

/** Every file under `dir/sub`, with its bytes — for "nothing changed" claims. */
async function snapshotOf(dir: string, sub: string): Promise<Record<string, string>> {
  const root = join(dir, sub);
  const entries = await walk(root);
  const snapshot: Record<string, string> = {};
  for (const entry of entries) snapshot[entry] = await readFile(join(root, entry), 'utf8');
  return snapshot;
}
