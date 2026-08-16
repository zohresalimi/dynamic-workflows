/**
 * KAR-18.9 AC1 / EPIC-18-S63 — one presentation layer, five commands, no
 * second formatter.
 *
 * This is the story's only defence against next month. Every per-command
 * formatter the CLI grew was written by somebody reasonably deciding that one
 * command's output was a small special case, and five small special cases are
 * exactly the state KAR-18.9 is fixing. A guard that names the file and the
 * reason is cheaper than a review that has to notice.
 *
 * Three rules, over the code with comments stripped — this package's prose
 * quotes glyphs and escape sequences while explaining why they are centralised,
 * and code must be judged on its own:
 *
 *  1. no ANSI escape literal outside `src/render/`;
 *  2. no status-glyph literal outside it — a `✓` in a command module is a
 *     second glyph vocabulary, and AC2 only holds if there is one;
 *  3. no command computes a terminal width of its own, because AC9's 80-column
 *     fallback is worth nothing if one call site reads `stdout.columns`
 *     directly and hands `undefined` to an arithmetic.
 *
 * KAR-21.1 AC1 adds a fourth, over a wider set of files than the other three:
 *
 *  4. **cursor motion and erase sequences live in `src/render/screen.ts` and
 *     nowhere else** — including nowhere else *inside* `src/render/`. EPIC-21's
 *     own stated biggest risk is a second presentation layer growing beside
 *     KAR-18.9's, and a second module that moves the cursor is what that looks
 *     like on the day it happens. Rules 1-3 are unchanged and still pass.
 *
 * The rule is a function of a path and a source rather than a loop over the
 * disk, so EPIC-21-S07's second scenario can hand it a fixture and watch it
 * bite. A guard extended in name only passes forever.
 *
 * Verifies: EPIC-18-S63, EPIC-21-S07 · AC1 · test plan #7
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { ASCII_GLYPHS, TRANSCRIPT_GLYPHS, UTF8_GLYPHS } from '../src/render/glyphs.ts';

const CLI_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const RENDER_MODULE = join(CLI_SRC, 'render');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.type-test.ts')) return [];
    return [path];
  });
}

/** Over-removes at worst, which can only make the rules below stricter. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Everything under `packages/cli/src` except the render module itself. */
const guarded = (): string[] =>
  sourceFiles(CLI_SRC).filter((file) => !file.startsWith(`${RENDER_MODULE}/`));

const REASON =
  'The five commands must look like one tool: glyph, colour, alignment, wrapping and the ' +
  'summary block belong to packages/cli/src/render/ and nowhere else (KAR-18.9 AC1).';

/** The one module KAR-21.1 AC1 allows to move or erase anything. */
const SCREEN_MODULE = 'render/screen.ts';

const CURSOR_REASON =
  `Cursor movement and erase sequences belong to packages/cli/src/${SCREEN_MODULE} and ` +
  'nowhere else (KAR-21.1 AC1). EPIC-21 exists because a second presentation layer beside ' +
  "KAR-18.9's is the risk it is most likely to fail on, and a second module that repaints the " +
  'terminal is what that failure looks like on the day it arrives.';

/**
 * Rule 4, as a function of one file so a fixture can be run through it.
 *
 * The patterns are the CSI forms a repaint is written with — an erase, a
 * cursor move in any direction, a column reset, a save/restore, and the cursor
 * visibility toggles — matched against the escaped spellings TypeScript source
 * actually carries as well as against a real ESC byte.
 */
function cursorMotionRule(path: string, code: string): string | null {
  if (path === SCREEN_MODULE) return null;
  // A real ESC byte, and the four ways TypeScript source spells one.
  const escape = `(?:\u001B|${String.raw`\\u001[bB]|\\x1[bB]|\\033|\\e`})`;
  const patterns: [RegExp, string][] = [
    [new RegExp(`${escape}\\[\\d*[KJ]`), 'an erase sequence'],
    [new RegExp(`${escape}\\[\\d*[ABCDEFGHnSTdf]`), 'a cursor move'],
    [new RegExp(`${escape}\\[\\?25[lh]`), 'a cursor visibility toggle'],
    [new RegExp(`${escape}[78]`), 'a cursor save or restore'],
  ];
  for (const [pattern, what] of patterns) {
    if (pattern.test(code)) return `${path} writes ${what} itself`;
  }
  return null;
}

suite('the render module is the only formatter (EPIC-18-S63)', () => {
  it('covers the command modules the five commands print through', () => {
    // A directory walk, so moving a command out of `src/` would drop it from
    // the guard silently. This is what turns that into a failing test.
    const covered = guarded().map((file) => relative(CLI_SRC, file));
    for (const file of [
      'bin.ts',
      'init.ts',
      'status.ts',
      'ledger-snapshot.ts',
      'doctor/run.ts',
      'doctor/report.ts',
      'run/render.ts',
    ]) {
      expect(covered).toContain(file);
    }
  });

  it('finds no ANSI escape literal outside it', () => {
    for (const file of guarded()) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const literal of ['\u001B', '\\u001B', '\\x1b', '\\x1B', '\\e[', '\\033']) {
        expect(
          code.includes(literal),
          `${relative(CLI_SRC, file)} writes the ANSI escape "${literal}" itself. ${REASON}`,
        ).toBe(false);
      }
    }
  });

  it('finds no status-glyph literal outside it', () => {
    const glyphs = [
      ...Object.values(UTF8_GLYPHS),
      ...Object.values(TRANSCRIPT_GLYPHS.utf8),
      // The ASCII set is deliberately not scanned for: `-`, `+`, `x` and `!`
      // are ordinary characters in ordinary code, and a rule that flagged them
      // would be turned off within a week. The UTF-8 set is what a hand-rolled
      // formatter reaches for.
    ].filter((glyph) => /[^ -~]/.test(glyph));

    expect(glyphs.length).toBeGreaterThan(0);
    for (const file of guarded()) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const glyph of glyphs) {
        expect(
          code.includes(glyph),
          `${relative(CLI_SRC, file)} spells the status glyph "${glyph}" itself. ${REASON}`,
        ).toBe(false);
      }
    }
  });

  it('finds no command computing a terminal width of its own', () => {
    for (const file of guarded()) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const pattern of [/\.columns\b/, /\bCOLUMNS\b/, /\bgetWindowSize\b/]) {
        expect(
          pattern.test(code),
          `${relative(CLI_SRC, file)} reads a terminal width (${pattern.source}). AC9's ` +
            '80-column fallback is worth nothing if one call site derives its own. ' +
            REASON,
        ).toBe(false);
      }
    }
  });

  it('covers the session modules and the screen too (EPIC-21-S07)', () => {
    // Rules 1-3 walk everything outside `render/`; rule 4 walks everything,
    // and the file list is what makes "it is run over `src`" mean something.
    const covered = sourceFiles(CLI_SRC).map((file) => relative(CLI_SRC, file));

    expect(covered).toContain('run/session/view.ts');
    expect(covered).toContain('render/screen.ts');
  });

  it('finds no cursor motion or erase outside render/screen.ts (EPIC-21-S07)', () => {
    for (const file of sourceFiles(CLI_SRC)) {
      const path = relative(CLI_SRC, file);
      expect(
        cursorMotionRule(path, codeOnly(readFileSync(file, 'utf8'))),
        `${path} moves or erases the cursor itself. ${CURSOR_REASON}`,
      ).toBeNull();
    }
  });

  it('bites when a second module starts writing cursor motion (EPIC-21-S07)', () => {
    // The fixture is the shape the epic is afraid of: an erase-line literal in
    // a session module, added by somebody reasonably solving one small problem.
    const fixture = "const clear = '\\u001B[2K';\nexport const wipe = () => clear;\n";

    const violation = cursorMotionRule('run/session/composer.ts', fixture);

    expect(violation).not.toBeNull();
    expect(violation).toContain('run/session/composer.ts');
    expect(violation).toContain('erase');

    // And it is the *location* that is the offence, not the literal: the same
    // bytes inside `render/screen.ts` are the whole point of that module.
    expect(cursorMotionRule('render/screen.ts', fixture)).toBeNull();
  });

  it('keeps the ASCII fallback distinct from the UTF-8 set it replaces', () => {
    // Not a source rule but the same decay: an ASCII set that reused a UTF-8
    // glyph would put a replacement character back on a C-locale terminal.
    for (const glyph of Object.values(ASCII_GLYPHS)) {
      expect(/^[ -~]+$/.test(glyph)).toBe(true);
    }
  });
});
