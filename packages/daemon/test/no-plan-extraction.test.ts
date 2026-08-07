/**
 * KAR-11.1 AC3, AC4 — two absences, asserted, because neither can be seen at
 * runtime.
 *
 * **There is no prose fallback.** 06 §8: *"Do not accept a prose plan. Enforce
 * the schema at the adapter boundary with `--json-schema` / `--output-schema`.
 * A regex over prose is how the planner layer starts breaking on every CLI
 * update."* EPIC-11-S3's first scenario asserts the behaviour — a markdown
 * answer fails `contract.schema-invalid` — but a behavioural test cannot
 * distinguish "no extractor exists" from "the extractor did not fire for this
 * input". This one reads the source.
 *
 * **The plan hash is DeFlow's own encoder, never `ohash`.** 06 §2.3 is explicit
 * that `ohash`'s README promises only *"best efforts"* at stable serialisation,
 * which is *"acceptable for change detection, not for a value that is a primary
 * key in the `plan` table and is referenced by `run.plan_hash` across DeFlowd
 * versions"*. `packages/core/test/purity.test.ts` already holds that line for
 * `@DeFlow/core`; plan compilation and plan persistence live outside it, so the
 * check is widened to every package's production source here.
 *
 * Verifies: EPIC-11-S3 (first scenario), EPIC-11-S4 (fourth scenario) · AC3, AC4
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const compilerPath = join(repoRoot, 'packages/daemon/src/plan/compile.ts');

/** The three-backtick fence, built from a char code so this file can look for
 * one without containing one. */
const BACKTICK_FENCE = String.fromCharCode(96).repeat(3);

/** Every production `.ts` file under any package's `src` directory, tests
 * excluded. */
function productionSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      files.push({ path: path.slice(repoRoot.length), text: readFileSync(path, 'utf8') });
    }
  };
  for (const pkg of readdirSync(join(repoRoot, 'packages'))) {
    const src = join(repoRoot, 'packages', pkg, 'src');
    try {
      if (statSync(src).isDirectory()) walk(src);
    } catch {
      // A package without a src/ directory is not a gap.
    }
  }
  return files;
}

/** Comments removed: prose may discuss a fenced block; code may not look for one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

suite('the plan compiler never parses prose (06 §8)', () => {
  const compiler = code(readFileSync(compilerPath, 'utf8'));

  it('reads the source it is asserting about, so the checks are not vacuous', () => {
    expect(compiler).toContain('structuredOutput');
    expect(compiler.length).toBeGreaterThan(1000);
  });

  it('looks for no fenced code block', () => {
    expect(compiler).not.toContain(BACKTICK_FENCE);
    expect(compiler).not.toMatch(/codeFence|fenced|extractJson/i);
  });

  it('runs no regular expression over the agent’s return', () => {
    // String.match, RegExp.exec and a RegExp constructor are the three shapes
    // an extractor takes. None belongs in a file whose entire contract is
    // "the document arrived in structured_output, or it did not arrive".
    expect(compiler).not.toContain('.match(');
    expect(compiler).not.toContain('.exec(');
    expect(compiler).not.toContain('new RegExp');
  });

  it('never JSON.parses what the agent said', () => {
    expect(compiler).not.toContain('JSON.parse');
  });
});

suite('AC4 — no production source computes a plan hash with ohash', () => {
  const sources = productionSources();

  it('scans a non-trivial number of files', () => {
    expect(sources.length).toBeGreaterThan(100);
  });

  it('imports ohash nowhere in any package’s production source', () => {
    const offenders = sources.filter(
      ({ text }) =>
        /from\s+['"]ohash['"]/.test(code(text)) ||
        /require\(\s*['"]ohash['"]\s*\)/.test(code(text)),
    );

    expect(
      offenders.map(({ path }) => path),
      'ohash promises only "best efforts" at stable serialisation; planHash is a primary key',
    ).toEqual([]);
  });

  it('computes planHash in exactly one place, over the encoder core owns', () => {
    const producers = sources.filter(({ text }) => /export async function planHash\(/.test(text));
    expect(producers.map(({ path }) => path)).toEqual(['packages/core/src/hash.ts']);
  });
});

/**
 * AC5's structural half. The epic's Definition of Done asks for an assertion
 * that there is *"exactly one entry point to plan persistence"*; this is that
 * assertion at the level KAR-11.1 can make it — one writer of the table.
 * KAR-11.2 extends it to "and it validated first", once validation covers all
 * of 06 §3 rather than only reachability.
 *
 * A second `INSERT INTO plan` somewhere else would not be caught by any
 * behavioural test: it would write a perfectly good row, with no `plan.proposed`
 * beside it and no transaction around the pair.
 */
suite('AC5 — one writer of the plan table', () => {
  const sources = productionSources();

  it('inserts into plan from exactly one module', () => {
    const writers = sources.filter(({ text }) => /INSERT\s+INTO\s+plan\b/i.test(code(text)));
    expect(writers.map(({ path }) => path)).toEqual(['packages/ledger/src/plans.ts']);
  });

  it('writes the version file from that same module and nowhere else', () => {
    const writers = sources.filter(({ text }) => code(text).includes('planPathOf('));
    expect(writers.map(({ path }) => path)).toEqual(['packages/ledger/src/plans.ts']);
  });
});
