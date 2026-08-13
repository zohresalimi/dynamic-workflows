/**
 * KAR-19.8 AC5, AC6 — a vendor that refuses one of DeFlow's own arguments is
 * reported as an argument problem, and is not retried.
 *
 * On 2026-08-13 the failure an operator got was
 * `{ reason: 'agent.nonzero-exit', class: 'transient', detail: { provider,
 * code: 1, stderr: 'Error: Invalid session ID. Must be a valid UUID.' } }` —
 * and both halves of that are wrong in a way that costs an afternoon.
 *
 * **The class.** `transient` is a standing instruction to try again, so the
 * identical error came back at 11:07:13, 11:07:44, 11:08:14 and onwards. An
 * argument the vendor will refuse identically on every attempt is the
 * definition of `permanent` under KAR-02.10's taxonomy. The `reason` stays
 * `agent.nonzero-exit`, because it is: the taxonomy's rule is that the class is
 * assigned by the code that knows the situation, never derived from the reason.
 *
 * **The name.** *"the agent exited 1"* leaves the operator reading a stack
 * trace to find out which of DeFlow's own arguments was rejected. The flag and
 * the value DeFlow supplied are on the failure, so the terminal line can name
 * them (`packages/cli/src/run/render.ts`).
 *
 * **What it deliberately does not do** is guess. Detection needs two agreeing
 * facts — the child said something was invalid, *and* the thing it named is on
 * the argv DeFlow built — because a classifier that blamed the argv whenever a
 * child exited non-zero would turn every ordinary vendor error into a permanent
 * failure nobody retries. When the two do not agree, the answer is `null` and
 * the caller's own `agentExited` stands.
 *
 * Verifies: EPIC-19-S55 · KAR-19.8 AC5, AC6
 */
import { NodeFailureError } from '@DeFlow/core';
import type { ProviderSpec } from './provider-registry.ts';

/** One argument the vendor refused: the flag, and what DeFlow put after it. */
export interface RejectedArgument {
  readonly flag: string;
  /** `null` for a flag that takes no value, or whose value was not on the
   * argv — never an invented one. */
  readonly value: string | null;
}

/**
 * The words a CLI uses when it is refusing an argument rather than failing at
 * its work.
 *
 * Deliberately short and generic: these are the phrasings of every argument
 * parser in wide use (`clap`, `commander`, `yargs`, hand-rolled), and matching
 * a vendor's *prose* instead would be a table that goes stale the first time
 * somebody rewords an error string.
 */
const REFUSAL_WORDS =
  /\b(invalid|unknown|unrecognised|unrecognized|unsupported|unexpected|not a valid|must be)\b/i;

/** Every token on the argv that looks like a flag, longest first — so
 * `--session-id` is preferred over a `-s` that happens to be a prefix. */
function flagsOn(argv: readonly string[]): readonly string[] {
  return [...new Set(argv.filter((token) => /^-{1,2}[a-z]/i.test(token)))].sort(
    (left, right) => right.length - left.length,
  );
}

/** What DeFlow put after `flag`, or `null` when the next token is another
 * flag or there is none. */
function valueAfter(argv: readonly string[], flag: string): string | null {
  const at = argv.lastIndexOf(flag);
  if (at < 0) return null;
  const next = argv[at + 1];
  return next === undefined || next.startsWith('-') ? null : next;
}

/**
 * The subject a vendor names when it refuses a value without naming the flag
 * it arrived on.
 *
 * One entry, and it is the one that cost an afternoon: Claude Code 2.1.220
 * prints `Error: Invalid session ID. Must be a valid UUID.` and never mentions
 * `--session-id`. The flag is **read from the registry entry** rather than
 * spelled here, so this stays a mapping from *what the vendor talked about* to
 * *what DeFlow passed*, and a vendor that takes its session id on some other
 * flag is still named correctly.
 */
const SUBJECTS: readonly {
  readonly pattern: RegExp;
  readonly flagOf: (spec: ProviderSpec) => string | undefined;
}[] = [{ pattern: /session[ -]?id/i, flagOf: (spec) => spec.shim.sessionId?.flag }];

export interface ArgumentRefusalInput {
  /** The argv DeFlow actually spawned the child with. */
  readonly argv: readonly string[];
  /** The child's stderr, as it was written. */
  readonly stderr: string;
  /** The registry entry, when the caller has one — it is what turns "the
   * vendor complained about a session id" into a flag name. */
  readonly spec?: ProviderSpec | undefined;
}

/**
 * The argument this child refused, or `null` when its exit was about something
 * else.
 */
export function rejectedArgument(input: ArgumentRefusalInput): RejectedArgument | null {
  const stderr = input.stderr.trim();
  if (stderr === '' || !REFUSAL_WORDS.test(stderr)) return null;

  for (const flag of flagsOn(input.argv)) {
    if (stderr.includes(flag)) return { flag, value: valueAfter(input.argv, flag) };
  }

  const spec = input.spec;
  if (spec !== undefined) {
    for (const subject of SUBJECTS) {
      const flag = subject.flagOf(spec);
      if (flag === undefined || !input.argv.includes(flag)) continue;
      if (subject.pattern.test(stderr)) return { flag, value: valueAfter(input.argv, flag) };
    }
  }

  return null;
}

/** The first `limit` characters of the child's own words, trimmed and never
 * paraphrased — an operator has to be able to search for them. */
export const excerptStderr = (stderr: string, limit = 2000): string =>
  stderr.trim().slice(0, limit);

/**
 * How much of a refused value the failure carries.
 *
 * A session id is 36 characters, which is the value this whole module exists
 * for. But `-p` is also an argument DeFlow chooses, and its value is the entire
 * context packet — so an unbounded copy would put a four-hundred-word prompt
 * into a `node.failed` payload the ledger keeps for ever, once per attempt.
 */
const VALUE_CHARS = 300;

/** The value as the failure records it: one line, bounded, and marked when it
 * was cut so nobody reads a truncation as the value. */
function recorded(value: string | null): string | null {
  if (value === null) return null;
  const single = value.replaceAll(/\s+/g, ' ').trim();
  return single.length > VALUE_CHARS ? `${single.slice(0, VALUE_CHARS)}…` : single;
}

/**
 * The refusal as a typed failure: `permanent`, with the flag and the value on
 * it and in the message.
 */
export function argumentRefused(input: {
  readonly provider: string;
  readonly rejected: RejectedArgument;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
}): NodeFailureError {
  const { flag } = input.rejected;
  const value = recorded(input.rejected.value);
  const shown = value === null ? '(no value)' : value;
  return new NodeFailureError(
    `${input.provider} refused the argument ${flag} ${shown} that DeFlow passed, and exited ` +
      `${input.code === null ? 'on a signal' : String(input.code)}: ${excerptStderr(input.stderr)}`,
    {
      reason: 'agent.nonzero-exit',
      // KAR-02.10's rule, applied: the class is assigned by the code that knows
      // the situation. An argument this vendor refuses now is one it will
      // refuse on every attempt, so a retry ladder must not be armed for it.
      class: 'permanent',
      detail: {
        provider: input.provider,
        flag,
        value,
        code: input.code,
        signal: input.signal,
        stderr: excerptStderr(input.stderr),
      },
    },
  );
}
