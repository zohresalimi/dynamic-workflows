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
 * Claude Code 2.1.220: `--output-format text|json|stream-json`, and the
 * `--verbose` requirement that only applies to one of the three.
 */
function decideClaude(argv: readonly string[]): CliDecision {
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
