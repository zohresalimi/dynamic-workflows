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
import { execFileSync } from 'node:child_process';

export interface PsRow {
  readonly pid: number;
  readonly pgid: number;
  /** The `STAT` column: `S`, `Ss`, `Z`, `R+`, … */
  readonly stat: string;
}

/** Every process in `pgid`, **zombies included**. */
export function groupRows(pgid: number): PsRow[] {
  let out: string;
  try {
    out = execFileSync('/bin/ps', ['-eo', 'pid,pgid,stat'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 3 && /^\d+$/.test(parts[0] ?? ''))
    .map((parts) => ({
      pid: Number(parts[0]),
      pgid: Number(parts[1]),
      stat: parts[2] as string,
    }))
    .filter((row) => row.pgid === pgid);
}

/** The `$3 !~ /Z/` half of AC7's command: dead-but-unreaped is not a survivor. */
export const liveRows = (pgid: number): PsRow[] =>
  groupRows(pgid).filter((row) => !row.stat.includes('Z'));

/** SIGKILLs `pgid`, saying nothing when it has already gone. */
export function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // Already reaped.
  }
}
