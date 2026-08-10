/**
 * KAR-15.4 — builds `test/fixtures/runs/crash-resume-seq-gap/` **by crashing a
 * real writer**.
 *
 * EPIC-15 lists this fixture as a precondition and says why: *"a ledger whose
 * sequence numbers jump, as a real SIGKILL produces — half the resume scenarios
 * in this epic are unwritable without it."* A hand-authored database with a row
 * missing would satisfy the letter of that and prove nothing, because the claim
 * under test is that a **healthy** ledger has holes in it. So this spawns a
 * detached child (`./crash-resume-writer.ts`) that appends two interleaved runs
 * through `appendEvents`, waits until it has committed the last event of the
 * run under test *and is still writing*, and then `kill -9`s its process group.
 *
 * What comes out is `seq` 4, 5, 7, 8, 11 for the run under test — where 6, 9 and
 * 10 are the other run's rows, present and correct in the same table. That is
 * the whole lesson of docs/11-api-and-realtime.md §4.2: the gap is not loss,
 * and a client that "repairs" it by refetching from zero is doing minutes of
 * work over nothing.
 *
 * **The work happens under `/tmp`**, like every other fixture builder here:
 * absolute paths recorded in a committed ledger must be synthetic, never a
 * developer's home directory.
 *
 * Usage:
 *   node packages/daemon/scripts/build-crash-resume-fixture.ts [outDir] [workDir]
 */
import type { Db, RunId } from '@DeFlow/core';
import { openLedger, openRead, readRange } from '@DeFlow/ledger';
import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CRASH_RESUME_OTHER_RUN, CRASH_RESUME_RUN } from './crash-resume-runs.ts';

export { CRASH_RESUME_OTHER_RUN, CRASH_RESUME_RUN } from './crash-resume-runs.ts';

/** What the run under test committed before the crash. */
export const CRASH_RESUME_SEQS: readonly number[] = [4, 5, 7, 8, 11];

/** Where the committed copy lives, relative to this file. */
export const CRASH_RESUME_FIXTURE_DIR = fileURLToPath(
  new URL('../../../test/fixtures/runs/crash-resume-seq-gap/', import.meta.url),
);

/** Synthetic and fixed — see the header. */
export const CRASH_RESUME_WORK_DIR = '/tmp/deflow-crash-resume-seq-gap';

const WRITER = fileURLToPath(new URL('./crash-resume-writer.ts', import.meta.url));

/** How the child went. `SIGKILL`, or the fixture is not what it claims. */
export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface BuiltCrashFixture {
  readonly outDir: string;
  readonly killed: Exit;
  /** `PRAGMA integrity_check` over what the crash left behind. */
  readonly integrity: string;
  readonly seqs: readonly number[];
  /** Rows the other run had committed when the knife landed. */
  readonly otherRunEvents: number;
}

const README = (seqs: readonly number[], other: number): string => `# \`crash-resume-seq-gap\`

A ledger whose sequence numbers jump, produced by \`kill -9\` on a real writer —
never by hand.

**Produced by \`packages/daemon/scripts/build-crash-resume-fixture.ts\`.**
Rebuild it with:

\`\`\`
node packages/daemon/scripts/build-crash-resume-fixture.ts
\`\`\`

- run under test: \`${CRASH_RESUME_RUN}\`, \`seq\` ${seqs.join(', ')}
- the other run: \`${CRASH_RESUME_OTHER_RUN}\`, ${other} events, and it is the
  owner of ${[1, 2, 3, 6, 9, 10].join(', ')} — the numbers a gap detector would
  call lost
- the child was still appending when it was killed, so the tail of the other run
  is whatever SQLite had committed at that instant. That is the point: the
  sequence under test is fixed, and what a crash leaves after it is not.

\`seq\` 4, 5, 7, 8, 11 is a **healthy** log. \`event\` is one global
\`AUTOINCREMENT\` sequence keyed by \`run_id\`, so a run's cursor walks a strided
subsequence of it, and \`AUTOINCREMENT\` never reissues a pruned number. The
cursor contract is *resume from strictly greater than \`seq\`*, never *expect
\`seq\` + 1* (docs/11-api-and-realtime.md §4.2). A client that treats the hole as
a dropped event reports false data loss and may refetch a multi-hour run over
nothing.

The build happens under \`${CRASH_RESUME_WORK_DIR}\`, so every path this ledger
records is synthetic and portable.
`;

function seqsOf(db: Db, runId: RunId): number[] {
  return readRange(db, runId, 0, 10_000).events.map((event) => event.seq);
}

/**
 * Builds the fixture into `outDir`, working in `workDir`.
 *
 * Returns what the crash produced rather than asserting it: the spec beside
 * this file (`../test/integration/crash-resume-fixture.test.ts`) is what holds
 * the result to `4, 5, 7, 8, 11`, so a rebuild that drifts fails a test rather
 * than throwing out of a script nobody is watching.
 */
export async function buildCrashResumeFixture(
  outDir: string = CRASH_RESUME_FIXTURE_DIR,
  workDir: string = CRASH_RESUME_WORK_DIR,
): Promise<BuiltCrashFixture> {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const writer = startWriter(workDir);
  await until(
    () => writer.stdout().includes('committed 11'),
    () => `the writer to commit ${CRASH_RESUME_RUN}'s last event. It said: ${writer.stderr()}`,
  );
  // Killed while it is still appending, not after it has gone quiet: a crash
  // between batches would prove nothing about a commit boundary.
  await until(
    () => countRows(workDir) > 11,
    () => 'the writer to get past the scripted interleaving and keep going',
  );
  const killed = await writer.sigkill();

  // Reopening runs SQLite's own WAL recovery, which is the state any client of
  // this fixture starts from. Everything below reads what survived.
  const db = openLedger(workDir);
  const integrity =
    db.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()?.integrity_check ??
    'unknown';
  const seqs = seqsOf(db, CRASH_RESUME_RUN);
  const otherRunEvents = seqsOf(db, CRASH_RESUME_OTHER_RUN).length;
  // Fold the WAL back into the .db, because the `-wal` sidecar is deliberately
  // not committed — the fixture is the one file.
  db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  db.close();

  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(workDir, 'ledger.db'), join(outDir, 'ledger.db'));
  writeFileSync(join(outDir, 'README.md'), README(seqs, otherRunEvents), 'utf8');
  writeFileSync(
    join(outDir, 'events.json'),
    `${JSON.stringify(eventsFor(join(outDir, 'ledger.db')), null, 2)}\n`,
    'utf8',
  );

  return { outDir, killed, integrity, seqs, otherRunEvents };
}

interface Writer {
  readonly exited: Promise<Exit>;
  stdout(): string;
  stderr(): string;
  /** `kill -9` on the whole process group, resolved once it is really gone. */
  sigkill(): Promise<Exit>;
}

/**
 * The writer, as a real detached child.
 *
 * Spawned here rather than through `@DeFlow/testkit`'s identical harness
 * because that package's entry point registers Vitest fixtures at import time,
 * which makes it unimportable from a script run with plain `node` — and the
 * documented way to rebuild this fixture is exactly that.
 *
 * `detached: true` makes the child a process-group leader and the kill targets
 * the **group** (`-pid`), so nothing it spawned can outlive it and keep writing
 * into a ledger this function is about to read. SIGKILL rather than SIGTERM:
 * SIGTERM tests a shutdown handler, and this fixture is about durability.
 */
function startWriter(workDir: string): Writer {
  const child: ChildProcess = spawn(process.execPath, [WRITER, workDir], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start ${WRITER}`);

  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    exited,
    stdout: () => out,
    stderr: () => err,
    async sigkill(): Promise<Exit> {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // ESRCH: already gone, which is the outcome this asked for.
      }
      return exited;
    },
  };
}

/** Polls a real clock — there is a live child, so no timer may be faked. */
async function until(condition: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The run under test's envelopes, for a consumer that cannot open SQLite. */
function eventsFor(dbPath: string): unknown[] {
  const db = openRead(dbPath);
  try {
    return [...readRange(db, CRASH_RESUME_RUN, 0, 10_000).events];
  } finally {
    db.close();
  }
}

/** How far the writer has got, read from outside its process. */
function countRows(workDir: string): number {
  const db = openRead(join(workDir, 'ledger.db'));
  try {
    return db.prepare<{ n: number }>('SELECT count(*) AS n FROM event').get()?.n ?? 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outDir, workDir] = process.argv.slice(2);
  const built = await buildCrashResumeFixture(outDir, workDir);
  process.stdout.write(
    `${built.outDir}: ${CRASH_RESUME_RUN} committed ${built.seqs.join(', ')} ` +
      `(integrity_check ${built.integrity}, killed with ${built.killed.signal ?? '?'})\n`,
  );
}
