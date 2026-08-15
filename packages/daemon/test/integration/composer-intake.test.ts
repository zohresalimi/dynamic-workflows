/**
 * KAR-22.2 AC1, AC5 — the composer is a client of intake, not a second intake.
 *
 * The temptation this file exists against is specific and cheap-looking: the
 * browser has a text box, `POST /api/runs` has a `text` shape, and a page that
 * only ever sends that one shape needs none of the rest. Then `--file` arrives,
 * and the page reads the file itself — and the realpath containment check that
 * makes `--file` safe is on the *daemon's* side of a boundary the page just
 * stepped around.
 *
 * So all three shapes go over the wire and the assertions are about the
 * **ledger**: exactly one `task.submitted` per submission, its provenance kind,
 * and `by: 'ui'` — which is what proves the row was produced by `submitTask`
 * and not by something the browser assembled. Plus the two refusals that must
 * arrive as refusals rather than as runs: a path escaping the project, and a
 * machine that can serve nothing.
 *
 * Verifies: EPIC-22-S20, EPIC-22-S25, EPIC-22-S31 · KAR-22.2 AC1, AC5 ·
 * test plan #2, #7
 */
import { renderRefusal, resolveProviderStates } from '@DeFlow/adapters';
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';

const fetch = authorizedFetch();

interface Booting {
  readonly booted: Booted;
  readonly origin: string;
}

async function bootAt(dataDir: string, providerRoots?: readonly string[]): Promise<Booting> {
  const booted = await boot({
    dataDir,
    port: 0,
    dev: false,
    token: TEST_DAEMON_TOKEN,
    ...(providerRoots === undefined ? {} : { providerRoots }),
  });
  const address = booted.http.server.address() as AddressInfo;
  return { booted, origin: `http://127.0.0.1:${address.port}` };
}

/** A project, created the way the browser creates one (KAR-22.1). */
async function createProject(origin: string, name: string, path: string): Promise<string> {
  const response = await fetch(`${origin}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, path }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { project: { id: string } }).project.id;
}

async function submit(origin: string, body: unknown): Promise<Response> {
  return await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Every `task.submitted` in the ledger, with its provenance. */
function submissions(booted: Booted): { runId: string; provenance: Record<string, unknown> }[] {
  return booted.db
    .prepare<{ run_id: string; payload: string }>(
      "SELECT run_id, payload FROM event WHERE kind = 'task.submitted' ORDER BY seq",
    )
    .all()
    .map((row) => ({
      runId: row.run_id,
      provenance: (JSON.parse(row.payload) as { provenance: Record<string, unknown> }).provenance,
    }));
}

const runCount = (booted: Booted): number =>
  (
    booted.db.prepare<{ n: number }>('SELECT COUNT(DISTINCT run_id) AS n FROM event').get() as {
      n: number;
    }
  ).n;

suite('EPIC-22-S20 — text, file and issue go through one intake path', () => {
  it('records one task.submitted per submission, with the shape it was given', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    await writeFile(join(repo.dir, 'spec.md'), '# Spec\n\nRewrite the importer.\n', 'utf8');
    const { booted, origin } = await bootAt(join(tmp, 'data'));

    try {
      const projectId = await createProject(origin, 'checkout', repo.dir);

      // The two shapes that need no network. `issue` is exercised against a
      // fake `gh` in ./intake-resolve-issue.ts; what matters here is that the
      // browser sends the *reference* rather than resolving it itself, which is
      // asserted by its refusal below rather than by staging a resolver twice.
      for (const input of [
        { kind: 'text', text: 'Migrate the checkout module' },
        { kind: 'file', path: 'spec.md' },
      ]) {
        const response = await submit(origin, {
          input,
          cwd: repo.dir,
          projectId,
          permission: 'worktree',
        });
        expect(response.status).toBe(201);
      }

      const rows = submissions(booted);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.provenance.kind)).toEqual(['text', 'file']);

      for (const row of rows) {
        // `by: 'ui'` is the fingerprint of `submitTask` having run: the browser
        // sends no such field, and nothing but intake writes provenance.
        expect(row.provenance.by).toBe('ui');
        expect(row.provenance.cwd).toBe(repo.dir);
        // KAR-22.1 AC7 — and the project the run belongs to, so a run started
        // from the composer is not a run floating loose.
        expect(row.provenance.projectId).toBe(projectId);
      }

      // AC4's containment check ran on the daemon's side: the payload names the
      // **resolved** path, which is a fact the browser never had.
      expect(rows[1]?.provenance.resolvedPath).toBe(join(repo.dir, 'spec.md'));
      expect(rows[1]?.provenance.mediaType).toBe('text/markdown');
    } finally {
      await booted.shutdown();
    }
  });

  it('accepts the exact body the composer builds, field for field', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const { booted, origin } = await bootAt(join(tmp, 'data'));

    try {
      const projectId = await createProject(origin, 'checkout', repo.dir);

      // EPIC-22-S19's other half. The browser spec
      // (`packages/web/src/views/composer.test.ts`) asserts with `toEqual` that
      // the composer sends **exactly** these fields; this asserts that exactly
      // these fields are what the schema accepts. `RunIntakeBodySchema` is a
      // `strictObject`, so a field the composer invented would be a 400 here —
      // which is the whole reason the two assertions are a pair rather than one
      // structural check in a browser that cannot import the schema
      // (`test/dependency-direction.test.ts`).
      const response = await submit(origin, {
        input: { kind: 'text', text: 'Migrate the checkout module' },
        cwd: repo.dir,
        projectId,
        permission: 'worktree',
        provider: 'mock',
      });

      expect(response.status).toBe(201);
      expect(submissions(booted)).toHaveLength(1);
    } finally {
      await booted.shutdown();
    }
  });

  it('refuses an issue reference it cannot resolve, rather than creating a run', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    const { booted, origin } = await bootAt(join(tmp, 'data'));

    try {
      const projectId = await createProject(origin, 'checkout', repo.dir);
      const response = await submit(origin, {
        input: { kind: 'issue', url: 'https://example.invalid/issues/7' },
        cwd: repo.dir,
        projectId,
        permission: 'worktree',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      const body = (await response.json()) as { error: { detail: { field: string } } };
      expect(body.error.detail.field).toBe('input.url');
      // A rejected submission leaves no half-born run (KAR-10.1 AC5).
      expect(submissions(booted)).toHaveLength(0);
    } finally {
      await booted.shutdown();
    }
  });
});

suite('EPIC-22-S31 — a file outside the project is refused by the containment check', () => {
  it('answers 400 with intake’s own refusal and creates no run', async ({ tmp }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    await writeFile(join(tmp, 'outside.txt'), 'not yours\n', 'utf8');
    const { booted, origin } = await bootAt(join(tmp, 'data'));

    try {
      const projectId = await createProject(origin, 'checkout', repo.dir);
      const response = await submit(origin, {
        input: { kind: 'file', path: '../outside.txt' },
        cwd: repo.dir,
        projectId,
        permission: 'worktree',
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; message: string; detail: { field: string } };
      };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.detail.field).toBe('input.path');
      // Intake's own sentence, naming the rule rather than the browser's guess
      // at it — which is the whole reason the check is not in the page.
      expect(body.error.message).toContain('escapes the repository root');
      expect(runCount(booted)).toBe(0);
    } finally {
      await booted.shutdown();
    }
  });
});

suite('EPIC-22-S25 — an admission refusal reaches the composer in the CLI’s words', () => {
  it('renders byte-identical to renderRefusal, and names the run that was aborted', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: join(tmp, 'repo') });
    // A `PATH` with a `node` on it and no agent at all — the machine a person
    // evaluating DeFlow actually has.
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    await symlink(process.execPath, join(binDir, 'node'));
    const { booted, origin } = await bootAt(join(tmp, 'data'), [binDir]);

    try {
      const projectId = await createProject(origin, 'checkout', repo.dir);
      const response = await submit(origin, {
        input: { kind: 'text', text: 'Migrate the checkout module' },
        cwd: repo.dir,
        projectId,
        permission: 'worktree',
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      const body = (await response.json()) as {
        error: { code: string; message: string; detail: { runId?: string } };
      };
      expect(body.error.code).toBe('no_usable_provider');

      // The claim: the sentence on the wire is the one the CLI prints, produced
      // by the same renderer over the same resolutions. Not "similar" — equal.
      expect(body.error.message).toBe(renderRefusal(resolveProviderStates([binDir])));

      // And the run exists, aborted. The composer shows the id because the
      // refusal is answerable six weeks later; a client that treated this as
      // "nothing happened" would leave that row unreachable.
      const runId = body.error.detail.runId;
      expect(runId).toMatch(/^run_/);
      const kinds = booted.db
        .prepare<{ kind: string }>('SELECT kind FROM event WHERE run_id = ? ORDER BY seq')
        .all(runId)
        .map((row) => row.kind);
      expect(kinds[0]).toBe('task.submitted');
      expect(kinds).toContain('run.aborted');
    } finally {
      await booted.shutdown();
    }
  });
});
