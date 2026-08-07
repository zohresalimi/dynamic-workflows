/**
 * KAR-09.6 AC7 — the auto-compaction threshold is derived, never written down.
 *
 * EPIC-09-S35's first scenario states it as a property of the tree: a model
 * reporting `contextWindow: 200_000` and `maxOutputTokens: 32_000` has an
 * effective window of 180_000 and compacts at 167_000, *and no source file
 * contains either number as a literal*. Both are functions of what the turn
 * reported — the day a model ships with a different window, a literal is a
 * threshold that is silently wrong rather than a build that fails.
 *
 * The offsets themselves (20_000, 13_000) are exempt and are the point: they
 * are the decoded constants, they live in exactly one place
 * (`provider-registry.ts`'s `compaction` entry), and `checkCompactionShape`
 * is what catches them drifting.
 *
 * Verifies: EPIC-09-S35 (first scenario) · AC7
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const packagesDir = new URL('../packages/', import.meta.url).pathname;

/**
 * The two derived numbers, in every spelling TypeScript accepts for them.
 * `180000`, `180_000`, `1.8e5` — a rule that only caught the first would be a
 * rule the next person routes around by accident.
 */
const DERIVED = [180_000, 167_000] as const;

function spellings(value: number): readonly RegExp[] {
  const plain = String(value);
  const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  return [
    new RegExp(`(?<![\\d._])${plain}(?![\\d._])`),
    new RegExp(`(?<![\\d._])${grouped}(?![\\d._])`),
  ];
}

function strippedOfComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

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
      try {
        return walk(join(packagesDir, entry.name, 'src'));
      } catch {
        return [];
      }
    })
    .map((path) => path.slice(packagesDir.length));
}

const files = sourceFiles();

/** The check itself, so the guard is exercised against a violation rather than
 * only against a tree that happens to be clean. */
function offendingLines(code: string): readonly string[] {
  const patterns = DERIVED.flatMap((value) => spellings(value));
  return strippedOfComments(code)
    .split('\n')
    .filter((line) => patterns.some((pattern) => pattern.test(line)));
}

suite('the guard catches what it claims to catch', () => {
  it('flags a hardcoded threshold in any spelling', () => {
    expect(offendingLines('const AUTO_COMPACT_AT = 167000;')).toHaveLength(1);
    expect(offendingLines('const EFFECTIVE_WINDOW = 180_000;')).toHaveLength(1);
  });

  it('ignores the numbers inside a comment, which is where they are explained', () => {
    expect(offendingLines('// compacts at 167_000 for a 200k window')).toHaveLength(0);
  });

  it('ignores a number that merely contains the digits', () => {
    expect(offendingLines('const bytes = 1_167_000_000;')).toHaveLength(0);
  });
});

suite('no source file hardcodes a derived threshold (EPIC-09-S35)', () => {
  it('found source files to check at all', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const path of files) {
    it(`${path} derives its thresholds`, () => {
      const offenders = offendingLines(readFileSync(join(packagesDir, path), 'utf8'));

      expect(
        offenders,
        `${path} writes down a number that is a function of what the turn reported. Derive it: ` +
          'effectiveWindowOf() and defaultAutoCompactThreshold() take the window off ' +
          'modelUsage, and the two offsets live in the provider registry.',
      ).toHaveLength(0);
    });
  }
});
