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
import { type ProviderSpec, redactedInline } from './provider-registry.ts';

/** One argument the vendor refused: the flag, and what DeFlow put after it. */
export interface RejectedArgument {
  readonly flag: string;
  /** `null` for a flag that takes no value, or whose value was not on the
   * argv — never an invented one. */
  readonly value: string | null;
}

/**
 * KAR-19.13 AC6 — the words a CLI uses when it is refusing an argument rather
 * than failing at its work, **as a table with a sentence behind every row**.
 *
 * This shipped as one regex, and the shape was the defect. KAR-19.8 added
 * `invalid` and `must be` because Claude Code 2.1.220 writes *"Invalid session
 * ID. Must be a valid UUID."*; three days later the same vendor refused the
 * same flag with *"Session ID <uuid> is already in use"*, which contains none of
 * those words, so `rejectedArgument` returned `null` before its `SUBJECTS`
 * table was ever consulted and the failure fell through to `agentExited`'s
 * `transient` — a standing instruction to retry the identical id, every tick,
 * for ever.
 *
 * One more literal would close that case and leave the next wording to the next
 * real run, which is the pattern this epic has already recorded four times. So
 * every phrasing now carries **the sentence it exists for** and how that
 * sentence is known, and `test/refusal-vocabulary.test.ts` fails any row whose
 * phrasing does not actually recognise it. That is the difference between "we
 * added a word" and "here is what is covered".
 *
 * The phrasings stay short and generic — these are the wordings of every
 * argument parser in wide use (`clap`, `commander`, `yargs`, hand-rolled) —
 * because matching a vendor's *prose* would go stale the first time somebody
 * rewords a string. The sentence is evidence for the row, not the matcher.
 */
export interface RefusalPhrasing {
  /** The phrasing, as a reader would name it. */
  readonly phrasing: string;
  /** What actually matches. Anchored on word boundaries, never on prose. */
  readonly pattern: RegExp;
  /** A sentence this phrasing must recognise. Never empty — a row with nothing
   * behind it is a row nobody can check. */
  readonly sentence: string;
  /** How the sentence is known. `executed` means a real binary wrote it. */
  readonly provenance: {
    readonly how: 'executed' | 'help' | 'bundle' | 'documented';
    readonly on: string;
    readonly note?: string;
  };
}

// Every sentence below was written by a real CLI or by the argument parser a
// real CLI is built on. Which vendor wrote which is recorded here rather than in
// the `note` field on purpose: `test/no-capability-table.test.ts` allows exactly
// one file under `src/` to name a vendor in executable code, and it is the
// registry. Claude Code 2.1.220 wrote the four `executed` rows — the session-id
// refusal of 2026-08-13, the `--json-schema` parse error two minutes later, the
// JSON-Schema refusal after that, and the `already in use` of 2026-08-16.
export const REFUSAL_VOCABULARY: readonly RefusalPhrasing[] = [
  {
    phrasing: 'invalid',
    pattern: /\binvalid\b/i,
    sentence: 'Error: Invalid session ID. Must be a valid UUID.',
    provenance: {
      how: 'executed',
      on: '2026-08-13',
      note: 'refused on every attempt of a real operator’s run',
    },
  },
  {
    phrasing: 'must be',
    pattern: /\bmust be\b/i,
    sentence: 'Error: Invalid session ID. Must be a valid UUID.',
    provenance: { how: 'executed', on: '2026-08-13', note: 'the second half of the same sentence' },
  },
  {
    phrasing: 'not a valid',
    pattern: /\bnot a valid\b/i,
    sentence:
      'Error: --json-schema is not a valid JSON Schema: no schema with key or ref ' +
      '"https://json-schema.org/draft/2020-12/schema"',
    provenance: {
      how: 'executed',
      on: '2026-08-13',
      note: 'the third argument refused in one evening',
    },
  },
  {
    phrasing: 'unrecognised',
    pattern: /\bunrecognised\b/i,
    sentence: "error: unrecognised option '--output-schema'",
    provenance: {
      how: 'documented',
      on: '2026-08-13',
      note: 'the en-GB spelling of the row below; no vendor DeFlow drives has been seen to use it',
    },
  },
  {
    phrasing: 'unrecognized',
    pattern: /\bunrecognized\b/i,
    sentence: "Error: --json-schema is not valid JSON: JSON Parse error: Unrecognized token '/'",
    provenance: {
      how: 'executed',
      on: '2026-08-13',
      note: 'at 19:59, two minutes after the session-id refusal',
    },
  },
  {
    phrasing: 'unexpected',
    pattern: /\bunexpected\b/i,
    sentence: "error: unexpected argument '--output-format' found",
    provenance: {
      how: 'documented',
      on: '2026-08-04',
      note: 'clap’s own wording; that CLI was not installed on the capture machine',
    },
  },
  {
    phrasing: 'unknown',
    pattern: /\bunknown\b/i,
    sentence: "error: unknown option '--session-id'",
    provenance: {
      how: 'documented',
      on: '2026-08-04',
      note: 'commander’s own wording, which is what a Node vendor CLI produces',
    },
  },
  {
    phrasing: 'unsupported',
    pattern: /\bunsupported\b/i,
    sentence: 'error: unsupported value for --output-format: stream-json',
    provenance: {
      how: 'documented',
      on: '2026-08-04',
      note: 'the generic phrasing; no vendor DeFlow drives has been seen to use it',
    },
  },
  // KAR-19.13 — the family the 2026-08-16 run died on. Three rows rather than
  // one: `already in use` is the sentence that was executed, and the other two
  // are the neighbouring wordings for the same condition. A vendor that says
  // "in use" without "already" is one sentence away, and finding that out from
  // a wedged run is what this table exists to stop.
  {
    phrasing: 'already in use',
    pattern: /\balready in use\b/i,
    sentence: 'Session ID 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 is already in use',
    provenance: {
      how: 'executed',
      on: '2026-08-16',
      note: 'inside compilePlanV1 on run_20260816T194933Z_839b9b',
    },
  },
  {
    phrasing: 'already exists',
    pattern: /\balready exists\b/i,
    sentence: 'Error: session id 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 already exists',
    provenance: {
      how: 'documented',
      on: '2026-08-16',
      note: 'the same condition worded as a create conflict; not executed against any binary',
    },
  },
  {
    phrasing: 'in use',
    pattern: /\bin use\b/i,
    sentence: 'Error: that session id is in use by another process',
    provenance: {
      how: 'documented',
      on: '2026-08-16',
      note: 'the same condition without "already"; not executed against any binary',
    },
  },
];

/** Whether the child was refusing an argument rather than failing at its work. */
const refusesAnArgument = (stderr: string): boolean =>
  REFUSAL_VOCABULARY.some((entry) => entry.pattern.test(stderr));

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
}[] = [
  { pattern: /session[ -]?id/i, flagOf: (spec) => spec.shim.sessionId?.flag },
  // KAR-19.11. The second subject, and it is here for the same reason as the
  // first: on 2026-08-13 at 19:59 Claude Code named `--json-schema` explicitly,
  // so the flag loop above already catches that wording — but a vendor that
  // says "the output schema was not valid" without naming its flag must still
  // be diagnosable, and a matcher keyed to one flag looks identical in green
  // until the second argument fails.
  {
    pattern: /(json|output)[ -]?schema/i,
    flagOf: (spec) => spec.shim.structuredOutputFlag,
  },
];

/**
 * KAR-19.11 AC8 — a refused value as a failure payload records it.
 *
 * The value of an `inline-json` argument is a whole schema document, and a
 * `node.failed` row the ledger keeps for ever must not become a paste of it.
 * The schema id is what an operator wants there anyway: the document itself is
 * still on disk under the run's `.DeFlow/schemas/`, named by that id (NF8).
 */
function refusedValue(
  spec: ProviderSpec | undefined,
  flag: string,
  value: string | null,
): string | null {
  if (value === null || spec === undefined) return value;
  const declared = spec.shim.arguments.find((argument) => argument.flag === flag);
  if (declared?.form !== 'inline-json') return value;
  // **Only a value that really is a document is reduced.** A value on that flag
  // which does *not* parse is the whole diagnosis — `--json-schema
  // /abs/…/DeFlow.taskspecdraft.v1.json` is the sentence that explains the
  // 19:59 failure in one read — so it is carried verbatim, bounded by
  // `recorded()` like every other refused value.
  try {
    JSON.parse(value);
  } catch {
    return value;
  }
  return redactedInline(flag, value);
}

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
  if (stderr === '' || !refusesAnArgument(stderr)) return null;
  const spec = input.spec;

  for (const flag of flagsOn(input.argv)) {
    if (stderr.includes(flag)) {
      return { flag, value: refusedValue(spec, flag, valueAfter(input.argv, flag)) };
    }
  }

  if (spec !== undefined) {
    for (const subject of SUBJECTS) {
      const flag = subject.flagOf(spec);
      if (flag === undefined || !input.argv.includes(flag)) continue;
      if (subject.pattern.test(stderr)) {
        return { flag, value: refusedValue(spec, flag, valueAfter(input.argv, flag)) };
      }
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
