/**
 * `gh`, run through the one vendor-CLI spawn seam.
 *
 * KAR-22.4 extracted this out of `../intake/resolve-issue.ts` so there would be
 * exactly one place a `gh` child is created. KAR-22.6 needed the identical
 * child for Atlassian's `acli`, so the spawn itself moved down one level to
 * `../cli/run-cli.ts` and this file became the `gh`-shaped name for it — one
 * seam for two CLIs rather than two seams, which is what keeps ADR-0003's "and
 * DeFlow never captures a login command's output" checkable by reading a single
 * module's import graph.
 *
 * The reasoning about process groups, the injected `Clock` and `killTree` lives
 * in `../cli/run-cli.ts` with the code it explains.
 */
import type { CliInvocation, RunCliOptions } from '../cli/run-cli.ts';
import { runCli } from '../cli/run-cli.ts';

export type GhInvocation = CliInvocation;
export type RunGhOptions = RunCliOptions;

/**
 * Runs `gh` with `args` and returns everything it did.
 *
 * Never throws for anything `gh` itself did: a non-zero exit, a signal and a
 * missing binary are all values, because every caller has to render them.
 */
export function runGh(args: readonly string[], options: RunGhOptions): Promise<GhInvocation> {
  return runCli('gh', args, options);
}
