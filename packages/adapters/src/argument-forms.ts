/**
 * KAR-19.11 — the closed vocabulary of argument shapes, and the audit that
 * checks a built argv against what its entry declared.
 *
 * **Why this file exists is a rate, not an argument.** On 2026-08-13 at 19:57 a
 * run died because Claude Code 2.1.220 validates `--session-id` as a UUID and
 * DeFlow's run ids are not UUIDs (KAR-19.8). At 19:59, one argument later, the
 * same binary died again:
 *
 * ```
 * Error: --json-schema is not valid JSON: JSON Parse error: Unrecognized token '/'
 * ```
 *
 * — because `shimInvocation` appended `[entry.structuredOutputFlag,
 * ctx.schemaPath]` for **every** vendor from one line. One unexamined
 * assumption, *"a schema argument is a path"*, applied uniformly to a table
 * whose members disagree: Codex CLI documents `--output-schema <FILE>` and the
 * bundled agent takes a path, while Claude Code wants the document.
 *
 * The count of remaining wrong arguments was unknown, and nothing in the
 * repository could answer it. This module is the answer: **every element every
 * `build` can emit carries a declared form and a provenance note**, and
 * `auditShimArgv` checks a real argv against those declarations. The check runs
 * on every commit, over rows derived from `PROVIDER_SPECS`, so a vendor added
 * next month is covered without anyone remembering to cover it.
 *
 * **Provenance is three claims, not one.** The comment that shipped the second
 * defect read *"Verified 2026-08-02 from the 2.1.220 bundle's flag table and
 * zod schema"* — verified by **reading**, never by execution, and written as
 * though the two were the same. `'help'`, `'bundle'` and `'executed'` are kept
 * apart here so that the set of forms nobody has ever run is a list somebody
 * can print, and that list is exactly the work list for the opt-in vendor-CLI
 * battery.
 *
 * Verifies: EPIC-19-S72, EPIC-19-S73 · KAR-19.11 AC2, AC3, AC4
 */

/**
 * Every shape a value DeFlow supplies can be required to have.
 *
 * Closed on purpose. The failure this replaces is a shape nobody wrote down, so
 * a vocabulary a caller could extend inline would reintroduce it — a form that
 * is not in this list is a compile error at the registry entry, which is where
 * the question belongs.
 */
export const ARGUMENT_FORMS = [
  'inline-json',
  'abs-path',
  'uuid',
  'enum',
  'number',
  'free-text',
] as const;

export type ArgumentForm = (typeof ARGUMENT_FORMS)[number];

/**
 * How a declared form is known.
 *
 * `'help'` was read off the installed binary's own `--help`; `'bundle'` was
 * decoded from the shipping bundle's flag table or schema; `'executed'` means a
 * value of this shape was **passed to the real binary and accepted**, or a value
 * of the wrong shape was passed and refused. Only the third is evidence about
 * what the parser does, and the first two have both been wrong.
 */
export const ARGUMENT_PROVENANCE_KINDS = ['help', 'bundle', 'executed'] as const;

export type ArgumentProvenanceKind = (typeof ARGUMENT_PROVENANCE_KINDS)[number];

export interface ArgumentProvenance {
  readonly how: ArgumentProvenanceKind;
  /** `YYYY-MM-DD`. A claim about a vendor CLI without a date is a claim about
   * a version nobody can name. */
  readonly on: string;
  /** What was read or run, for a reader who wants to repeat it. */
  readonly note?: string;
}

/** One element a `build` can put on the command line, and its declared shape. */
export interface ShimArgument {
  /** What the audit calls it: `session-id`, `prompt`, `output-format`. */
  readonly name: string;
  /** The flag it rides on, or `null` for a positional. */
  readonly flag: string | null;
  readonly form: ArgumentForm;
  /** The accepted values, for `'enum'`. Required there and meaningless else. */
  readonly values?: readonly string[];
  /** `true` for a flag that carries no value at all (`--verbose`). */
  readonly valueless?: boolean;
  /**
   * Top-level keys removed from an `inline-json` document before it goes on the
   * command line, because this vendor's own validator refuses them.
   *
   * **Found by execution on 2026-08-13, the third argument in one evening.**
   * With the schema sent inline — the fix for the second — Claude Code 2.1.220
   * got past its `JSON.parse` and refused the next layer down:
   *
   * ```
   * Error: --json-schema is not a valid JSON Schema: no schema with key or ref
   * "https://json-schema.org/draft/2020-12/schema"
   * ```
   *
   * Its bundled validator has no 2020-12 meta-schema registered, so the
   * `$schema` declaration DeFlow emits is a ref it cannot resolve. The same
   * document without that one key is accepted and the turn completes.
   *
   * A **declared list on the entry** rather than a branch, for the same reason
   * `form` is: it is one vendor's rule, it is data, and the day another vendor
   * needs a different key removed is a diff in its own row. It changes only the
   * copy handed to the vendor — the file under the run's `.DeFlow/schemas/` is
   * written whole, so what an operator reads afterwards is unchanged (NF8).
   */
  readonly stripKeys?: readonly string[];
  readonly provenance: ArgumentProvenance;
}

/**
 * A syntactically valid RFC 4122 UUID, versions 1–5.
 *
 * Deliberately the *narrow* pattern rather than the permissive one: the point
 * of the check is to agree with the strictest validator a vendor is plausibly
 * running, and a value that passes here passes both the `[1-5]` regexes and the
 * `[1-8]` ones.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The largest single argv element DeFlow will build.
 *
 * Linux caps one argument at `MAX_ARG_STRLEN` — 32 pages, 128 KiB — and refuses
 * a longer one with `E2BIG` from `execve`, which arrives as an errno from
 * `spawn` with no name attached. macOS caps the whole argv at 256 KiB instead,
 * so the per-element figure is the stricter of the two and is applied
 * everywhere: a schema that would fail on Linux must not silently pass on a
 * developer's Mac and fail in CI.
 */
export const MAX_ARGV_ELEMENT_BYTES = 128 * 1024;

/** What a form is checked against, without needing the whole declaration. */
export interface ArgumentFormCheck {
  readonly form: ArgumentForm;
  readonly values?: readonly string[];
}

/**
 * Why `value` is not of `form`, or `null` when it is.
 *
 * A reason rather than a boolean because the audit's whole job is to name what
 * is wrong: *"`--json-schema` is not valid JSON"* is a sentence somebody can
 * act on, and `false` is not.
 */
export function checkArgumentForm(argument: ArgumentFormCheck, value: string): string | null {
  if (argument.form === 'inline-json') {
    try {
      JSON.parse(value);
      return null;
    } catch (error) {
      // The vendor's own diagnosis, in DeFlow's words: it tried to parse what
      // it was handed and failed on the first character of a path.
      return `is not valid JSON (${(error as Error).message})`;
    }
  }

  if (argument.form === 'abs-path') {
    return value.startsWith('/') ? null : 'is not an absolute path';
  }

  if (argument.form === 'uuid') {
    return UUID_PATTERN.test(value) ? null : 'is not a uuid';
  }

  if (argument.form === 'enum') {
    const values = argument.values ?? [];
    return values.includes(value) ? null : `is not one of ${values.join(', ')}`;
  }

  if (argument.form === 'number') {
    // `String(NaN)` and `String(Infinity)` are both things a caller can produce
    // from a budget that went wrong, and both reach a vendor as an argument it
    // will refuse rather than as the ceiling somebody meant.
    return Number.isFinite(Number(value)) && value.trim() !== '' ? null : 'is not a finite number';
  }

  return value === '' ? 'is empty' : null;
}

/** One element of a built argv, matched against the entry's declarations. */
export interface ArgumentAuditRow {
  /** The flag as it appeared, or `null` for a positional. */
  readonly token: string | null;
  /** The declaration this element matched, or `null` when the entry declares
   * nothing for it — which **fails** the audit rather than being skipped. */
  readonly argument: ShimArgument | null;
  /** The value supplied, or `null` for a valueless flag. */
  readonly value: string | null;
  /** Why this element is wrong, or `null`. */
  readonly problem: string | null;
}

/**
 * What each element of `argv` is, according to `declared`.
 *
 * Positionals are matched in declaration order among the tokens no flag claimed
 * — which is how `codex exec … <prompt>` is read: a subcommand first, a prompt
 * last, and both declared rather than inferred.
 */
export function auditArgv(
  declared: readonly ShimArgument[],
  argv: readonly string[],
): readonly ArgumentAuditRow[] {
  const byFlag = new Map<string, ShimArgument>();
  for (const argument of declared) {
    if (argument.flag !== null) byFlag.set(argument.flag, argument);
  }
  const positionals = declared.filter((argument) => argument.flag === null);

  const rows: ArgumentAuditRow[] = [];
  let nextPositional = 0;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const flagged = byFlag.get(token);

    if (flagged !== undefined) {
      if (flagged.valueless === true) {
        rows.push({ token, argument: flagged, value: null, problem: null });
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined) {
        rows.push({
          token,
          argument: flagged,
          value: null,
          problem: `${token} takes a value and nothing followed it`,
        });
        continue;
      }
      index += 1;
      const problem = checkArgumentForm(flagged, value);
      rows.push({
        token,
        argument: flagged,
        value,
        problem: problem === null ? null : `${token} ${problem}`,
      });
      continue;
    }

    const positional = positionals[nextPositional];
    nextPositional += 1;
    if (positional === undefined) {
      rows.push({
        token,
        argument: null,
        value: token,
        problem: `"${token}" has no declared form on this entry`,
      });
      continue;
    }
    const problem = checkArgumentForm(positional, token);
    rows.push({
      token: null,
      argument: positional,
      value: token,
      problem: problem === null ? null : `the ${positional.name} positional ${problem}`,
    });
  }

  return rows;
}
