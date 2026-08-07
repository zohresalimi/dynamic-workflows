/**
 * KAR-09.7 AC2 — the CI grep that keeps the `usage` trap out of the tree.
 *
 * Claude Code's result envelope carries two token blocks. `usage` is typed
 * `z.unknown()` in the CLI's own zod schema — a raw passthrough of Anthropic's
 * API object, with no shape guarantee and no `contextWindow` — while
 * `modelUsage` is typed and carries the window DeFlow needs so that no
 * window-size table has to exist. Reading the wrong one does not fail; it
 * produces a plausible number that a budget ceiling then acts on.
 *
 * The rule is therefore mechanical: **no source file may read a `usage`
 * property off a raw vendor line.** `ShimLine.raw` is the one container a raw
 * vendor line lives in anywhere in this repository, so the grep is exact rather
 * than approximate, and `modelUsage`/`shimResultUsage`/`result.usage` (the
 * *domain* `TokenUsage` on a `CompletedNodeResult`) are all outside it by
 * construction.
 *
 * **One file is exempt, and the exemption is paid for.** The jsonl dialect's
 * `turn.completed` frame reports its counts under a key that happens to be
 * spelled the same way, and it is a different line type from a different vendor
 * with a documented shape. `turn-frames.ts` may read it and, in exchange, this
 * file asserts that `turn-frames.ts` knows nothing about the `result` envelope
 * at all — the same trade `no-capability-table.test.ts` makes with
 * `provider-registry.ts`.
 *
 * Verifies: EPIC-09-S36 (scenario 2) · KAR-09.7 AC2
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const packagesDir = new URL('../../', import.meta.url).pathname;

/** Whole-line `//` comments and every block comment. Over-removes at worst,
 * which can only make the check stricter about what it still sees. */
function strippedOfComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every non-test `.ts` under any package's `src` tree, repo-relative. */
function sourceFiles(): readonly string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const src = join(packagesDir, entry.name, 'src');
      try {
        return walk(src);
      } catch {
        return [];
      }
    })
    .map((path) => path.slice(packagesDir.length));
}

/**
 * A read of a property literally named `usage` off a `raw` vendor line, in any
 * of the three spellings TypeScript allows. `modelUsage` cannot match: the
 * character before `usage` would be `l`, which the boundary refuses.
 */
const RAW_USAGE = /\braw\s*(?:\.\s*usage\b|\[\s*(['"])usage\1\s*\])/;

/** The one file allowed to read it, kept as a list of exactly one so that
 * adding a second is a deliberate edit to this line. */
const TURN_DIALECT = ['adapters/src/turn-frames.ts'];

const files = sourceFiles();

suite('no source file reads the result envelope’s usage field (AC2)', () => {
  it('found source files to check at all', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('exempts exactly one file, and it exists', () => {
    expect(TURN_DIALECT).toHaveLength(1);
    expect(files.filter((path) => TURN_DIALECT.includes(path))).toHaveLength(1);
  });

  for (const path of files.filter((file) => !TURN_DIALECT.includes(file))) {
    it(`${path} does not read raw.usage`, () => {
      const offending = strippedOfComments(readFileSync(join(packagesDir, path), 'utf8'))
        .split('\n')
        .filter((line) => RAW_USAGE.test(line));
      expect(
        offending,
        `${path} reads a raw vendor line's \`usage\`. The CLI types that field z.unknown() and ` +
          'guarantees nothing about its shape; read modelUsage, which is typed and carries the ' +
          'context window.',
      ).toHaveLength(0);
    });
  }
});

suite('the exempt file pays for its exemption', () => {
  const exempt = TURN_DIALECT.map((path) => ({
    path,
    code: strippedOfComments(readFileSync(join(packagesDir, path), 'utf8')),
  }));

  it('reads the counts it is exempt for', () => {
    for (const file of exempt) expect(RAW_USAGE.test(file.code)).toBe(true);
  });

  it('knows nothing about the result envelope', () => {
    // The trade: this file may spell `usage` because the frame it parses is a
    // different line type entirely. A reference to the `result` envelope here
    // would be the trap arriving through the one door left open.
    for (const file of exempt) {
      expect(file.code).not.toContain("'result'");
      expect(file.code).not.toContain('modelUsage');
    }
  });
});
