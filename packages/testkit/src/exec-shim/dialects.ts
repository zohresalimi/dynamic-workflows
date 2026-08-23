/**
 * Which vendor the fake binary is pretending to be, and what that vendor does
 * with the argv it was handed (docs/07-provider-adapter-layer.md §8).
 *
 * Vendors are **not uniform**, and this file exists because that sentence is
 * cheap to agree with and expensive to act on. Two of the differences below
 * were verified by running the real binaries on 2026-08-02, and both are the
 * kind a shim gets wrong once and then ships:
 *
 * - Claude Code **requires `--verbose`** alongside `-p --output-format
 *   stream-json`, and succeeds without it under `--output-format json`. So the
 *   mistake is invisible in the format most people try first.
 * - Copilot has **no `stream-json` at all** — `text|json` only. A shim that
 *   assumes one streaming format across vendors breaks here, and the fake has
 *   to refuse rather than emulate, or the break happens in production instead.
 *
 * Everything here is a pure function over argv so the rules can be read, unit
 * tested and pointed at in a review. The binary applies them before it writes a
 * byte; the integration specs prove the process really does exit that way.
 */

export const DIALECTS = ['claude-stream-json', 'codex-jsonl', 'copilot-json'] as const;
export type Dialect = (typeof DIALECTS)[number];

/** The environment variable that picks the dialect (AC1). */
export const DIALECT_ENV = 'DeFlow_FAKE_DIALECT';

/**
 * Claude Code 2.1.220's refusal, character for character.
 *
 * Verified by execution, not transcribed from documentation — the shim's
 * detection of this case is a string match, so an approximation here would make
 * the detection untestable.
 */
export const CLAUDE_VERBOSE_REQUIRED =
  'Error: When using --print, --output-format=stream-json requires --verbose';

/**
 * Claude Code 2.1.220's second refusal, character for character (KAR-19.8).
 *
 * **Verified by execution on 2026-08-13**, the expensive way: an operator's run
 * reached framing and died on this line, on every attempt, because DeFlow put
 * its own `run_…`-shaped id on `--session-id`. Until this constant existed the
 * fake accepted whatever it was handed — which is exactly why the whole
 * provider-contract suite was green while the product could not complete a turn
 * on the machine it ships to.
 */
export const CLAUDE_INVALID_SESSION_ID = 'Error: Invalid session ID. Must be a valid UUID.';

/**
 * Claude Code 2.1.220's refusal of an id it has **already created**
 * (KAR-19.13).
 *
 * **Verified by execution on 2026-08-16**, the expensive way again: run
 * `run_20260816T194933Z_839b9b` reached `compilePlanV1` and the child exited 1
 * on
 *
 * ```
 * Session ID 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 is already in use
 * ```
 *
 * because `--session-id` **creates** a session and does not attach to one, and
 * DeFlow presented the id a previous process had already spent. The wording
 * carries none of the words `rejectedArgument` matched at the time — it is not
 * *invalid*, *unknown* or *unsupported* — which is why the refusal came back
 * classified `transient` and the run retried the identical id every tick.
 *
 * Built from the id rather than frozen, because the value is what tells the
 * reader *which* session was spent.
 */
export const claudeSessionInUse = (sessionId: string): string =>
  `Session ID ${sessionId} is already in use`;

/**
 * Claude Code 2.1.220's third refusal, character for character (KAR-19.11).
 *
 * **Verified by execution on 2026-08-13 at 19:59**, two minutes after the one
 * above and by the same route: an operator's next run reached framing and died
 * on
 *
 * ```
 * Error: --json-schema is not valid JSON: JSON Parse error: Unrecognized token '/'
 * ```
 *
 * because DeFlow put the schema *file's path* on a flag whose value the vendor
 * `JSON.parse`s. The `'/'` is the first character of the absolute path. The
 * message is built from the offending value rather than frozen, because the
 * token the parser chokes on is what tells the reader which shape arrived.
 */
export function claudeInvalidJson(flag: string, value: string): string {
  const first = value.slice(0, 1);
  const detail =
    first === ''
      ? 'JSON Parse error: Unexpected EOF'
      : `JSON Parse error: Unrecognized token '${first}'`;
  return `Error: ${flag} is not valid JSON: ${detail}`;
}

/**
 * The form Claude Code validates `--session-id` against: an RFC 4122 UUID.
 *
 * Narrow on purpose (`[1-5]` versions, `[89ab]` variant). The fake's job is to
 * be at least as strict as the vendor, because a double that is more permissive
 * than the real thing is a double that passes the code the vendor will refuse.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The wire format an accepted invocation asks for.
 *
 * `jsonl` is Codex's `--json` rather than a fourth spelling of `stream-json`:
 * the two are both one-JSON-object-per-line and are still not the same format,
 * and collapsing them in the type is how a shim ends up parsing one as the
 * other.
 */
export type OutputFormat = 'text' | 'json' | 'stream-json' | 'jsonl';

export type Refusal = {
  readonly ok: false;
  readonly exitCode: number;
  readonly stderr: string;
};

export type CliDecision = { readonly ok: true; readonly format: OutputFormat } | Refusal;

export type DialectResult = { readonly ok: true; readonly dialect: Dialect } | Refusal;

export type ShimEnv = Readonly<Record<string, string | undefined>>;

const isDialect = (value: string): value is Dialect =>
  (DIALECTS as readonly string[]).includes(value);

/** Reads `$DeFlow_FAKE_DIALECT`. Unset is a refusal, never a default (AC1). */
export function readDialect(env: ShimEnv): DialectResult {
  const value = env[DIALECT_ENV];
  if (value === undefined || value === '') {
    return {
      ok: false,
      exitCode: 64,
      stderr:
        `fake-agent: ${DIALECT_ENV} is not set. A fake that guessed a dialect would ` +
        `pass a shim that guessed the same one wrong (expected one of: ${DIALECTS.join(', ')})`,
    };
  }
  if (!isDialect(value)) {
    return {
      ok: false,
      exitCode: 64,
      stderr: `fake-agent: unknown ${DIALECT_ENV} "${value}" (expected one of: ${DIALECTS.join(', ')})`,
    };
  }
  return { ok: true, dialect: value };
}

/** The value after `flag`, or null when the flag is absent or trailing. */
function valueOf(argv: readonly string[], flag: string): string | null {
  const at = argv.lastIndexOf(flag);
  if (at < 0) return null;
  return argv[at + 1] ?? null;
}

const has = (argv: readonly string[], ...flags: readonly string[]): boolean =>
  flags.some((flag) => argv.includes(flag));

/**
 * The flags a vendor takes a JSON Schema file on (KAR-09.9 AC2).
 *
 * Both spellings in one place because the fake impersonates both vendors and
 * the question it asks is the same one either way: *was this invocation given a
 * schema at all?*
 */
export const SCHEMA_FLAGS = ['--json-schema', '--output-schema'] as const;

/**
 * The schema file this invocation was handed, or `null`.
 *
 * `null` is what makes the fake reproduce the behaviour that matters: a turn
 * run without a schema flag comes back with **no** `structured_output` field,
 * so a shim that dropped the flag cannot be rescued by a fake that emitted the
 * field anyway.
 */
export function schemaPathIn(argv: readonly string[]): string | null {
  for (const flag of SCHEMA_FLAGS) {
    const value = valueOf(argv, flag);
    if (value !== null) return value;
  }
  return null;
}

/**
 * KAR-19.11 AC5 — **what each vendor does with the shape of each argument.**
 *
 * The tables below are the fakes' half of the story, and the more valuable
 * half. Both defects of 2026-08-13 passed every level of the suite and failed
 * on the first real machine for one reason: the argv was asserted against
 * fixtures and against doubles that accepted whatever they were handed, so
 * *"DeFlow builds an argument the vendor refuses"* was outside every test in
 * the repository. A fake that accepts any argument is not a fake of a CLI.
 *
 * These are the **vendor's** rules, written here rather than imported from
 * `@DeFlow/adapters`' registry on purpose: a double that read DeFlow's own
 * declarations would agree with DeFlow by construction and could never catch
 * DeFlow declaring the wrong thing — which is precisely what happened.
 */
type FakeForm = 'inline-json' | 'abs-path' | 'uuid' | 'enum' | 'number' | 'free-text';

interface FakeArgument {
  readonly flag: string;
  readonly form: FakeForm;
  readonly values?: readonly string[];
}

/** Why `value` is the wrong shape for `form`, or `null`. */
function wrongShape(argument: FakeArgument, value: string): string | null {
  if (argument.form === 'inline-json') {
    try {
      JSON.parse(value);
      return null;
    } catch {
      return 'json';
    }
  }
  if (argument.form === 'abs-path') return value.startsWith('/') ? null : 'path';
  if (argument.form === 'uuid') return UUID.test(value) ? null : 'uuid';
  if (argument.form === 'number') return Number.isFinite(Number(value)) ? null : 'number';
  if (argument.form === 'enum') {
    return (argument.values ?? []).includes(value) ? null : 'enum';
  }
  return null;
}

/**
 * Claude Code 2.1.220's own arguments, with the shape each one is validated
 * against.
 *
 * `--json-schema` and `--session-id` are the two that have been **executed** —
 * the vendor refused a wrong value on each, two minutes apart, on a real
 * operator's run.
 */
const CLAUDE_ARGUMENTS: readonly FakeArgument[] = [
  { flag: '--session-id', form: 'uuid' },
  { flag: '--json-schema', form: 'inline-json' },
  { flag: '--settings', form: 'inline-json' },
  {
    flag: '--permission-mode',
    form: 'enum',
    values: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
  },
  { flag: '--effort', form: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { flag: '--max-budget-usd', form: 'number' },
];

const CODEX_ARGUMENTS: readonly FakeArgument[] = [
  { flag: '--output-schema', form: 'abs-path' },
  { flag: '-C', form: 'abs-path' },
  {
    flag: '--sandbox',
    form: 'enum',
    values: ['read-only', 'workspace-write', 'danger-full-access'],
  },
];

const COPILOT_ARGUMENTS: readonly FakeArgument[] = [
  { flag: '--output-format', form: 'enum', values: ['text', 'json'] },
];

/**
 * The first argument this argv gets wrong, or `null`.
 *
 * `refuse` is the vendor's own message for that argument, so the fake refuses
 * in the shape the real binary refuses in — which is what makes a shim's
 * detection of the refusal testable at all.
 */
function firstWrongArgument(
  declared: readonly FakeArgument[],
  argv: readonly string[],
  refuse: (argument: FakeArgument, value: string, why: string) => Refusal,
): Refusal | null {
  for (const argument of declared) {
    const value = valueOf(argv, argument.flag);
    if (value === null) continue;
    const why = wrongShape(argument, value);
    if (why !== null) return refuse(argument, value, why);
  }
  return null;
}

/**
 * Claude Code 2.1.220: `--output-format text|json|stream-json`, the `--verbose`
 * requirement that only applies to one of the three, and the argument shapes it
 * validates before it does any work at all.
 */
function decideClaude(argv: readonly string[]): CliDecision {
  // KAR-19.8, KAR-19.11. Checked before the format, as the vendor does: the
  // argv is validated as a whole before a turn is attempted, so a run with two
  // things wrong hears about the argument rather than about the stream.
  const wrong = firstWrongArgument(CLAUDE_ARGUMENTS, argv, (argument, value, why) => {
    if (argument.flag === '--session-id') {
      return { ok: false, exitCode: 1, stderr: CLAUDE_INVALID_SESSION_ID };
    }
    if (why === 'json') {
      return { ok: false, exitCode: 1, stderr: claudeInvalidJson(argument.flag, value) };
    }
    return {
      ok: false,
      exitCode: 1,
      stderr: `Error: Invalid value for ${argument.flag}: ${value}`,
    };
  });
  if (wrong !== null) return wrong;

  const format = valueOf(argv, '--output-format') ?? 'text';
  if (format !== 'text' && format !== 'json' && format !== 'stream-json') {
    return {
      ok: false,
      exitCode: 1,
      stderr: `Error: Invalid value for --output-format: ${format} (choices: text, json, stream-json)`,
    };
  }

  // The verified gotcha. `--print` is what turns the CLI headless, and the
  // requirement only applies there — which is exactly why it is missable.
  if (format === 'stream-json' && has(argv, '-p', '--print') && !has(argv, '--verbose')) {
    return { ok: false, exitCode: 1, stderr: CLAUDE_VERBOSE_REQUIRED };
  }

  return { ok: true, format };
}

/**
 * Copilot CLI 1.0.77: `--output-format text|json`. There is no third value.
 *
 * The refusal is shaped like the Commander.js message a Node CLI produces for
 * an out-of-choice option; only the *absence* of `stream-json` is verified
 * (`--help`, 2026-08-02), so nothing downstream may match on this wording — the
 * contract AC4 states is the non-zero exit.
 */
function decideCopilot(argv: readonly string[]): CliDecision {
  const wrong = firstWrongArgument(COPILOT_ARGUMENTS, argv, (argument, value) => ({
    ok: false,
    exitCode: 1,
    stderr:
      `error: option '${argument.flag} <value>' argument '${value}' is invalid. ` +
      `Allowed choices are ${(argument.values ?? []).join(', ')}.`,
  }));
  if (wrong !== null) return wrong;

  const format = valueOf(argv, '--output-format') ?? 'text';
  if (format !== 'text' && format !== 'json') {
    return {
      ok: false,
      exitCode: 1,
      stderr:
        `error: option '--output-format <format>' argument '${format}' is invalid. ` +
        `Allowed choices are text, json.`,
    };
  }
  return { ok: true, format };
}

/**
 * Codex CLI 0.146.0: `codex exec --json`, and no `--output-format` anywhere.
 *
 * Codex was **not installed** on the capture machine
 * (`fixtures/cli-flags/2026-08-04.json` records `status: "not-installed"`), so
 * the flag set here comes from documentation rather than from execution and the
 * refusal wording is a clap-shaped invention. What the dialect is used for —
 * one JSON object per line, including a line that is 10 MB long — does not
 * depend on either.
 */
function decideCodex(argv: readonly string[]): CliDecision {
  // KAR-19.11 AC5. `--output-schema <FILE>` is a **path**, and this is the
  // inverse of the defect the story fixes: sending Claude Code's inline
  // document to Codex would be the same mistake pointed the other way. Refused
  // in clap's shape, like everything else in this dialect — the flag set here
  // is documentation rather than execution (see above), so nothing downstream
  // may match on the wording.
  const wrong = firstWrongArgument(CODEX_ARGUMENTS, argv, (argument, value) => ({
    ok: false,
    exitCode: 2,
    stderr: `error: invalid value '${value.slice(0, 60)}' for '${argument.flag} <${
      argument.form === 'abs-path' ? 'FILE' : 'VALUE'
    }>'\n\nUsage: codex exec [OPTIONS] [PROMPT]`,
  }));
  if (wrong !== null) return wrong;

  if (argv.includes('--output-format')) {
    return {
      ok: false,
      exitCode: 2,
      stderr:
        "error: unexpected argument '--output-format' found\n\n" +
        'Usage: codex exec [OPTIONS] [PROMPT]',
    };
  }
  return { ok: true, format: argv.includes('--json') ? 'jsonl' : 'text' };
}

/** What the named vendor would do with this argv. */
export function decideCli(dialect: Dialect, argv: readonly string[]): CliDecision {
  if (dialect === 'claude-stream-json') return decideClaude(argv);
  if (dialect === 'copilot-json') return decideCopilot(argv);
  return decideCodex(argv);
}
