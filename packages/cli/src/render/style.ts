/**
 * KAR-18.9 AC7, AC9, AC10 — the three decisions a stream forces, made once.
 *
 * **Styling is a property of the stream, not of a line.** Piping a report into
 * a file must produce clean text, and a per-call-site `process.stdout.isTTY`
 * check is exactly how one forgotten branch writes an escape sequence into
 * somebody's log. So the decision is computed once, from an environment that
 * was *passed in*, and every renderer downstream receives the answer rather
 * than the inputs. The usual way this goes wrong is a colour library doing its
 * own detection at import time — at which point `--json` still emits escapes,
 * because the library has never heard of `--json`.
 *
 * `FORCE_COLOR` overrides the TTY test and nothing else: its purpose is "I know
 * this is a pipe and I want colour anyway", and its consumer is a human. It
 * must never override `--json`, whose consumer is a parser.
 *
 * `NO_COLOR` is read by **presence**, including the empty string. The
 * convention says presence and testing it as a boolean is the standard way to
 * get it wrong.
 *
 * Verifies: EPIC-18-S59, EPIC-18-S64 · AC7, AC9, AC10
 */
import process from 'node:process';
import { type Charset, GLYPH_SETS, type ReportState } from './glyphs.ts';

/** What a report is laid out at when nothing can say otherwise (AC9). */
export const DEFAULT_WIDTH = 80;

/**
 * The ceiling on a wide terminal (AC4). A readability limit rather than a
 * technical one: a 240-character line of prose is unreadable whether or not it
 * fits.
 */
export const MAX_WIDTH = 100;

/** The only colours this CLI uses. Named by role at the call site, not here. */
export type StyleColour = 'green' | 'yellow' | 'red' | 'dim' | 'bold';

const CODES: Readonly<Record<StyleColour | 'reset', string>> = {
  dim: '\u001B[2m',
  bold: '\u001B[1m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  reset: '\u001B[0m',
};

/** The colour each state reinforces — never the thing that carries it (AC2). */
export const STATE_COLOURS: Readonly<Record<ReportState, StyleColour>> = {
  ok: 'green',
  warn: 'yellow',
  fail: 'red',
  skipped: 'dim',
};

export interface StyleInput {
  /** Whether the *stream being written to* is a terminal. Passed, not read. */
  readonly isTty: boolean;
  /** The environment this process was given. Never `process.env` in here. */
  readonly env: NodeJS.ProcessEnv;
  /** `stdout.columns`, which is `undefined` under a pipe and on CI runners. */
  readonly columns?: number | undefined;
  /** The command was invoked with `--json`. Beats everything, always. */
  readonly json?: boolean;
  /** The command was invoked with `--no-color`. */
  readonly noColor?: boolean;
}

/**
 * EPIC-18-S59's table, in order. The order *is* the specification: `--json`
 * first because it beats `FORCE_COLOR`, `NO_COLOR` before `FORCE_COLOR`
 * because presence wins over preference, and the TTY test last because
 * `FORCE_COLOR` exists to replace it.
 */
export function shouldStyle(input: StyleInput): boolean {
  if (input.json === true) return false;
  if (input.noColor === true) return false;
  if (input.env.NO_COLOR !== undefined) return false;
  if (input.env.TERM === 'dumb') return false;
  if (input.env.FORCE_COLOR !== undefined) return true;
  return input.isTty;
}

/**
 * `min(stdout.columns, 100)`, with 80 for the terminal that will not say (AC9).
 *
 * `undefined` reaching an arithmetic is the failure this exists to prevent: a
 * `NaN` width turns a naive wrapper into one character per line.
 */
export function terminalWidth(columns: number | undefined, env: NodeJS.ProcessEnv): number {
  const declared = Number.parseInt(env.COLUMNS ?? '', 10);
  const candidate =
    typeof columns === 'number' && Number.isFinite(columns) && columns > 0
      ? columns
      : Number.isFinite(declared) && declared > 0
        ? declared
        : DEFAULT_WIDTH;
  return Math.min(candidate, MAX_WIDTH);
}

/**
 * Whether this terminal's encoding rules UTF-8 out (AC10).
 *
 * The trigger is the one AC10 names: a locale variable that **names a
 * non-UTF-8 charset**. `LC_ALL=C` is such a statement and degrades; an *unset*
 * locale is not a statement at all, and treating silence as Latin-1 would put
 * the ASCII set on the overwhelming majority of terminals — including every CI
 * runner, which is where a snapshot of the output gets taken. The precedence
 * is POSIX's: `LC_ALL` overrides `LC_CTYPE`, which overrides `LANG`.
 */
export function glyphCharset(env: NodeJS.ProcessEnv): Charset {
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG;
  if (locale === undefined || locale === '') return 'utf8';
  return /utf-?8/i.test(locale) ? 'utf8' : 'ascii';
}

export interface Style {
  /** Whether ANSI may be written at all. Decided once; read everywhere. */
  readonly colour: boolean;
  readonly width: number;
  readonly charset: Charset;
  readonly glyphs: Readonly<Record<ReportState, string>>;
  /** `text`, wrapped in `colour` when styling is on and untouched when it is
   * not. The only function in this package that emits an escape. */
  paint(text: string, colour: StyleColour | null): string;
}

export function createStyle(input: StyleInput): Style {
  const colour = shouldStyle(input);
  const charset = glyphCharset(input.env);
  return {
    colour,
    charset,
    width: terminalWidth(input.columns, input.env),
    glyphs: GLYPH_SETS[charset],
    paint: (text, wanted) =>
      !colour || wanted === null ? text : `${CODES[wanted]}${text}${CODES.reset}`,
  };
}

/**
 * The composition root's style: the real stdout, the real environment, the
 * real argv. Called **once**, in `bin.ts`, and the result passed down — which
 * is what makes AC7's "never re-derived at a call site" a property of the
 * shape rather than of anybody's discipline.
 */
export function processStyle(argv: readonly string[]): Style {
  return createStyle({
    isTty: process.stdout.isTTY === true,
    env: process.env,
    columns: process.stdout.columns,
    json: argv.includes('--json'),
    noColor: argv.includes('--no-color'),
  });
}

/** A style that writes no escape and lays out at 80 columns — what a command
 * called in-process (a spec, a library caller) gets when it says nothing. */
export function plainStyle(env: NodeJS.ProcessEnv = {}): Style {
  return createStyle({ isTty: false, env });
}

/**
 * KAR-21.5 AC4 — the window changed size; here is the `Style` for the new one.
 *
 * Node emits `'resize'` on `process.stdout` when the process is sent SIGWINCH,
 * so this is that signal with the terminal's new size already read. It lives
 * **here** rather than in `run.ts` for the reason `processStyle` does: the
 * terminal's width is derived in exactly one place in this package, and
 * `test/render-guard.test.ts`'s third rule is what keeps that true. A resize
 * handler that read `stdout.columns` at the call site would be that rule's
 * first exception, and AC9's 80-column fallback is worth nothing with one.
 *
 * `rows` is handed over beside the style rather than folded into it because
 * height is not a styling decision — nothing about colour, glyphs or wrapping
 * depends on it — and it is read here only so that it is read in the same place
 * and at the same instant as the width it has to agree with.
 */
export function onProcessResize(
  argv: readonly string[],
  handler: (style: Style, rows: number | undefined) => void,
): () => void {
  const listener = (): void => {
    handler(processStyle(argv), process.stdout.rows);
  };
  process.stdout.on('resize', listener);
  return () => {
    process.stdout.off('resize', listener);
  };
}
