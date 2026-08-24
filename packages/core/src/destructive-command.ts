/**
 * KAR-08.3 — the cheap syntactic second layer
 * (docs/09-workspace-and-safety.md §10.4).
 *
 * The allowlist in ./permission.ts answers "is this one of the repository's
 * own verbs". This module answers the orthogonal question: "even so, is this
 * the *identity or infrastructure boundary*", which §10.5 says is where a
 * human gate belongs whatever the node's level. `git` is on every repository's
 * allowlist and `git push --force` is still a question.
 *
 * Three properties are load-bearing and each is a place a plausible
 * implementation goes wrong.
 *
 * **It is not static analysis of shell strings.** §10.4 says so in those
 * words: undecidable, and it gives false confidence. There is no parser here
 * and there must never be one. A command is judged by its resolved binary, its
 * flags and its path-shaped arguments; `sh -c '…'` is judged as `sh`, and
 * `$(echo rm)` is judged as a binary nobody allowlisted. Deny-lists lose
 * because `rm -rf /` has infinite spellings — which is the argument *for* the
 * allowlist, not an invitation to try to recognise them all.
 *
 * **The `rm -r` rule is a depth rule, on the resolved path.** The list of
 * dangerous paths is infinite; the depth is not. Counting segments on the
 * agent's own string would gate `rm -rf dist`, and a build verb in the
 * approval queue is exactly the 200-gate run §10.5 forbids.
 *
 * **`--force-with-lease` is an allow.** It is the only rule here whose purpose
 * is to *not* fire: gating the safe form trains the operator to approve force
 * pushes, which is precisely backwards.
 *
 * Where a rule has to guess, it guesses towards the gate: a verb sequence is
 * matched anywhere in the positional arguments rather than only at the front,
 * so `kubectl --namespace prod delete pod x` is not a hole. The cost of the
 * conservative reading is a question the operator did not need; the cost of
 * the permissive one is `delete` running unasked.
 *
 * Verifies: EPIC-08-S14 · AC3, AC4, AC5
 */
import { splitCommandLine } from './command-line.ts';
import type { PermissionReason } from './permission.ts';
import { binaryName, hostOf, isLoopback, pathDepth, pathIsInside, resolvePosix } from './scope.ts';

/** Everything the layer compares a command against. Passed in rather than
 * read, because a check that reads configuration cannot be tabulated. */
export interface CommandContext {
  /** The node's worktree root, absolute. */
  readonly worktree: string;
  /** Where the command would run — the worktree unless the agent named
   * another, and relative arguments resolve against it. */
  readonly cwd: string;
  /** Variable names KAR-08.4 removed from the child environment. Empty means
   * nothing was removed, not "the check is off". */
  readonly scrubbedEnv: readonly string[];
}

export type DestructiveReason = PermissionReason<'destructive-command' | 'scrubbed-env'>;

const gate = (detail: string): DestructiveReason => ({ code: 'destructive-command', detail });

/**
 * Binaries whose named verbs are an infrastructure-boundary operation, and
 * binaries that are one whatever they are asked to do.
 *
 * `verbs: null` means every invocation: `aws`, `gcloud` and `az` are the
 * credentialed control planes of the three clouds, and there is no useful line
 * to draw inside them from a command line alone.
 */
export const DESTRUCTIVE_COMMANDS: readonly {
  readonly binary: string;
  readonly verbs: readonly (readonly string[])[] | null;
}[] = [
  { binary: 'terraform', verbs: [['apply'], ['destroy']] },
  { binary: 'kubectl', verbs: [['delete'], ['apply']] },
  { binary: 'aws', verbs: null },
  { binary: 'gcloud', verbs: null },
  { binary: 'az', verbs: null },
  { binary: 'prisma', verbs: [['migrate', 'deploy']] },
  { binary: 'drizzle-kit', verbs: [['push']] },
  { binary: 'flyway', verbs: [['migrate']] },
];

/** The database clients §10.4 names, and the flags each spells its host with. */
const DATABASE_CLIENTS: readonly string[] = ['psql', 'mysql'];

/** What a rule answers: the reason detail to gate on, or `null` for "not this
 * one". Separate from {@link DestructiveReason} so a rule cannot invent a code
 * — every gate in this module is a `destructive-command`. */
type CommandRule = (args: readonly string[], context: CommandContext) => string | null;

// ── argv shapes ──────────────────────────────────────────────────────────────

/** Everything that is not a flag, in order. Not a parser: `--name prod` leaves
 * `prod` here, which is why verbs are matched by value rather than by index. */
const positionals = (args: readonly string[]): string[] =>
  args.filter((arg) => !arg.startsWith('-'));

/** Whether `verb` appears as a consecutive run of positional arguments. */
function hasVerbs(args: readonly string[], verb: readonly string[]): boolean {
  const words = positionals(args);
  return words.some((_word, at) => verb.every((token, index) => words[at + index] === token));
}

/**
 * The arguments that name a path rather than a revision, an option value or a
 * table.
 *
 * Two rules, both from how the tools themselves read their argv: everything
 * after a literal `--` is a path, and an argument that begins with `/`, `./`
 * or `../` is one wherever it appears. `HEAD~1` is neither, which is why
 * `git reset --hard HEAD~1` is the ordinary operation it looks like.
 */
function pathArguments(args: readonly string[]): string[] {
  const end = args.indexOf('--');
  const explicit = end === -1 ? [] : args.slice(end + 1);
  const shaped = (end === -1 ? args : args.slice(0, end)).filter(
    (arg) => arg.startsWith('/') || arg.startsWith('./') || arg.startsWith('../'),
  );
  return [...shaped, ...explicit];
}

// ── the individual checks ────────────────────────────────────────────────────

/** `--force` and `-f`, and deliberately not `--force-with-lease`, which is the
 * safe form and must survive (AC4). `--force-if-includes` is its companion and
 * is not a force push on its own. */
function gitPushForce(args: readonly string[]): boolean {
  if (!hasVerbs(args, ['push'])) return false;
  return args.some((arg) => arg === '--force' || arg === '-f');
}

/** `git reset --hard` pointed at something outside the worktree. Inside, it is
 * the everyday way to discard a change and gating it would be a question per
 * failed attempt. */
function gitResetHardOutside(args: readonly string[], context: CommandContext): boolean {
  if (!hasVerbs(args, ['reset']) || !args.includes('--hard')) return false;
  return pathArguments(args).some(
    (path) => !pathIsInside(context.worktree, resolvePosix(context.cwd, path)),
  );
}

/** `-r`, `-R`, `--recursive`, and the bundled short forms (`-rf`, `-fr`) the
 * flag is almost always written in. */
const isRecursiveFlag = (arg: string): boolean =>
  arg === '--recursive' || (/^-[a-zA-Z]+$/.test(arg) && (arg.includes('r') || arg.includes('R')));

/** §10.4's depth rule: a recursive removal of a path two segments deep or
 * fewer. `/`, `/usr` and `/usr/local` are 0, 1 and 2. */
function removesShallowTree(args: readonly string[], context: CommandContext): boolean {
  if (!args.some(isRecursiveFlag)) return false;
  const end = args.indexOf('--');
  const targets = [
    ...(end === -1 ? args : args.slice(0, end)).filter((arg) => !arg.startsWith('-')),
    ...(end === -1 ? [] : args.slice(end + 1)),
  ];
  return targets.some((target) => pathDepth(context.cwd, target) <= 2);
}

/**
 * The host a database client would connect to, in every spelling the two
 * clients accept: a connection URL, `-h`/`--host` with a separate or an `=`
 * value, and a `host=` key in a `libpq` key/value conninfo string.
 *
 * "Does the argument look like a URL" is the naive reading and it is wrong:
 * `mysql -h db.prod.internal` is a remote connection with no URL in sight.
 */
function databaseHost(args: readonly string[]): string | null {
  const hosts: string[] = [];
  args.forEach((arg, index) => {
    const url = hostOf(arg);
    if (url !== null && url !== '') hosts.push(url);
    if (arg === '-h' || arg === '--host') {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith('-')) hosts.push(value.toLowerCase());
    }
    if (arg.startsWith('--host=')) hosts.push(arg.slice('--host='.length).toLowerCase());
    if (arg.startsWith('host=')) hosts.push(arg.slice('host='.length).toLowerCase());
  });
  return hosts.find((host) => host !== '' && !isLoopback(host)) ?? null;
}

/**
 * `$VAR` and `${VAR}` anywhere in the command line, matched against the names
 * KAR-08.4 removed.
 *
 * A lexical scan, not an expansion: nothing here knows what the value would
 * have been, and nothing substitutes anything. The point is AC5's — a command
 * that cannot possibly work because its credential was scrubbed should say so
 * to the operator rather than run and fail confusingly.
 */
const VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

function scrubbedVariable(words: readonly string[], scrubbed: readonly string[]): string | null {
  if (scrubbed.length === 0) return null;
  for (const word of words) {
    for (const match of word.matchAll(VARIABLE_REFERENCE)) {
      const name = match[1];
      if (name !== undefined && scrubbed.includes(name)) return name;
    }
  }
  return null;
}

// ── the binaries judged by a written-out rule ────────────────────────────────

/** `git`'s two rules, in the order the sharper one wins. */
function gitRule(args: readonly string[], context: CommandContext): string | null {
  if (gitPushForce(args)) return 'git-push-force';
  if (gitResetHardOutside(args, context)) return 'git-reset-hard';
  return null;
}

/**
 * The binaries whose rule is written out above rather than tabulated in
 * {@link DESTRUCTIVE_COMMANDS} — `git`, `rm` and the database clients.
 *
 * A table and not a chain of `if`s, so that *both* readers of this module can
 * derive the set of binaries they must route from one place. KAR-23.9 shipped
 * with the second reader ({@link destructiveShellLine}) deriving that set from
 * `DESTRUCTIVE_COMMANDS` alone, which exempted exactly these four from the
 * line scan: `run: 'git push --force origin main'` walked past the rule
 * written to catch it. A second hand-copied list is how that happens, so there
 * is no second list.
 */
const RULED_COMMANDS: readonly { readonly binary: string; readonly rule: CommandRule }[] = [
  { binary: 'git', rule: gitRule },
  {
    binary: 'rm',
    rule: (args, context) => (removesShallowTree(args, context) ? 'rm-recursive-shallow' : null),
  },
  ...DATABASE_CLIENTS.map((binary) => ({
    binary,
    rule: (args: readonly string[]) => (databaseHost(args) !== null ? `${binary}-remote` : null),
  })),
];

/** Every binary any rule in this module has something to say about. */
const GUARDED_BINARIES: ReadonlySet<string> = new Set([
  ...DESTRUCTIVE_COMMANDS.map((entry) => entry.binary),
  ...RULED_COMMANDS.map((entry) => entry.binary),
]);

/**
 * The words a shell reads as "the command before me ended here".
 *
 * Not an operator parser and not a step towards one: an unspaced `a;b` stays
 * one word, and the only consequence is that the scan judges more of the line
 * than it strictly needs to — the safe direction. The point of splitting at
 * all is the opposite one: `rm -rf ./dist && ls /usr` must not be read as a
 * removal of `/usr`, because a false gate on an everyday build verb is how the
 * §10.5 gate budget gets blown and the operator learns to approve everything.
 */
const COMMAND_SEPARATORS: ReadonlySet<string> = new Set(['&&', '||', ';', '|', '&']);

/**
 * A shell line's words, cut into one list per command.
 *
 * A `run:` is routinely a YAML block scalar, so a newline ends a command here
 * exactly as `;` does — and `splitCommandLine` is only quote-aware, so the
 * newlines have to be cut before it sees them or two commands become one.
 * A trailing `\` is the one newline that does *not* end a command, and joining
 * those first is what keeps a continued `terraform \⏎ apply` one command.
 */
function shellSegments(line: string): readonly (readonly string[])[] {
  const segments: string[][] = [];
  for (const physical of line.replace(/\\\r?\n/g, ' ').split(/[\r\n]+/)) {
    segments.push([]);
    for (const word of splitCommandLine(physical)) {
      if (COMMAND_SEPARATORS.has(word)) segments.push([]);
      else segments[segments.length - 1]?.push(word);
    }
  }
  return segments;
}

// ── the layer ────────────────────────────────────────────────────────────────

/**
 * Whether this command must reach a human even though its binary is allowed.
 *
 * Total and pure: every input answers, none throws, and the answer is a
 * structured reason or `null`. Ordered so that the sharpest reason wins — a
 * command that is both an `aws` invocation and a reference to a scrubbed
 * `AWS_PROFILE` is reported as the former, which is the more useful thing to
 * put in front of the operator.
 */
export function destructiveCommand(
  command: string,
  args: readonly string[],
  context: CommandContext,
): DestructiveReason | null {
  const binary = binaryName(command);

  for (const entry of DESTRUCTIVE_COMMANDS) {
    if (entry.binary !== binary) continue;
    if (entry.verbs === null) return gate(binary);
    const verb = entry.verbs.find((candidate) => hasVerbs(args, candidate));
    if (verb !== undefined) return gate([binary, ...verb].join('-'));
  }

  for (const entry of RULED_COMMANDS) {
    if (entry.binary !== binary) continue;
    const detail = entry.rule(args, context);
    if (detail !== null) return gate(detail);
  }

  const variable = scrubbedVariable([command, ...args], context.scrubbedEnv);
  return variable === null ? null : { code: 'scrubbed-env', detail: variable };
}

/**
 * KAR-23.9 — the same layer, applied to a whole *line* that will be handed to
 * a shell.
 *
 * A `tool` node's `run` is one string DeFlow gives to `/bin/sh -c`, so there is
 * no `(command, args)` pair to judge until somebody decides how to read it.
 * This function decides once, in two passes, and **only ever adds refusals**:
 *
 *  1. The documented reading (the module note above): a command that needs a
 *     shell is judged as `sh`. That is what actually runs, so it is judged.
 *  2. A conservative token scan. Every word of the line that names a binary
 *     any rule in this module knows — {@link GUARDED_BINARIES}, derived from
 *     both rule tables and never hand-copied — is judged with the words that
 *     follow it in its own segment, so `git add -A && terraform apply` is
 *     refused even though the *command* being spawned is `sh`.
 *
 * **The second pass is not a decision procedure, and must never be mistaken
 * for one.** §10.4 says static analysis of shell strings is undecidable in
 * those words: `$X`, an alias, a here-doc and a base64 pipe all walk straight
 * past it. It buys defence in depth and nothing else. What actually confines a
 * plan script is the sandbox the caller wraps it in, never this parse — and a
 * caller that read this as "the line was checked, so the shell is safe" would
 * have inverted the whole argument.
 *
 * What it must not do is *miss the plain spelling of a rule it already owns*.
 * The sandbox is no backstop for `git push --force`: it gates by write-root
 * and by domain, and a push to an already allowed remote is indistinguishable
 * to it from a fetch.
 */
export function destructiveShellLine(
  line: string,
  context: CommandContext,
  shell = '/bin/sh',
): DestructiveReason | null {
  const asShell = destructiveCommand(shell, ['-c', line], context);
  if (asShell !== null) return asShell;

  for (const segment of shellSegments(line)) {
    for (const [at, word] of segment.entries()) {
      if (!GUARDED_BINARIES.has(binaryName(word))) continue;
      const verdict = destructiveCommand(word, segment.slice(at + 1), context);
      if (verdict !== null) return verdict;
    }
  }
  return null;
}
