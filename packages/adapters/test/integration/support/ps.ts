/**
 * The process table, as `ps` reports it — and the `Z` filter that every
 * kill-verification assertion in this package has to apply.
 *
 * After a *successful* group SIGKILL the OS still lists the members until their
 * parent collects them: state `Z`, already dead. An assertion that counts those
 * concludes the kill failed when it did not, and it bites hardest inside
 * containers, where reaping lags and a debugger cannot be attached
 * (docs/14-testing-strategy.md §10, KAR-05.9 AC4).
 *
 * `/bin/ps` absolutely, never `ps` for `PATH` to answer (§4.3).
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

export interface PsRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** The `STAT` column: `S`, `Ss`, `Z`, `R+`, … */
  readonly stat: string;
  /**
   * The accounting name of the running executable.
   *
   * `ucomm` rather than `comm` because it is the one both darwin and linux
   * print as a bare name, and because what a spec needs it for is knowing
   * whether a fixture has reached its `exec` yet — a shell that has not yet run
   * `trap "" TERM; exec sleep` is a process that will still die on SIGTERM.
   */
  readonly comm: string;
}

const COLUMNS = 'pid=,ppid=,stat=,pgid=,ucomm=';

function parse(out: string): PsRow[] {
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4 && /^\d+$/.test(parts[0] ?? ''))
    .map((parts) => ({
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      stat: parts[2] as string,
      pgid: Number(parts[3]),
      comm: parts[4] ?? '',
    }));
}

/** Every process in `pgid`, **including zombies**. */
export function groupRows(pgid: number): PsRow[] {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  try {
    return parse(
      execFileSync('/bin/ps', ['-o', COLUMNS, '-g', String(pgid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    // `ps` exits non-zero when the group is empty, which is the answer.
    return [];
  }
}

/** Every process in `pgid` that is not a zombie. The load-bearing filter. */
export const liveRows = (pgid: number): PsRow[] =>
  groupRows(pgid).filter((row) => !row.stat.includes('Z'));

/** One process's row, wherever it is, or `undefined` when it is gone. */
export function rowOf(pid: number): PsRow | undefined {
  try {
    return parse(
      execFileSync('/bin/ps', ['-o', COLUMNS, '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )[0];
  } catch {
    return undefined;
  }
}

/** This test process's own process group — what a non-detached child joins. */
export function ownPgid(): number {
  return (
    rowOf(process.pid)?.pgid ??
    (() => {
      throw new Error('could not read this process own pgid');
    })()
  );
}

/** SIGKILLs `pgid`, and says nothing when it has already gone. */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already reaped.
  }
}
