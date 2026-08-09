/**
 * `ps -eo pid,pgid,stat`, read independently of the daemon's own reader.
 *
 * KAR-06.7 AC7 is a claim about a **filter**, and a spec that verified it with
 * the same function the production path uses would pass whether or not that
 * function filters anything. So this is a second, deliberately dumb
 * implementation of the same query, and the specs assert both halves: the
 * `Z`-filtered view is empty *and* the unfiltered one is not, at the same
 * instant, so the filter cannot pass vacuously.
 *
 * `/bin/ps` absolutely, never `ps` for `PATH` to answer (§4.3).
 */
import { waitFor } from '@DeFlow/testkit';
import { execFileSync } from 'node:child_process';

export interface PsRow {
  readonly pid: number;
  /**
   * The parent. `1` is the evidence that init adopted an orphan — which is
   * what a positive-pid kill leaves behind (EPIC-08-S28).
   */
  readonly ppid: number;
  readonly pgid: number;
  /** The `STAT` column: `S`, `Ss`, `Z`, `R+`, … */
  readonly stat: string;
  /**
   * The `UCOMM` column — `ucomm` rather than `comm` because it is the one both
   * darwin and linux print as a bare name.
   *
   * What a spec needs it for is knowing whether a fixture has reached its
   * `exec` yet: a process still showing as `sh`, before it has run
   * `trap "" TERM; exec sleep`, carries the *default* SIGTERM disposition and
   * will die on the first signal. Counting rows cannot see that difference, so
   * a spec that waits on a count alone is waiting for the wrong thing.
   */
  readonly comm: string;
}

function readTable(): PsRow[] {
  let out: string;
  try {
    out = execFileSync('/bin/ps', ['-eo', 'pid,ppid,pgid,stat,ucomm'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 4 && /^\d+$/.test(parts[0] ?? ''))
    .map((parts) => ({
      pid: Number(parts[0]),
      ppid: Number(parts[1]),
      pgid: Number(parts[2]),
      stat: parts[3] as string,
      // Joined rather than `parts[4]`: a process name may itself contain
      // spaces, and a truncated `comm` would silently stop matching.
      comm: parts.slice(4).join(' '),
    }));
}

/** Every process in `pgid`, **zombies included**. */
export function groupRows(pgid: number): PsRow[] {
  return readTable().filter((row) => row.pgid === pgid);
}

/** One process's row, wherever it is, or `undefined` when it is gone. */
export const rowOf = (pid: number): PsRow | undefined => readTable().find((row) => row.pid === pid);

/** The `$3 !~ /Z/` half of AC7's command: dead-but-unreaped is not a survivor. */
export const liveRows = (pgid: number): PsRow[] =>
  groupRows(pgid).filter((row) => !row.stat.includes('Z'));

/**
 * Waits until the `ignore-sigterm` fixture's two children are actually
 * SIGTERM-proof, rather than merely present.
 *
 * They are `sh -c 'trap "" TERM; exec sleep 300'`, and the `exec` is the
 * observable end of the window in which the shell still carries the default
 * disposition: `trap` runs strictly before it, and POSIX preserves an *ignored*
 * disposition across `exec` while resetting handlers to default. So a row whose
 * `comm` is `sleep` has SIG_IGN, and one still showing `sh` does not.
 *
 * Measured on this machine at 6-27 ms from spawn, widening with load — which is
 * why a gate that counted live rows passed in isolation and handed the
 * escalation specs a tree that died on rung 2 under a saturated box.
 */
export async function waitForSigtermProof(pgid: number, children = 2): Promise<void> {
  // Stated over the non-leader rows, and as "every one of them has exec'd"
  // rather than "at least N rows say `sleep`". The weaker form can be satisfied
  // by a transient child that merely happens to be named `sleep`, which is a
  // readiness check that reports ready for the wrong reason.
  const followers = (): PsRow[] => liveRows(pgid).filter((row) => row.pid !== pgid);
  await waitFor(
    () => {
      const rows = followers();
      return rows.length >= children && rows.every((row) => row.comm.endsWith('sleep'));
    },
    {
      describe: `both SIGTERM-ignoring children of pgid ${pgid} to have reached their exec`,
    },
  );
}

/** SIGKILLs `pgid`, saying nothing when it has already gone. */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already reaped.
  }
}
