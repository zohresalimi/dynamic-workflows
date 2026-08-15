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

/** What users type, and what the `bin` map declares. */
export const COMMAND = 'deflow';

/**
 * What npm publishes — which is **not** the command (owner's decision,
 * 2026-08-15).
 *
 * `deflow` on npm is [an unrelated Redis-backed job-flow
 * library](https://www.npmjs.com/package/deflow) at 0.6.4, published in 2021 by
 * somebody else. Nothing about that is negotiable from here: npm gives names
 * away first-come, and the name was gone before this project existed. So the
 * package is `deflowai`, verified free on the registry on 2026-08-15.
 *
 * A `bin` key does not have to match the package that declares it, so the
 * command an operator types did not have to move with it. What did move is
 * every **npx** line, because `npx <name>` resolves a *package*: the old form
 * fetches and executes a stranger's code, which is a good deal worse than a
 * command that does not exist. `test/command-name.test.ts` fails on any bare
 * npx route naming the command rather than the package, for that reason.
 */
export const PACKAGE_NAME = 'deflowai';

/**
 * The short alias, installed plainly beside `COMMAND` (owner's decision,
 * 2026-08-15).
 *
 * `dfl`, and not `df`, and the difference is the whole point: `df` is POSIX.1's
 * disk-free utility, present on every Unix machine this project supports.
 * npm's global bin directory is usually *ahead* of `/bin` on `PATH`, so a `df`
 * of ours would shadow it and `df -h` would silently start printing something
 * else — a tool that breaks an unrelated command is a tool people uninstall.
 *
 * Because `dfl` is not the name of anything, there is no collision to detect,
 * nothing to prompt about and no shadowing default to choose: it is a second
 * `bin` key pointing at the same entry script, and it installs like any other.
 * It is also not deprecated, so it prints no notice — `deprecationNotice` fires
 * for `DEPRECATED_COMMAND` and nothing else.
 */
export const SHORT_ALIAS = 'dfl';

/**
 * Names this project will not take, because the machine already has them.
 *
 * Deliberately short and deliberately not "every POSIX utility": the list is
 * the set a plausible abbreviation of `deflow` could land on, plus the one that
 * actually came up. A guard over the published `bin` map reads it
 * (`test/command-name.test.ts`), so an addition here is a real constraint
 * rather than documentation.
 */
export const SYSTEM_UTILITIES: readonly { readonly name: string; readonly what: string }[] = [
  {
    name: 'df',
    what: "POSIX.1's disk-free utility, on every Unix machine — shadowing it breaks `df -h` for every shell on the machine, which is why the short alias is `dfl`",
  },
  {
    name: 'du',
    what: "POSIX.1's disk-usage utility, and the neighbour anyone reaching for a two-letter name lands on next",
  },
  {
    name: 'dd',
    what: "POSIX.1's block copier: shadowing it turns a mistyped command into a plausible-looking one",
  },
  {
    name: 'fd',
    what: "the widely installed `find` replacement — not POSIX, but on enough developer machines that taking the name would be taking somebody else's",
  },
];

/** The system utility `name` would shadow, or `undefined` if it shadows none. */
export function shadowedUtility(name: string): (typeof SYSTEM_UTILITIES)[number] | undefined {
  return SYSTEM_UTILITIES.find((utility) => utility.name === name);
}

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
