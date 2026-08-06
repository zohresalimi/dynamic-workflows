/**
 * KAR-07.7 — the conflicted hunks, and nothing else
 * (docs/09-workspace-and-safety.md §7.2; AC5).
 *
 * §7.2's rule is a budget rule with a correctness consequence: *never hand a
 * resolver the whole repository*. So the resolution node's packet is built
 * from two things this module produces — the set of conflicted paths, and the
 * conflicted regions inside each of them — and from nothing that touches the
 * working tree, which is what makes "the packet contains no file that was not
 * conflicted" a property of the code rather than of a reviewer's attention.
 *
 * **Where the hunks come from.** `git merge-tree --write-tree` answers with a
 * real tree object, and in that tree every conflicted file is git's own
 * conflict-marked merge — the same bytes `git merge` would leave in the
 * working tree, produced without a working tree existing. So the stage lines
 * give the paths (and which stages exist, which is how an add/add conflict
 * with no stage 1 is distinguishable from a content conflict), and the written
 * tree gives the markers. Reconstructing the hunks from the three stage blobs
 * with `git merge-file` would be a second, differently-configured merge of the
 * same inputs; reading the tree git just wrote is the same answer with one
 * fewer thing to disagree with.
 *
 * The `-z` framing is the one ../git/merge-tree.ts already documents and
 * pins against real git: `<tree oid> NUL <stage entries…> NUL NUL
 * <informational messages…>`. The empty field is the section terminator, and a
 * parser that runs to the end of the string instead returns git's English as
 * though it were repository content.
 *
 * Verifies: EPIC-07-S27 · AC5
 */
import { GitError } from '../git/git-error.ts';
import {
  type ConflictStage,
  type GitPort,
  mergeTreeStagesArgs,
  parseMergeTreeStages,
} from '../git/merge-tree.ts';

export type { ConflictStage, MergeTreeStages } from '../git/merge-tree.ts';

/** A conflicted file, reduced to the regions a resolver actually has to read. */
export interface ConflictedFile {
  readonly path: string;
  /** Each `<<<<<<<` … `>>>>>>>` region, markers included. */
  readonly hunks: readonly string[];
}

/**
 * A conflicted file whose markers do not close.
 *
 * Thrown rather than skipped: an empty hunk list for a file git reported as
 * conflicted is a packet that tells the resolver nothing conflicted, which is
 * the one failure here that produces a confident wrong answer instead of an
 * error.
 */
export class MalformedConflictError extends Error {
  readonly path: string | undefined;

  constructor(detail: string, path?: string) {
    super(`malformed conflict markers${path === undefined ? '' : ` in ${path}`}: ${detail}`);
    this.name = 'MalformedConflictError';
    this.path = path;
  }
}

/** Each conflicted path once, in the order git listed its stages. */
export function conflictedPaths(stages: readonly ConflictStage[]): string[] {
  return [...new Set(stages.map((stage) => stage.path))];
}

const HUNK_START = '<<<<<<<';
const HUNK_END = '>>>>>>>';

/**
 * Every conflicted region of a merged file, markers included and everything
 * outside them excluded (AC5).
 *
 * The markers are kept because they are the only thing that tells the resolver
 * which side is which, and because a hunk stripped of them is no longer
 * something the resolver can be asked to rewrite in place.
 */
export function extractConflictHunks(text: string, path?: string): string[] {
  const hunks: string[] = [];
  let current: string[] | null = null;

  for (const line of text.split('\n')) {
    if (line.startsWith(HUNK_START)) {
      if (current !== null) {
        throw new MalformedConflictError(`a second "${HUNK_START}" before the first closed`, path);
      }
      current = [line];
      continue;
    }
    if (current === null) continue;
    current.push(line);
    if (line.startsWith(HUNK_END)) {
      hunks.push(current.join('\n'));
      current = null;
    }
  }

  if (current !== null) {
    throw new MalformedConflictError(`"${HUNK_START}" with no closing "${HUNK_END}"`, path);
  }
  return hunks;
}

/**
 * AC5 — one `merge-tree` and one `cat-file` per conflicted path, and no read
 * of any working tree.
 *
 * Resolves to an empty array when the two branches merge cleanly: "there is
 * nothing to resolve" is an answer, not an error.
 */
export async function conflictedFiles(
  git: GitPort,
  a: string,
  b: string,
): Promise<ConflictedFile[]> {
  const args = mergeTreeStagesArgs(a, b);
  const result = await git.run(args);
  if (result.exitCode === 0) return [];

  const parsed = result.exitCode === 1 ? parseMergeTreeStages(result.stdout) : null;
  if (parsed === null) throw new GitError('merge-tree failed', args, result);

  const files: ConflictedFile[] = [];
  for (const path of conflictedPaths(parsed.stages)) {
    // `<tree>:<path>` is an object name, not a positional path, so a path that
    // begins with a dash cannot be read as a flag here.
    const show = ['cat-file', '-p', `${parsed.treeOid}:${path}`];
    const blob = await git.run(show);
    if (blob.exitCode !== 0) throw new GitError('cat-file failed', show, blob);
    files.push({ path, hunks: extractConflictHunks(blob.stdout, path) });
  }
  return files;
}
