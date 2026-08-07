/**
 * KAR-09.7 AC3 — Tier 2 goes through the encoding-specific entrypoint, and
 * stays there.
 *
 * The straightforward reading of "a bundle-size assertion catches a regression
 * to the barrel import" does not discriminate in `gpt-tokenizer@3.4.0`: the
 * package's own `main` re-exports `encoding/o200k_base` and nothing else, so
 * the barrel and the entrypoint currently resolve to the *same* two megabytes.
 * Asserting one is smaller than the other would be a test that passes for a
 * reason unrelated to what it claims, and would go on passing after upstream
 * changed the barrel back.
 *
 * So the budget is stated against the thing that actually costs: **BPE tables**.
 * One encoding is ~2.2 MB of ranks; a second is another ~1.1 MB. A graph that
 * reaches exactly one `bpeRanks/*` module, under a stated byte ceiling, is a
 * claim that survives upstream reshuffling the entrypoints — and it is red the
 * moment a second encoding is pulled in, whether through the barrel, through
 * `gpt-tokenizer/model/…`, or through a second `encoding/…` import.
 *
 * Verifies: EPIC-09-S37 · KAR-09.7 AC3
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

/** The ceiling for the daemon's tokenizer graph. Today's o200k_base graph is
 * ~2.2 MiB; the smallest second table upstream ships is ~1.1 MiB, so anything
 * that pulls a second one lands well above this. */
const GRAPH_BUDGET_BYTES = 2_816 * 1_024;

interface Graph {
  readonly files: readonly string[];
  readonly bytes: number;
}

/**
 * Every module statically reachable from `entry`, and their total size on disk.
 *
 * A hand-rolled walk rather than a bundler: the daemon is not bundled at test
 * time, and running one here would measure the bundler's tree-shaking rather
 * than what the daemon actually loads.
 *
 * Relative specifiers are followed always — they are what a package's internal
 * graph is made of. Bare ones are followed except for `node:` builtins and
 * `@DeFlow/*`, so the number is the tokenizer module's **third-party** weight
 * and not a restatement of how large the workspace is. Bare specifiers resolve
 * from this file, which lives inside `@DeFlow/daemon` and therefore resolves
 * exactly as the module under test does.
 */
function moduleGraph(entryUrl: string): Graph {
  const seen = new Set<string>();
  const stack = [entryUrl];
  let bytes = 0;

  while (stack.length > 0) {
    const url = stack.pop();
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);

    let source: string;
    const path = fileURLToPath(url);
    try {
      source = readFileSync(path, 'utf8');
      bytes += statSync(path).size;
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('.')) {
        stack.push(new URL(specifier, url).href);
        continue;
      }
      if (specifier.startsWith('node:') || specifier.startsWith('@DeFlow/')) continue;
      try {
        stack.push(import.meta.resolve(specifier));
      } catch {
        // Unresolvable from here is a specifier this measurement has nothing
        // to say about, not a failure of the budget.
      }
    }
  }

  return { files: [...seen], bytes };
}

const ENCODING_ENTRYPOINT = 'gpt-tokenizer/encoding/o200k_base';

suite('the Tier-2 tokenizer graph carries one BPE table (AC3)', () => {
  const graph = moduleGraph(import.meta.resolve('../src/tokens/tokenizer.ts'));

  it('reaches gpt-tokenizer at all, so the budget is measuring something', () => {
    expect(graph.bytes).toBeGreaterThan(0);
  });

  it('reaches exactly one BPE ranks module, and it is o200k_base', () => {
    const tables = graph.files.filter((url) => url.includes('/bpeRanks/'));
    expect(
      tables.map((url) => url.slice(url.lastIndexOf('/') + 1)),
      'a second BPE table means the barrel — or a second encoding — crept back in',
    ).toEqual(['o200k_base.js']);
  });

  it('stays inside the stated byte budget', () => {
    expect(
      graph.bytes,
      `the tokenizer graph is ${Math.round(graph.bytes / 1_024)} KiB; the budget is ` +
        `${Math.round(GRAPH_BUDGET_BYTES / 1_024)} KiB. A second BPE table is about 1 MiB.`,
    ).toBeLessThan(GRAPH_BUDGET_BYTES);
  });
});

suite('no source file imports the barrel (AC3)', () => {
  const packagesDir = new URL('../../', import.meta.url).pathname;

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    });

  const files = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return walk(join(packagesDir, entry.name, 'src'));
      } catch {
        return [];
      }
    });

  it('found source files to check at all', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('names only the encoding-specific specifier, and only in one file', () => {
    const importers = files.filter((path) =>
      /from\s*['"]gpt-tokenizer/.test(readFileSync(path, 'utf8')),
    );
    expect(importers).toHaveLength(1);

    const specifiers = new Set(
      importers.flatMap((path) =>
        [...readFileSync(path, 'utf8').matchAll(/from\s*['"](gpt-tokenizer[^'"]*)['"]/g)].map(
          (match) => match[1],
        ),
      ),
    );
    expect([...specifiers]).toEqual([ENCODING_ENTRYPOINT]);
  });
});
