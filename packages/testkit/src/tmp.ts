/**
 * Real temp directories (docs/14-testing-strategy.md §5).
 *
 * Real, not `memfs`: a virtual filesystem is invisible to the real `git` binary
 * and to every child process DeFlow spawns, which is the entire surface under
 * test. `memfs` is acceptable only for pure artifact-store unit tests that never
 * hand a path to a child.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every directory this fixture makes is `<os tmpdir>/DeFlow-<random>`. */
export const TMP_PREFIX = 'DeFlow-';

/**
 * Set this to keep the directory after a test finishes.
 *
 * Not optional polish: in CI it pairs with `actions/upload-artifact` on failure,
 * and without it a post-mortem on a broken worktree is impossible.
 */
export const KEEP_TMP_ENV = 'DeFlow_KEEP_TMP';

/** A fresh `<os tmpdir>/DeFlow-<random>` directory. */
export function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), TMP_PREFIX));
}

/**
 * Teardown removes the directory **only when `DeFlow_KEEP_TMP` is unset**. Set
 * but empty counts as set: exporting the variable at all is a request to look
 * at what the test left behind.
 */
export function shouldRemoveTempDir(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[KEEP_TMP_ENV] === undefined;
}

/** Removes `dir` if the environment allows it. Returns whether it did. */
export async function removeTempDir(
  dir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  if (!shouldRemoveTempDir(env)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}
