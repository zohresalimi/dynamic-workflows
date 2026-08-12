/**
 * KAR-18.4 — the two filesystem questions `doctor` asks over and over.
 *
 * **"Is this binary on that `PATH`?"** — answered against the *roots the
 * caller passed*, never against `process.env.PATH` read in here. Doctor runs
 * in the operator's own terminal, which is the one context in the project
 * where reading their `PATH` is correct rather than a machine-specific bug
 * (docs/07-provider-adapter-layer.md §4.3), and it is still the caller's job
 * to say so.
 *
 * **"Can I write here?"** — answered by *writing*, and this is the whole point
 * of EPIC-18-S33: a directory that exists and is not writable is the common
 * case — a repo checked out by another user, a read-only mount, an
 * `$XDG_DATA_HOME` pointing somewhere managed — and `existsSync` reports every
 * one of them as fine. The probe file is removed again, and its name carries
 * the pid so two doctors racing in the same directory cannot delete each
 * other's.
 */
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** The first executable `name` under `roots`, in order, or `null`. */
export function resolveOnPath(roots: readonly string[], name: string): string | null {
  for (const root of roots) {
    if (root === '') continue;
    const candidate = join(root, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable — either way, keep looking. A binary that
      // exists without the exec bit is not a binary this machine can run.
    }
  }
  return null;
}

export interface WriteProbe {
  readonly writable: boolean;
  /** The errno as git and libc name it — `EACCES`, `EROFS`, `ENOSPC`. */
  readonly errno: string | null;
  /** The message the OS gave, for the reason line. */
  readonly message: string | null;
}

const OK: WriteProbe = { writable: true, errno: null, message: null };

function failed(error: unknown): WriteProbe {
  const errno = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  return {
    writable: false,
    errno,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Creates `dir` if it is missing, then writes a file into it and removes it.
 *
 * Creating is part of the question rather than a side effect: a state
 * directory that does not exist yet and cannot be created is exactly as
 * unusable as one that exists and refuses a write, and reporting the second
 * while silently passing the first would send the operator to the wrong fix.
 */
export function probeWritable(dir: string): WriteProbe {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return failed(error);
  }

  const probe = join(dir, `.DeFlow-doctor-${process.pid}`);
  try {
    writeFileSync(probe, '');
    return OK;
  } catch (error) {
    return failed(error);
  } finally {
    rmSync(probe, { force: true });
  }
}
