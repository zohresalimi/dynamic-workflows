/**
 * KAR-05.3 AC4 — turning "which file do I run" into an absolute path, or into
 * a failure that says what was looked for and where.
 *
 * **`PATH` is never consulted.** DeFlowd's environment at daemon start is not
 * the user's login-shell environment — a daemon started by a login item, a
 * systemd unit or `npx` inherits a different one — so a lookup that works in a
 * terminal fails under the daemon, on someone else's machine, as an `ENOENT`
 * that names nothing (docs/07-provider-adapter-layer.md §4.3). Candidate
 * directories are configuration, passed in; the resolved path is persisted in
 * the capability row and passed explicitly from then on.
 *
 * Synchronous on purpose. Resolution happens at probe time and at spawn time,
 * once each, against a handful of paths; making it async would make every
 * `ProviderSpec.resolve` a promise and every caller of `spawnPlan` an async
 * function to save a few microseconds of `stat` at a moment when the daemon
 * has nothing else to do.
 *
 * The errno is kept per candidate rather than collapsed. "The file is not
 * there" and "the file is there and is not executable" are different problems
 * with different fixes — an install versus a `chmod` — and a resolver that
 * reported only the first one sends the operator looking for the wrong thing.
 */
import type { ProviderId } from '@DeFlow/core';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { resolutionFailed } from './failures.ts';

/** One candidate that did not work out, and why. */
export interface SearchedPath {
  readonly path: string;
  /** `ENOENT`, `EACCES`, `EISDIR`, `ENOTABS` — the errno, never a sentence. */
  readonly code: string;
}

/** Where a binary may be looked for. Directories, in order, and nothing else. */
export interface ResolveContext {
  /**
   * Absolute directories to search, in order — the vendor install locations
   * DeFlow was configured with. An empty list is legitimate and resolves
   * nothing, which is how a machine with no agents installed reports itself.
   */
  readonly roots: readonly string[];
  /**
   * A path a capability row already recorded. Checked, never trusted: a binary
   * can be upgraded, moved or `chmod`ed under a running daemon, and a stored
   * path that no longer resolves has to fail like any other.
   */
  readonly binaryPath?: string;
  /** Roots for the vendor CLI an adapter drives, when it lives elsewhere. */
  readonly companionRoots?: readonly string[];
  /** A recorded path for that vendor CLI, checked the same way. */
  readonly companionPath?: string;
}

/** A provider resolved to files that exist and are executable, right now. */
export interface ResolvedProvider {
  readonly provider: ProviderId;
  /** Absolute path to the binary that speaks ACP. */
  readonly path: string;
  /** Absolute path to the vendor CLI an adapter drives, where there is one. */
  readonly companionPath?: string;
}

function errnoOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** `null` when `path` is a file this process can execute; the errno otherwise. */
function inspect(path: string): string | null {
  if (!isAbsolute(path)) return 'ENOTABS';
  try {
    // Follows symlinks deliberately: a vendor CLI installed by a version
    // manager is usually a link, and what matters is what it points at.
    if (!statSync(path).isFile()) return 'EISDIR';
  } catch (error) {
    return errnoOf(error) ?? 'ENOENT';
  }
  try {
    accessSync(path, constants.X_OK);
  } catch (error) {
    return errnoOf(error) ?? 'EACCES';
  }
  return null;
}

/**
 * The first candidate that is an executable file, or a tagged
 * `adapter.spawn-failed` naming the provider, the binary and every path tried.
 */
export function resolveExecutable(
  provider: ProviderId,
  bin: string,
  ctx: Pick<ResolveContext, 'roots' | 'binaryPath'>,
): string {
  const candidates =
    ctx.binaryPath === undefined ? ctx.roots.map((root) => join(root, bin)) : [ctx.binaryPath];

  const searched: SearchedPath[] = [];
  for (const path of candidates) {
    const code = inspect(path);
    if (code === null) return path;
    searched.push({ path, code });
  }
  throw resolutionFailed(provider, bin, searched);
}
