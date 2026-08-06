/**
 * KAR-07.6 — `git merge-tree --write-tree` as a read-only conflict probe
 * (docs/09-workspace-and-safety.md §6.1; Decision D14).
 *
 * The whole of D14 rests on one verified property: `merge-tree` has **no side
 * effects at all**. It touches neither the index nor any working tree, which
 * is what makes it safe to run against live worktrees at any moment, and which
 * is why a *continuous* probe is possible where `git merge` would be a
 * catastrophe. The integration spec hashes both worktrees around a probe
 * rather than trusting that sentence.
 *
 * Three details are the difference between this working and looking like it
 * works.
 *
 * **The exit code is the signal.** Piping `merge-tree` through anything
 * replaces `$?` with the pipeline's status and a conflict becomes
 * indistinguishable from a clean merge. That is why `runGit` uses
 * `reject: false` and hands the exit code back as data, and why nothing here
 * builds a command string.
 *
 * **The output is framed, not just prefixed.** `--name-only -z` produces
 * `<tree oid> NUL <conflicted paths…> NUL NUL <informational messages…>`. The
 * architecture doc's illustrative snippet is
 * `stdout.split("\0").slice(1).filter(Boolean)`, which drops the tree oid and
 * then returns the message block as though every `CONFLICT (content): Merge
 * conflict in f.txt` were a path. The section terminator — an empty field — is
 * where the paths stop.
 *
 * **Exit 1 is not always a conflict.** Verified on git 2.50.1: a ref that does
 * not resolve also exits 1, with an empty stdout and
 * `merge-tree: <ref> - not something we can merge` on stderr. So the exit code
 * alone cannot tell a conflict from a failed invocation, and reading git's
 * message text to tell them apart is the mistake §3.1 exists to forbid. The
 * positive signal is structural instead: a merge that *ran* always writes a
 * tree oid as its first field. No oid, no merge, `GitError`.
 *
 * Verifies: EPIC-07-S23, EPIC-07-S24 · AC1, AC2, AC3
 */
import { GitError } from './git-error.ts';
import type { GitResult } from './run-git.ts';

/**
 * The `Git` wrapper's own shape, injected so a spec can record the argv while
 * real git still does the work. Structurally the same port
 * `./worktree-manager.ts` takes, and satisfied by `Git` itself.
 */
export interface GitPort {
  run(args: readonly string[], opts?: { readonly cwd?: string }): Promise<GitResult>;
}

/** AC2 — the invocation, exactly. `--name-only` reduces the output to bare
 * paths and `-z` makes it machine-parseable; both are load-bearing. */
export const MERGE_TREE_ARGS: readonly string[] = [
  'merge-tree',
  '--write-tree',
  '--name-only',
  '-z',
];

export function mergeTreeArgs(a: string, b: string): string[] {
  return [...MERGE_TREE_ARGS, a, b];
}

/** What one probe of a branch pair says. Exactly AC1's shape: a `treeOid`
 * nothing reads would be a field the ledger then has to keep for ever. */
export interface MergeTreeResult {
  readonly clean: boolean;
  /** Conflicted paths, `--name-only`'s own spelling of them. Empty when clean. */
  readonly paths: readonly string[];
}

const OID = /^[0-9a-f]{40,64}$/;

/**
 * The `<oid> NUL <paths…> NUL NUL <messages…>` frame, or `null` when stdout
 * does not begin with a tree oid — which means the merge never ran.
 */
export function parseMergeTreeOutput(stdout: string): { oid: string; paths: string[] } | null {
  const [oid, ...rest] = stdout.split('\0');
  if (oid === undefined || !OID.test(oid)) return null;

  const end = rest.indexOf('');
  return { oid, paths: end === -1 ? rest.filter((path) => path !== '') : rest.slice(0, end) };
}

/**
 * One pairwise probe. Resolves `{ clean: true, paths: [] }` on exit 0 and
 * `{ clean: false, paths }` on a conflict; throws `GitError` carrying git's
 * stderr for anything else (AC1).
 */
export async function mergeTree(git: GitPort, a: string, b: string): Promise<MergeTreeResult> {
  const args = mergeTreeArgs(a, b);
  const result = await git.run(args);

  if (result.exitCode === 0) return { clean: true, paths: [] };

  const parsed = result.exitCode === 1 ? parseMergeTreeOutput(result.stdout) : null;
  if (parsed === null) throw new GitError('merge-tree failed', args, result);

  return { clean: false, paths: parsed.paths };
}

// ── KAR-07.7 — the same subcommand, without `--name-only` ────────────────────
//
// The second form lives here rather than beside its caller because the whole
// package spells `'merge-tree'` in exactly one file (asserted by
// ../../test/no-piped-git.test.ts), and that rule is what stops a second call
// site being introduced somewhere that pipes the output and destroys the exit
// code the conflict signal *is*.
//
// `--name-only` reduces the answer to "which paths"; §7.2 needs "and what does
// the conflict look like", which is the stage entries plus the tree
// `--write-tree` writes — a tree in which every conflicted file holds git's own
// conflict-marked merge.

/** The `--write-tree` form without `--name-only`: the stage lines are what
 * `--name-only` throws away, and they are what §7.2 names as the source. */
export const MERGE_TREE_STAGES_ARGS: readonly string[] = ['merge-tree', '--write-tree', '-z'];

export function mergeTreeStagesArgs(a: string, b: string): string[] {
  return [...MERGE_TREE_STAGES_ARGS, a, b];
}

/** One `<mode> <oid> <stage>\t<path>` entry. Stage 1 is the merge base, 2 is
 * the first parent's side, 3 is the second's. */
export interface ConflictStage {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  readonly path: string;
}

export interface MergeTreeStages {
  /** The tree `--write-tree` wrote, in which each conflicted path holds git's
   * own conflict-marked merge. */
  readonly treeOid: string;
  readonly stages: readonly ConflictStage[];
}

const STAGE_LINE = /^(?<mode>[0-7]{6}) (?<oid>[0-9a-f]{40,64}) (?<stage>[123])\t(?<path>.+)$/s;

/**
 * The stage section of `merge-tree --write-tree -z`, or `null` when stdout
 * does not begin with a tree oid — the same structural signal
 * `parseMergeTreeOutput` uses, and for the same reason: exit 1 alone cannot
 * tell a conflict from an invocation that never ran.
 */
export function parseMergeTreeStages(stdout: string): MergeTreeStages | null {
  const [treeOid, ...rest] = stdout.split('\0');
  if (treeOid === undefined || !OID.test(treeOid)) return null;

  const end = rest.indexOf('');
  const entries = end === -1 ? rest.filter((field) => field !== '') : rest.slice(0, end);

  const stages: ConflictStage[] = [];
  for (const entry of entries) {
    const groups = STAGE_LINE.exec(entry)?.groups;
    if (groups === undefined) continue;
    stages.push({
      mode: groups.mode as string,
      oid: groups.oid as string,
      stage: Number(groups.stage),
      path: groups.path as string,
    });
  }
  return { treeOid, stages };
}
