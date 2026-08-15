/**
 * KAR-20.2 AC5, AC6 — the one place that writes to a file in the operator's
 * home directory.
 *
 * Two properties, and both of them are about the second run rather than the
 * first. An installer people re-run — and people do re-run installers, usually
 * because nothing seemed to happen the first time — appends a second `export
 * PATH=` line unless it is written not to, and a profile that grows a line per
 * run is a profile somebody eventually deletes in frustration.
 *
 * **The line is written at most once**, decided by reading the file rather than
 * by remembering having written it: a marker comment, a state file or a
 * timestamp would each be a second source of truth about a file the operator
 * also edits by hand.
 *
 * **Two concurrent runs do not interleave.** That is not hypothetical: it is
 * what happens when somebody runs the command, sees nothing change in the
 * current shell — which is correct, and is the whole reason this story exists —
 * and runs it again in another tab. Check-then-append is a race by
 * construction, so the check and the append happen under an exclusive lock: an
 * `O_EXCL` create, which is the one filesystem primitive that is atomic on
 * every filesystem this milestone targets.
 *
 * Verifies: EPIC-20-S16, EPIC-20-S17 · AC5, AC6
 */
import type { Clock } from '@DeFlow/core';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** What `appendProfileLine` did — the difference between a first run and a
 * fixpoint, and the two words the report distinguishes. */
export type ProfileOutcome = 'appended' | 'already';

/** The comment written above the line, so that a reader of the file — a person,
 * six months later — knows who put it there and what removing it costs. */
export const PROFILE_MARKER = '# added by "deflow setup" — puts deflow on PATH';

/**
 * Whether `file` already carries `line`.
 *
 * Compared as a **trimmed whole line** rather than as a substring: a profile
 * that mentions the directory inside some other command has not put it on
 * `PATH`, and a substring match would report a fixpoint that is not one. A file
 * that does not exist has not got the line, which is not an error.
 */
export function profileHasLine(file: string, line: string): boolean {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  return contents.split('\n').some((entry) => entry.trim() === line.trim());
}

/** How long a lock may sit before it is assumed to belong to a dead process. */
const STALE_MS = 30_000;
/** How many times to look again before giving up on the other run. */
const LOCK_ATTEMPTS = 600;
const LOCK_POLL_MS = 25;

/**
 * Blocks this thread for `ms`, without a timer.
 *
 * `Atomics.wait` rather than `clock.sleep` for a reason that cost a real red
 * test: `systemClock.setTimer` **unrefs** its timer, which is right for a
 * daemon that must be able to exit, and fatal here — while one run waits for
 * the other's lock there is nothing else on the event loop, so the process
 * empties it and Node exits 13 with *"unsettled top-level await"*, half way
 * through an install. A blocking wait cannot be raced by an empty loop, needs
 * no handle to keep alive, and costs a CLI that is already about to write one
 * line nothing worth having.
 *
 * The `deadline` is counted in attempts rather than in wall-clock for the same
 * reason nothing else here reads a clock: an injected `Clock` in a spec does
 * not advance, and a timeout expressed against it would never fire.
 */
function waitBriefly(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPathFor(file: string): string {
  return `${file}.deflow-setup.lock`;
}

/**
 * `O_CREAT | O_EXCL` on a sibling of the profile, held for the read and the
 * append.
 *
 * A lock file rather than `flock`: `node:fs` has no portable advisory lock, and
 * an exclusive create is atomic on APFS, ext4 and every network filesystem
 * whose failure to be atomic would already have broken npm. A lock older than
 * `STALE_MS` is taken over rather than waited on, because the alternative to
 * breaking a stale lock is a machine that can never be set up again after one
 * `kill -9`.
 */
function withLock<T>(file: string, clock: Clock, run: () => T): T {
  const lock = lockPathFor(file);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const fd = openSync(lock, 'wx');
      try {
        writeSync(fd, `${String(process.pid)}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = clock.now() - statSync(lock).mtimeMs;
      } catch {
        // It went away between the create and the stat: try again immediately.
        continue;
      }
      if (age > STALE_MS) {
        try {
          unlinkSync(lock);
        } catch {
          // Somebody else took it over first, which is the same outcome.
        }
        continue;
      }
      if (attempt >= LOCK_ATTEMPTS) {
        throw new Error(
          `another "deflow setup" is holding ${lock} and did not finish within ` +
            `${String((LOCK_ATTEMPTS * LOCK_POLL_MS) / 1000)} s. Nothing was written. Wait for it ` +
            'to finish, or remove that file if no such process is running.',
        );
      }
      waitBriefly(LOCK_POLL_MS);
    }
  }

  try {
    return run();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // Already gone: a stale-lock takeover by a third run. Nothing to undo.
    }
  }
}

export interface AppendProfileInput {
  /** The absolute path of the profile file. Created if it does not exist. */
  readonly file: string;
  /** The exact line, in that shell's syntax. */
  readonly line: string;
  readonly clock: Clock;
}

/**
 * Appends `line` to `file` unless it is already there.
 *
 * Throws whatever the filesystem threw — an unwritable home directory is a real
 * outcome with a real errno, and AC8 wants that errno printed rather than
 * flattened into "could not write". The caller turns it into a `fail` row.
 */
export function appendProfileLine(input: AppendProfileInput): ProfileOutcome {
  mkdirSync(dirname(input.file), { recursive: true });
  return withLock(input.file, input.clock, () => {
    if (profileHasLine(input.file, input.line)) return 'already';
    // A leading newline so the marker cannot land on the end of a line the
    // operator wrote without one — which is how a profile gains a syntax error
    // rather than a PATH entry.
    appendFileSync(input.file, `\n${PROFILE_MARKER}\n${input.line}\n`);
    return 'appended';
  });
}
