/**
 * KAR-09.7 — no window-size table, anywhere.
 *
 * `modelUsage[m].contextWindow` and `modelUsage[m].maxOutputTokens` arrive on
 * every result envelope, which means true fill percentage is a division at
 * runtime and a per-model constant is never needed. A table would be wrong
 * within a month of the next model release — and wrong *silently*, because a
 * stale window does not throw: it budgets a packet against a number nobody
 * checked and overfills the context three hours into a run.
 *
 * A table has to name models to be a table, so that is what this greps for. A
 * source file that names no model cannot hold one.
 *
 * **One package is exempt, and the exemption is paid for.** `@DeFlow/testkit`
 * *is* the fake vendor: its exec-shim agent has to emit the wire shape a real
 * CLI emits, model key and window included, or the shim parser would only ever
 * be tested against a shape no vendor produces. It is a test double, never a
 * runtime dependency of the daemon (`test/mock-agent-independence.test.ts`
 * holds that half), and in exchange this file asserts that it names a model
 * only inside a frame it is *emitting*, never in a lookup keyed by one.
 *
 * Verifies: EPIC-09-S36 (scenario 3) · KAR-09.7 AC2
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const packagesDir = new URL('../packages/', import.meta.url).pathname;

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

/**
 * A model-name string literal: a vendor family, then a version number, in
 * quotes. Matches `'claude-sonnet-4-5-20260514'` and `"gpt-4o-2024-08-06"`,
 * and does not match a provider id like `'claude'` — an id is how a binary is
 * invoked, and this rule is about what a *model* costs.
 */
const MODEL_LITERAL =
  /(['"])[a-z]*(?:claude|gpt|gemini|sonnet|opus|haiku)[a-z0-9.-]*-\d[a-z0-9.-]*\1/;

/** The fake vendor's own wire fixtures. */
const FAKE_VENDOR_PREFIX = 'testkit/src/';

const files = sourceFiles();

suite('no source file hardcodes a per-model context window (AC2)', () => {
  it('found source files to check at all', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('exempts one package, and it is the test double', () => {
    expect(files.some((path) => path.startsWith(FAKE_VENDOR_PREFIX))).toBe(true);
  });

  for (const path of files.filter((file) => !file.startsWith(FAKE_VENDOR_PREFIX))) {
    it(`${path} names no model`, () => {
      const named = strippedOfComments(readFileSync(join(packagesDir, path), 'utf8'))
        .split('\n')
        .filter((line) => MODEL_LITERAL.test(line));
      expect(
        named,
        `${path} names a model in executable code, which is the only way a window-size table ` +
          'gets written. Read modelUsage[m].contextWindow off the result envelope instead.',
      ).toHaveLength(0);
    });
  }
});

suite('the exempt package pays for its exemption', () => {
  const fake = files
    .filter((path) => path.startsWith(FAKE_VENDOR_PREFIX))
    .map((path) => ({
      path,
      code: strippedOfComments(readFileSync(join(packagesDir, path), 'utf8')),
    }))
    .filter((file) => MODEL_LITERAL.test(file.code));

  it('names a model, which is why it is exempt', () => {
    expect(fake.length).toBeGreaterThan(0);
  });

  it('names one, so it cannot be a table', () => {
    // A fixture emits one turn on one model. Two or more model literals in the
    // fake vendor would be the beginning of exactly the lookup this forbids.
    for (const file of fake) {
      const literals = new Set(
        [...file.code.matchAll(new RegExp(MODEL_LITERAL, 'g'))].map((match) => match[0]),
      );
      expect(literals.size, `${file.path} names ${[...literals].join(', ')}`).toBe(1);
    }
  });
});
