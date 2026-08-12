/**
 * `DeFlow ledger snapshot <runId> --out <path>` (KAR-18.7) — "attach my ledger
 * to this bug report", as one command.
 *
 * [docs/03-local-development.md §11](../../../docs/03-local-development.md)
 * specifies it as `VACUUM INTO` behind a flag — **measured at 1007 ms for a
 * 193 MB database** — and the choice of statement is the whole story:
 *
 * - **A file copy would lose the WAL.** A running daemon keeps its most recent
 *   commits in `ledger.db-wal` until a checkpoint moves them, so `cp
 *   ledger.db` produces a database that is missing exactly the part a bug
 *   report is about. `VACUUM INTO` reads through the WAL like any other
 *   reader.
 * - **The copy is one file.** The target comes out in rollback-journal mode,
 *   so there is no `-wal` or `-shm` beside it to be forgotten on the way to an
 *   issue tracker — and a snapshot that is only whole on the machine that made
 *   it is not a snapshot.
 * - **Nothing is locked.** The source is opened **read-only**, so the daemon
 *   keeps serving during and after; WAL readers do not block the writer and
 *   are not blocked by it.
 *
 * The copy is the *whole* ledger, because that is what `VACUUM INTO` does and
 * because one global database is the design (docs/16 §7.2). The run id is not
 * a filter, it is the thing being reported on: it is checked to exist before
 * anything is written, and it is what the printed one-liners select. Saying
 * "3 runs" in the report is the difference between an operator knowingly
 * attaching their ledger and accidentally attaching it.
 */
import type { Clock } from '@DeFlow/core';
import { resolveDataDir, systemClock } from '@DeFlow/daemon';
import { openRead } from '@DeFlow/ledger';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

/** sysexits(3) `EX_NOINPUT` — the ledger or the run is not there. */
export const EX_NOINPUT = 66;
/** sysexits(3) `EX_CANTCREAT` — the output path is already taken. */
export const EX_CANTCREAT = 73;

export interface SnapshotArgs {
  readonly runId: string;
  readonly out: string;
}

export type ParsedLedgerArgs =
  | { readonly ok: true; readonly args: SnapshotArgs }
  | { readonly ok: false; readonly message: string };

/**
 * `ledger snapshot <runId> --out <path>`.
 *
 * `--out` is mandatory rather than defaulted. A diagnostic command with a
 * default output path writes a copy of the operator's entire ledger somewhere
 * they did not name, which is both a surprise and, for a database that holds
 * every prompt and every diff, a bad one.
 */
export function parseLedgerArgs(argv: readonly string[]): ParsedLedgerArgs {
  const [subcommand, ...rest] = argv;
  if (subcommand !== 'snapshot') {
    return {
      ok: false,
      message:
        subcommand === undefined
          ? "DeFlow ledger: expected a subcommand — the only one is 'snapshot'"
          : `DeFlow ledger: unknown subcommand ${JSON.stringify(subcommand)}; the only one is ` +
            "'snapshot'",
    };
  }

  let runId: string | null = null;
  let out: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (argument === '--out' || argument.startsWith('--out=')) {
      const value = argument.startsWith('--out=') ? argument.slice('--out='.length) : rest[++index];
      if (value === undefined || value === '') {
        return { ok: false, message: 'DeFlow ledger snapshot: --out needs a path' };
      }
      out = value;
      continue;
    }
    if (argument.startsWith('-')) {
      return {
        ok: false,
        message: `DeFlow ledger snapshot: unknown option ${JSON.stringify(argument)}`,
      };
    }
    if (runId !== null) {
      return {
        ok: false,
        message: `DeFlow ledger snapshot: unexpected argument ${JSON.stringify(argument)}`,
      };
    }
    runId = argument;
  }

  if (runId === null) {
    return {
      ok: false,
      message: 'DeFlow ledger snapshot: needs a run id — try `DeFlow status` for the live ones',
    };
  }
  if (out === null) {
    return {
      ok: false,
      message:
        'DeFlow ledger snapshot: needs --out <path>; it will not choose a path for a copy of ' +
        'your whole ledger',
    };
  }

  return { ok: true, args: { runId, out } };
}

export interface SnapshotReport {
  readonly out: string;
  readonly runId: string;
  /** Events this snapshot holds for the run being reported on. */
  readonly runEvents: number;
  readonly totalEvents: number;
  readonly runs: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

/** `1.2 MB`, `948 kB`, `512 B` — one figure, so the report stays scannable. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} kB`;
  return `${bytes} B`;
}

/**
 * What the command prints (AC2).
 *
 * The two `sqlite3` one-liners are handed over rather than described: the
 * claim is that the file is inspectable *without DeFlow installed*, and a path
 * with no query beside it leaves the reader to invent one from a schema they
 * have never seen.
 */
export function renderSnapshotReport(report: SnapshotReport): string {
  return [
    `DeFlow ledger snapshot: wrote ${report.out}`,
    `  run       ${report.runId} — ${report.runEvents} events`,
    `  ledger    ${report.runs} runs, ${report.totalEvents} events, ` +
      `${formatBytes(report.bytes)} (${report.elapsedMs} ms)`,
    '  one file, no "-wal" or "-shm" sidecar: safe to attach to an issue.',
    '  inspect it with plain sqlite3, on a machine with no DeFlow at all:',
    `    sqlite3 ${report.out} \\`,
    `      "SELECT seq, kind, node_id, attempt FROM event WHERE run_id='${report.runId}' ` +
      'ORDER BY seq LIMIT 50;"',
    `    sqlite3 ${report.out} "PRAGMA integrity_check;"`,
    '',
  ].join('\n');
}

export interface LedgerSnapshotOptions {
  readonly runId: string;
  /** Where to write. Resolved against `cwd` when it is relative. */
  readonly out: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Time enters here and nowhere else (NF9) — this is the measured figure. */
  readonly clock?: Clock;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const refuse = (exitCode: number, message: string): CommandResult => ({
  exitCode,
  stdout: '',
  stderr: `${message}\n`,
});

/**
 * `DeFlow ledger snapshot` — the whole command, minus the process.
 *
 * Synchronous, because better-sqlite3 is (decision D6) and because pretending
 * otherwise would put an await boundary in the middle of a `VACUUM INTO` that
 * has none.
 */
export function runLedgerSnapshot(options: LedgerSnapshotOptions): CommandResult {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const cwd = options.cwd ?? process.cwd();
  const out = isAbsolute(options.out) ? options.out : resolve(cwd, options.out);
  const ledger = join(resolveDataDir(env), 'ledger.db');

  if (!existsSync(ledger)) {
    return refuse(
      EX_NOINPUT,
      `DeFlow ledger snapshot: there is no ledger at ${ledger} — nothing has run on this machine yet`,
    );
  }
  // Checked before the read rather than left to SQLite, which refuses an
  // existing target with a message about a "output file already exists" and no
  // mention of what to do about it. And never overwritten: clobbering the
  // operator's file is a second incident on top of the one being reported.
  if (existsSync(out)) {
    return refuse(
      EX_CANTCREAT,
      `DeFlow ledger snapshot: ${out} already exists; it was left alone — choose another --out`,
    );
  }

  const startedAt = clock.now();
  const db = openRead(ledger);
  try {
    const runEvents =
      db
        .prepare<{ c: number }>('SELECT count(*) AS c FROM event WHERE run_id = ?')
        .get(options.runId)?.c ?? 0;
    if (runEvents === 0) {
      return refuse(
        EX_NOINPUT,
        `DeFlow ledger snapshot: ${ledger} holds no events for run ${options.runId} — ` +
          "run 'DeFlow status' for the runs it does hold",
      );
    }

    const totals = db
      .prepare<{ events: number; runs: number }>(
        'SELECT count(*) AS events, count(DISTINCT run_id) AS runs FROM event',
      )
      .get() ?? { events: runEvents, runs: 1 };

    // The statement the whole story is about. Bound rather than interpolated:
    // the path is an operator's, and quoting it by hand is how a directory with
    // an apostrophe in it becomes a syntax error at the worst moment.
    db.prepare('VACUUM INTO ?').run(out);

    return {
      exitCode: 0,
      stdout: renderSnapshotReport({
        out,
        runId: options.runId,
        runEvents,
        totalEvents: totals.events,
        runs: totals.runs,
        bytes: statSync(out).size,
        elapsedMs: clock.now() - startedAt,
      }),
      stderr: '',
    };
  } catch (error) {
    return refuse(
      EX_CANTCREAT,
      `DeFlow ledger snapshot: could not write ${out}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    db.close();
  }
}
