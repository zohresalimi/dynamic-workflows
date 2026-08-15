/**
 * KAR-18.9 AC1-AC5, AC7-AC9 — what an operator's terminal actually receives.
 *
 * The unit specs under `src/render/` settle the layer. What only a real process
 * can settle is the half this file covers: that all five commands were actually
 * moved onto it, that a redirected stdout is genuinely not a TTY (so
 * `process.stdout.isTTY` is `undefined` and `stdout.columns` with it), and that
 * the exit codes their own stories pin survived the rewrite — which is the
 * difference between a presentation change and a breaking one.
 *
 * stdout is a real file descriptor opened on a real file, the same thing a
 * shell's `> report.txt` produces, rather than a pipe this process reads: the
 * bytes asserted are the bytes that landed on disk.
 *
 * Verifies: EPIC-18-S57, EPIC-18-S60, EPIC-18-S61 (its report half) · AC1-AC5,
 * AC7-AC9 · test plan #6
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { makeRepo, makeTempDir, normaliseSnapshotText, removeTempDir } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { DOCTOR_SECTION_IDS, reduceReport, renderText } from '../../src/doctor/report.ts';
import { createStyle } from '../../src/render/style.ts';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { HERMETIC_PATH, spawnRun, until } from './support/cli-process.ts';
import { openSpecGate, waitForRun } from './support/run-fixture.ts';

const CLI_BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

/** The ESC that must never reach a file. */
const ESC = '\u001B';
/** AC9's fallback, and what every line in a redirected report must respect. */
const PIPED_WIDTH = 80;

let tmp = '';
let booted: Booted | undefined;

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  await removeTempDir(tmp);
});

interface Piped {
  readonly code: number | null;
  readonly text: string;
  readonly stderr: string;
}

/** One command, stdout redirected to a file, the environment fully controlled. */
function pipeBin(
  args: readonly string[],
  options: { readonly cwd: string; readonly dataDir: string; readonly out: string },
): Promise<Piped> {
  const fd = openSync(options.out, 'w');
  return new Promise<Piped>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd: options.cwd,
      env: {
        PATH: HERMETIC_PATH,
        HOME: options.dataDir,
        DeFlow_DATA_DIR: options.dataDir,
        DeFlow_LOG_LEVEL: 'silent',
        // A locale that establishes UTF-8, so the report under test is the
        // one an ordinary terminal gets; `LC_ALL=C` is EPIC-18-S64's case and
        // is asserted as a unit.
        LANG: 'en_US.UTF-8',
      },
      stdio: ['ignore', fd, 'pipe'],
    });
    const err: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      closeSync(fd);
      resolve({ code, text: readFileSync(options.out, 'utf8'), stderr: err.join('') });
    });
  });
}

/**
 * AC7 and AC9 over one file: clean text, at the width AC9 falls back to.
 *
 * The one exception is AC4's, and it is deliberate: a single token wider than
 * the terminal — an absolute path, a URL — is emitted **whole** on a line of
 * its own rather than broken, because an operator who copies a broken path
 * gets half a path at exactly the moment they most need it. Such a line is
 * allowed to be long; a line with a space in it is not.
 */
function assertReadable(text: string): void {
  expect(text).not.toContain(ESC);
  for (const line of text.split('\n')) {
    if (line.length <= PIPED_WIDTH) continue;
    expect(
      line.trim(),
      `a redirected report may only exceed ${PIPED_WIDTH} columns for one unbreakable token: ` +
        JSON.stringify(line),
    ).not.toMatch(/\s/);
  }
}

suite('EPIC-18-S60 — five commands, one tool, redirected to a file', () => {
  it('deflow init writes clean text and exits 0', async () => {
    const repo = await makeRepo({ dir: join(tmp, 'init-repo') });
    const dataDir = join(tmp, 'init-data');
    await mkdir(dataDir, { recursive: true });

    const piped = await pipeBin(['init'], { cwd: repo.dir, dataDir, out: join(tmp, 'init.txt') });

    expect(piped.code).toBe(0);
    assertReadable(piped.text);
    expect(piped.text).toContain('config.yaml');
    expect(piped.text).toContain('created');
  }, 60_000);

  it('deflow doctor writes clean text and exits with its own two-valued code', async () => {
    const repo = await makeRepo({ dir: join(tmp, 'doctor-repo') });
    await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
    const dataDir = join(tmp, 'doctor-data');

    const piped = await pipeBin(['doctor', '--skip-conformance'], {
      cwd: repo.dir,
      dataDir,
      out: join(tmp, 'doctor.txt'),
    });

    // KAR-18.4 AC11's closed set, unchanged by this story.
    expect([0, 5]).toContain(piped.code);
    assertReadable(piped.text);
    for (const title of ['Runtime', 'git', 'Sandboxing', 'Agents']) {
      expect(piped.text).toContain(title);
    }
  }, 90_000);

  it('deflow status writes clean text and exits 0 even with no daemon', async () => {
    const dataDir = join(tmp, 'status-data');
    await mkdir(dataDir, { recursive: true });

    const piped = await pipeBin(['status'], { cwd: tmp, dataDir, out: join(tmp, 'status.txt') });

    // KAR-18.7 AC5 — a query, not an assertion.
    expect(piped.code).toBe(0);
    assertReadable(piped.text);
    expect(piped.text).toContain('deflow up');
  }, 60_000);

  it('deflow run --no-wait and deflow ledger snapshot write clean text', async () => {
    const dataDir = join(tmp, 'run-data');
    mkdirSync(dataDir, { recursive: true });
    booted = await boot({ dataDir, port: 0, dev: false });
    const repo = await makeRepo({ dir: join(tmp, 'run-repo') });

    const out = join(tmp, 'run.txt');
    const fd = openSync(out, 'w');
    const cli = spawnRun({
      dataDir,
      cwd: repo.dir,
      args: ['--no-wait', 'add a health endpoint'],
      env: { LANG: 'en_US.UTF-8' },
      stdoutFd: fd,
    });

    const runId = await waitForRun(booted.db);
    await until('the CLI subscribed', () =>
      readFileSync(out, 'utf8').includes('task') ? true : null,
    );
    openSpecGate(RunIdSchema.parse(runId), {
      db: booted.db,
      epoch: booted.epoch,
      ts: Date.now(),
    });

    const exit = await cli.exited;
    closeSync(fd);

    // KAR-18.3 AC6's fourth code, unchanged.
    expect(exit.code).toBe(RUN_EXIT_CODES.awaitingHuman);
    assertReadable(readFileSync(out, 'utf8'));

    // And the ledger snapshot of the run that just happened.
    const snapshot = await pipeBin(
      ['ledger', 'snapshot', runId, '--out', join(tmp, 'bug-report.db')],
      { cwd: repo.dir, dataDir, out: join(tmp, 'ledger.txt') },
    );

    expect(snapshot.code).toBe(0);
    assertReadable(snapshot.text);
    expect(snapshot.text).toContain(runId);
  }, 120_000);
});

suite('EPIC-18-S57 — a report that says what to do before it says everything else', () => {
  /** A machine whose sandbox section warns and whose other checks are ok. */
  const oneThingWrong = reduceReport([
    {
      id: 'runtime',
      checks: [
        { id: 'runtime.node', status: 'ok', detail: 'Node 24.3.0 meets the >= 24 floor' },
        {
          id: 'runtime.workspace-dir',
          status: 'ok',
          detail: 'the repo-local .DeFlow/ directory is writable',
        },
      ],
    },
    { id: 'git', checks: [{ id: 'git.version', status: 'ok', detail: 'git 2.51.0' }] },
    {
      id: 'sandboxing',
      checks: [
        {
          id: 'sandboxing.levels',
          status: 'warn',
          detail:
            'this platform can honour read only: bubblewrap is not on PATH, so worktree, ' +
            'worktree+net and full cannot be entered and every node asking for one will refuse ' +
            'to start rather than run unsandboxed.',
          action: 'sudo apt install bubblewrap socat',
        },
      ],
    },
    { id: 'agents', checks: [{ id: 'agents.summary', status: 'ok', detail: '1 installed' }] },
    {
      id: 'capabilities',
      checks: [{ id: 'capabilities.claude', status: 'ok', detail: 'ResumeBySessionId' }],
    },
    {
      id: 'conformance',
      checks: [{ id: 'conformance.claude', status: 'ok', detail: '9 passed, 0 failed, 0 skipped' }],
    },
    {
      id: 'auth',
      checks: [{ id: 'auth.shadowing', status: 'ok', detail: 'no shadowing variable' }],
    },
    { id: 'memory', checks: [{ id: 'memory.pty', status: 'ok', detail: 'node-pty loaded' }] },
  ]);

  const piped = createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' } });

  it('indents its checks under headings and lines their statuses up', () => {
    const lines = renderText(oneThingWrong, piped).split('\n');

    for (const id of DOCTOR_SECTION_IDS) {
      const title = oneThingWrong.sections.find((section) => section.id === id)?.title ?? '';
      const index = lines.findIndex((line) => line.trimEnd() === title);
      expect(index, `no heading for ${id}`).toBeGreaterThan(0);
      expect(lines[index - 1]).toBe('');
      expect(lines[index + 1]?.startsWith('  ')).toBe(true);
    }

    // Within the Runtime section, both statuses start at the same column.
    const columns = ['runtime.node', 'runtime.workspace-dir'].map((id) =>
      (lines.find((line) => line.includes(id)) ?? '').indexOf('✓'),
    );
    expect(new Set(columns).size).toBe(1);
    expect(columns[0]).toBeGreaterThan(0);
  });

  it('ends with the summary, and starts it with one command to run next', () => {
    const lines = renderText(oneThingWrong, piped)
      .split('\n')
      .filter((line) => line !== '');
    const block = lines.slice(-2);

    expect(block[0]).toContain('next:');
    expect(block[0]).toContain('sudo apt install bubblewrap socat');
    expect(block[1]).toContain('overall: ');
    expect(block[1]).toContain('warn');
    // A count per state, every state named even at zero.
    for (const state of ['ok', 'warn', 'fail', 'skipped']) {
      expect(block[1]).toMatch(new RegExp(`\\d+ ${state}`));
    }
    expect(oneThingWrong.exitCode).toBe(0);
  });

  it('names no next action when nothing is wrong', () => {
    const healthy = reduceReport(
      DOCTOR_SECTION_IDS.map((id) => ({
        id,
        checks: [
          { id: `${id}.all`, status: 'ok' as const, detail: 'everything this needs is here' },
        ],
      })),
    );

    const rendered = renderText(healthy, piped);
    expect(rendered).not.toContain('next:');
    expect(rendered).toContain('overall: ');
    expect(rendered).toContain('8 ok');
    expect(healthy.exitCode).toBe(0);
  });

  it('matches the committed report snapshot through the normalising serializer', async () => {
    // A detail carrying an absolute path, because the path is the thing a
    // snapshot would otherwise pin to one machine — and the thing AC4 forbids
    // breaking across two lines.
    const withPath = reduceReport([
      ...oneThingWrong.sections.map((section) => ({ id: section.id, checks: section.checks })),
      {
        id: 'runtime' as const,
        checks: [
          ...(oneThingWrong.sections[0]?.checks ?? []),
          {
            id: 'runtime.state-dir',
            status: 'ok' as const,
            detail: `the global state directory is writable: ${join(tmp, 'state', 'DeFlow')}`,
          },
        ],
      },
    ]);

    await expect(normaliseSnapshotText(renderText(withPath, piped))).toMatchFileSnapshot(
      '__snapshots__/doctor-report.txt',
    );
  });
});
