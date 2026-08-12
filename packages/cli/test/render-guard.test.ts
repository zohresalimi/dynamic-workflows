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
 * Verifies: EPIC-18-S63 · AC1 · test plan #7
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

  it('keeps the ASCII fallback distinct from the UTF-8 set it replaces', () => {
    // Not a source rule but the same decay: an ASCII set that reused a UTF-8
    // glyph would put a replacement character back on a C-locale terminal.
    for (const glyph of Object.values(ASCII_GLYPHS)) {
      expect(/^[ -~]+$/.test(glyph)).toBe(true);
    }
  });
});
