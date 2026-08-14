/**
 * KAR-20.1 — the command's name, and the one module allowed to spell the old
 * one.
 *
 * ## Why the name changed
 *
 * `claude`, `codex`, `gemini`, `gh`, `git`, `node`, `pnpm` — every neighbour on
 * a shell's `PATH` is lowercase, and a capitalised command is a shift key paid
 * on every invocation forever. It was also a publishing blocker: npm has
 * refused new package names containing capital letters since 2017, so
 * `packages/cli/package.json` could not have been published under the name it
 * carried.
 *
 * ## Why the alias is decided at runtime rather than shipped as a second file
 *
 * macOS's default APFS volume is case-insensitive and Linux's ext4 is not. In
 * the global bin directory that means `deflow` and `DeFlow` are **one**
 * directory entry on a Mac and two on Linux — so there is no design in which
 * the alias is a separate script, because on half the machines it cannot be.
 * Instead there is one entry script, and the notice is decided from
 * `basename(process.argv[1])`: exact on Linux, where the two entries are
 * distinct files, and best-effort on macOS, where the shell passes through
 * whichever spelling the operator typed but the filesystem has only one entry
 * to offer. The behaviour that never differs is that the program runs.
 *
 * ## Why the notice goes to stderr
 *
 * `--json` documents and `run --json`'s NDJSON are contracts (KAR-18.9 AC6). A
 * deprecation notice on stdout breaks every consumer's parse on the first line,
 * which is a worse outcome than the rename it is apologising for.
 *
 * ## When the alias goes
 *
 * `ALIAS_REMOVED_IN`, and `packages/cli/test/command-name.test.ts` fails once
 * this package's version reaches it. An alias nobody removes is a second
 * supported spelling forever; making its expiry a failing test is the only
 * mechanism that has ever worked.
 */
import { basename } from 'node:path';

/**
 * AC8 — what this rename deliberately did **not** touch, and why.
 *
 * Enumerated in the code as well as in the epic file so that the boundary is
 * readable from inside the program rather than only from a document, and so
 * that `test/command-name.test.ts` has something to assert against. Every entry
 * is a name a user never types at a prompt; renaming any of them costs somebody
 * their configuration or their in-flight work, and buys nothing they would
 * notice.
 */
export const NOT_RENAMED: readonly { readonly name: string; readonly why: string }[] = [
  {
    name: '.DeFlow/',
    why: "the repo-local state directory: renaming it orphans every already-initialised repository's committed config and every .gitignore entry `init` wrote",
  },
  {
    name: '$XDG_DATA_HOME/DeFlow',
    why: 'the global state directory: the ledger, the blob store and the daemon lease all live in it, and nobody types a directory name at a prompt',
  },
  {
    name: 'DeFlow_*',
    why: 'the environment variables: a second deprecation window with two spellings live at once, in exchange for nothing a user notices',
  },
  {
    name: '@DeFlow/*',
    why: 'the workspace scope: none of it is published (docs/16-repo-layout.md §2), so it is invisible outside this repository',
  },
  {
    name: 'DeFlow/<runId>__<nodeId>',
    why: 'the branch-name template: renaming it strands in-flight worktrees and branches in repositories DeFlow has already touched',
  },
  {
    name: 'DeFlowd, and the product name in prose',
    why: 'PRD §15.6 owns the product name; this rename settles the casing of the command and does not pre-empt it',
  },
];

/** What users type, what npm publishes, and what the `bin` map declares. */
export const COMMAND = 'deflow';

/** The pre-rename spelling, kept working for one release. */
export const DEPRECATED_COMMAND = 'DeFlow';

/**
 * The release the alias is removed in — the one after the release that
 * introduces it. Written here **and** into the notice, so a reader who sees the
 * line once never has to go looking for the date.
 */
export const ALIAS_REMOVED_IN = '0.2.0';

/**
 * The spelling this process was invoked under, or `undefined` when there is
 * nothing to read.
 *
 * `argv[1]` is the path the caller named — a symlink in the global bin
 * directory, not its target — so the spelling survives even where the
 * filesystem has folded the two names into one entry.
 */
export function invokedAs(argv1: string | undefined): string | undefined {
  if (argv1 === undefined || argv1 === '') return undefined;
  return basename(argv1);
}

/**
 * The one line the old name prints to **stderr**, or `undefined` for every
 * other way of starting the program.
 *
 * Running `dist/bin.mjs` or `src/bin.ts` by path — which is how the monorepo,
 * the tarball's own tests and `npx <tgz>` all start it — is not a user typing
 * the old name, and a notice on those is noise in every spec in the repository.
 */
export function deprecationNotice(argv1: string | undefined): string | undefined {
  if (invokedAs(argv1) !== DEPRECATED_COMMAND) return undefined;
  return (
    `${DEPRECATED_COMMAND} is the old name of this command and is removed in ` +
    `${ALIAS_REMOVED_IN} — run ${COMMAND} instead.\n`
  );
}
