/**
 * KAR-18.3 AC8 / EPIC-18-S24 — intake from text, file, issue and spec.
 *
 * A real booted daemon, a real repository, a real ledger and — for the issue
 * row — a real `gh` on a temp PATH that is a shell script rather than a mocked
 * module. What is asserted is the ledger, not the CLI's own output: the claim
 * is that the *locator* survives into `task.submitted`'s provenance, and a
 * transcript line saying "from file" would be true of an implementation that
 * inlined the content and threw the path away. That loss is invisible until
 * somebody asks "where did this task come from" six weeks later, which is
 * exactly why it is asserted from the log.
 *
 * > **Amended 2026-08-11 while implementing KAR-18.3.** The scenario's outline
 * > names four `kind`s, one per flag. KAR-10.1 had already settled that the
 * > wire carries **three** — *"a spec document is the `file` kind with its own
 * > `mediaType` in provenance; there is no fourth shape"* (@DeFlow/core's
 * > task-intake.ts, AC1) — so `--spec` is asserted here as the `file` kind with
 * > its own locator, which is what makes the source inspectable. Adding a
 * > fourth provenance variant to satisfy the table would have meant a schema
 * > change to a shipped, folded event for a distinction the locator already
 * > carries.
 *
 * Verifies: EPIC-18-S24 · AC8 · test plan #8
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { readRange } from '@DeFlow/ledger';
import { it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { runRun } from '../../src/run/run.ts';
import { openSpecGate, waitForRun } from './support/run-fixture.ts';

let booted: Booted | undefined;
let restorePath: string | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  if (restorePath !== undefined) {
    process.env.PATH = restorePath;
    restorePath = undefined;
  }
});

/** A `gh` that answers one issue with a fixed synthetic body, on a temp PATH. */
function fakeGh(dir: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'gh');
  writeFileSync(script, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n`, { mode: 0o755 });
  chmodSync(script, 0o755);
  restorePath = process.env.PATH;
  process.env.PATH = `${dir}:${process.env.PATH ?? ''}`;
}

interface Submitted {
  readonly runId: string;
  readonly provenance: Record<string, unknown>;
  readonly raw: string | undefined;
  readonly stdout: string;
  readonly exitCode: number;
}

/**
 * Runs the command against the booted daemon and reads back what intake wrote.
 *
 * `--no-wait` is what makes this terminate: nothing in this repository executes
 * a submitted run yet, so every run parks at the F1.3 spec gate, and AC6's
 * fourth code is precisely the one for "waiting on a human gate under
 * `--no-wait`".
 */
async function submit(
  argv: readonly string[],
  options: { dataDir: string; cwd: string },
): Promise<Submitted> {
  const out: string[] = [];
  const pending = runRun({
    argv: ['--no-wait', ...argv],
    cwd: options.cwd,
    env: { ...process.env, DeFlow_DATA_DIR: options.dataDir },
    stdout: (chunk) => out.push(chunk),
    stderr: () => undefined,
    isTty: () => false,
  });

  // The command is still watching at this point — it exits when the run
  // reaches a state `--no-wait` calls terminal, and opening the F1.3 gate is
  // what produces one. See `./support/run-fixture.ts` for why the spec rather
  // than the daemon appends it.
  const db = booted?.db as never;
  const runId = await waitForRun(db);
  openSpecGate(runId, { db, epoch: booted?.epoch ?? 1, ts: Date.now() });

  const exitCode = await pending;
  const [event] = readRange(db, RunIdSchema.parse(runId), 0, 1).events;
  const payload = event?.payload as { provenance: Record<string, unknown>; raw?: string };

  return {
    runId,
    provenance: payload.provenance,
    raw: payload.raw,
    stdout: out.join(''),
    exitCode,
  };
}

async function bootAt(dataDir: string): Promise<void> {
  booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
}

suite('EPIC-18-S24 — the F1.1 sources, each with its locator (AC8)', () => {
  it('text: kind "text", nothing to locate, the content verbatim', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    await bootAt(`${tmp}/data`);

    const submitted = await submit(['migrate the button to v3'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
    });

    expect(submitted.provenance).toMatchObject({ kind: 'text', by: 'cli' });
    expect(submitted.raw).toBe('migrate the button to v3');
    expect(submitted.exitCode).toBe(RUN_EXIT_CODES.awaitingHuman);
  });

  it('--file: the resolved path is recorded, and the content is not the locator', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    await writeFile(join(repo.dir, 'task.md'), '# Rewrite the checkout\n', 'utf8');
    await bootAt(`${tmp}/data`);

    const submitted = await submit(['--file', 'task.md'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
    });

    expect(submitted.provenance).toMatchObject({
      kind: 'file',
      by: 'cli',
      mediaType: 'text/markdown',
    });
    expect(String(submitted.provenance.resolvedPath)).toMatch(/\/task\.md$/);
    // The framing interview receives the resolved content, not the locator.
    expect(submitted.raw).toBe('# Rewrite the checkout\n');
  });

  it('--spec: the file kind, with the spec document as its locator', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const spec = join(repo.dir, '.DeFlow/specs/x.md');
    mkdirSync(dirname(spec), { recursive: true });
    await writeFile(spec, '# goal\nKeep checkout compiling.\n', 'utf8');
    await bootAt(`${tmp}/data`);

    const submitted = await submit(['--spec', '.DeFlow/specs/x.md'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
    });

    expect(submitted.provenance).toMatchObject({ kind: 'file', by: 'cli' });
    expect(String(submitted.provenance.resolvedPath)).toMatch(/\/\.DeFlow\/specs\/x\.md$/);
    expect(submitted.raw).toBe('# goal\nKeep checkout compiling.\n');
  });

  it('--issue: kind "issue", the URL as the locator, and which resolver answered', async ({
    tmp,
  }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    fakeGh(join(tmp, 'bin'), '{"number":412,"title":"The button is wrong","body":"since v3"}');
    await bootAt(`${tmp}/data`);

    const submitted = await submit(['--issue', 'acme/web#412'], {
      dataDir: `${tmp}/data`,
      cwd: repo.dir,
    });

    expect(submitted.provenance).toMatchObject({
      kind: 'issue',
      by: 'cli',
      // The shorthand the operator typed, expanded to the one shape the
      // resolver takes — and it is the *locator* that is recorded, not the body.
      url: 'https://github.com/acme/web/issues/412',
      resolver: 'gh',
    });
    expect(submitted.raw).toContain('The button is wrong');
  });

  it('a submission the daemon refuses leaves no run and says which field', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    await bootAt(`${tmp}/data`);

    const errors: string[] = [];
    const exitCode = await runRun({
      argv: ['--file', 'nowhere.md'],
      cwd: repo.dir,
      env: { ...process.env, DeFlow_DATA_DIR: `${tmp}/data` },
      stdout: () => undefined,
      stderr: (chunk) => errors.push(chunk),
      isTty: () => false,
    });

    expect(exitCode).not.toBe(0);
    expect(errors.join('')).toContain('input.path');
  });
});
