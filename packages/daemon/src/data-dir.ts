/**
 * Where DeFlowd's global state lives (docs/16-repo-layout.md §7.2).
 *
 * `$XDG_DATA_HOME/DeFlow`, else `~/.DeFlow`: the lease file, `ledger.db` and
 * its WAL, the blob store, the provider probe cache and the pre-migration
 * backups. Global rather than per-repo because the thing the lease protects
 * against is global — one user running `npx deflow up` in two terminals — and
 * because the ledger is a single cross-run database.
 *
 * Pure, and takes the environment as an argument: the answer decides which
 * file the lease is taken on, so a spec has to be able to ask for it without
 * mutating `process.env` out from under a parallel worker.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** Overrides everything. How a test — and `deflow up --data-dir` — gets its own. */
export const DATA_DIR_ENV = 'DeFlow_DATA_DIR';

/** The directory name under `$XDG_DATA_HOME`, and the dotted one under `$HOME`. */
const XDG_SUBDIR = 'DeFlow';
const HOME_SUBDIR = '.DeFlow';

export type DataDirEnv = Readonly<Record<string, string | undefined>>;

export function resolveDataDir(env: DataDirEnv = process.env): string {
  const explicit = env[DATA_DIR_ENV];
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);

  // The XDG base directory specification is explicit that a relative
  // $XDG_DATA_HOME is invalid and must be ignored. Resolving one instead would
  // give a daemon a different data directory depending on the working
  // directory it was started from — two lock files, two ledgers, and a lease
  // that sees nothing wrong.
  const xdg = env.XDG_DATA_HOME;
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) return join(xdg, XDG_SUBDIR);

  return join(homedir(), HOME_SUBDIR);
}
