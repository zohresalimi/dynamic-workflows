/**
 * KAR-15.2 AC7 — `.DeFlow/daemon.json`, and the URL `DeFlow up` prints.
 *
 * The file is how everything else on this machine finds the running daemon:
 * `DeFlow status` reads the pid, `DeFlow run` reads the port and the token, and
 * a second `DeFlow up` reads the pid to decide whether it is a stale file or a
 * live daemon (EPIC-18). It is written at mode `0600` in the gitignored data
 * directory, because the first person to commit a `daemon.json` commits a
 * bearer token.
 *
 * **The honest limit, recorded next to the control:** a process running *as the
 * user* can read this file. That is the whole of what mode `0600` buys — it
 * raises the bar from "trivial" to "requires filesystem access as the user",
 * and it does not eliminate the class. Only OS-level isolation would.
 *
 * The printed URL puts the token in the **fragment**, never a query string
 * (docs/11-api-and-realtime.md §8.1, docs/15-security-model.md §3.2).
 * Fragments are never sent to the server, so the token cannot land in an
 * access log — its own, or anybody's proxy's. A query string would put it in
 * shell history, terminal scrollback, browser history, the `Referer` header of
 * any outbound link, and any access log anyone ever adds.
 */
import { processStartTime } from '@DeFlow/adapters';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** The file's name inside the data directory. */
export const DAEMON_FILE_NAME = 'daemon.json';

/** The mode it is written at, and re-`chmod`ed to if it already existed. */
export const DAEMON_FILE_MODE = 0o600;

export interface DaemonFile {
  readonly pid: number;
  /** The port actually bound, which is not always the port requested. */
  readonly port: number;
  readonly token: string;
  /** Epoch milliseconds, from the daemon's `Clock` port. */
  readonly startedAt: number;
  /**
   * KAR-18.7 AC4 — when the OS says this pid started, as an **opaque string**.
   *
   * `startedAt` above cannot answer "is pid 4242 still *this* daemon?": it is
   * wall-clock milliseconds, and the only thing the OS will tell you about a
   * pid is its own start time in its own units — `/proc/<pid>/stat` field 22 in
   * ticks since boot on Linux, `ps -o lstart=` to the second on macOS. Compared
   * for equality and never parsed, exactly as the boot reaper compares it
   * (../reaper.ts): pids are recycled within hours, and a `DeFlow status` that
   * trusted a bare pid would report an unrelated process as a live daemon and
   * invite the operator to kill it.
   *
   * `null` when the platform cannot answer — Windows, which NF5 puts at M3.
   * "We could not verify it" is then reported as such rather than as a
   * running daemon, which is the same refusal the reaper makes.
   */
  readonly processStartedAt: string | null;
}

/**
 * This process's start time as the OS reports it, or `null`.
 *
 * Never throws: on a platform with no implementation the honest answer is "no
 * evidence", and a daemon that refused to write its own file over it would be
 * a daemon that cannot start.
 */
export function ownProcessStartTime(): string | null {
  try {
    return processStartTime(process.pid);
  } catch {
    return null;
  }
}

export function daemonFilePath(dataDir: string): string {
  return join(dataDir, DAEMON_FILE_NAME);
}

/**
 * Writes the file, and makes sure of the mode.
 *
 * `writeFileSync`'s `mode` applies only when the file is *created*, so a
 * `daemon.json` left behind by a previous daemon — or by a user who copied one
 * — would keep whatever mode it had. The explicit `chmod` after the write is
 * what makes `0600` a property of the file rather than of the first daemon to
 * create it.
 */
export function writeDaemonFile(dataDir: string, file: DaemonFile): string {
  const path = daemonFilePath(dataDir);
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: DAEMON_FILE_MODE });
  chmodSync(path, DAEMON_FILE_MODE);
  return path;
}

/** Removes it on shutdown, so nothing points at a dead daemon's port. */
export function removeDaemonFile(dataDir: string): void {
  rmSync(daemonFilePath(dataDir), { force: true });
}

/**
 * The first-run handoff URL: `http://127.0.0.1:<port>/#token=<token>`.
 *
 * Always a loopback address in the printed form even when the daemon was told
 * to bind elsewhere — the operator is at the machine, and handing them a LAN
 * address would be handing the token to whatever else can read that terminal.
 */
export function handoffUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${token}`;
}
