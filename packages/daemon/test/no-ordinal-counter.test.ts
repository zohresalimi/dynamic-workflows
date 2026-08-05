/**
 * KAR-06.3 AC6 / EPIC-06-S9 scenario 2 — no `ordinal` is ever incremented on
 * an instance, a module or a closure variable.
 *
 * This is a property of the *absence* of code, which is why it is a grep test
 * rather than a behaviour test. A held counter passes every other spec in the
 * suite — it produces 0, 1, 2 in a single process exactly as a derived one
 * does — and it is wrong only after a crash, where it resets to zero and hands
 * the second effect of an interrupted attempt the first effect's key. That is
 * a bug that never shows up in a green run, so what has to be asserted is that
 * the shape which would cause it does not exist.
 *
 * The scan covers the three packages that could hold one: the orchestrator's
 * home (`packages/daemon/src`), the pure core that derives it and the ledger
 * that stores it.
 *
 * Verifies: EPIC-06-S9 (scenario 2) · AC6
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

interface Source {
  readonly path: string;
  readonly text: string;
}

function sourcesUnder(dir: string, prefix: string): Source[] {
  const found: Source[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourcesUnder(full, `${prefix}${entry}/`));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    found.push({ path: `${prefix}${entry}`, text: readFileSync(full, 'utf8') });
  }
  return found;
}

const packageSrc = (name: string): string =>
  new URL(`../../${name}/src/`, import.meta.url).pathname;

/** The rule is about expressions, not prose: the file that explains why a
 * counter is forbidden must not be the file this test fails on. */
const code = (source: Source): Source => ({
  ...source,
  text: source.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
});

const sources = [
  ...sourcesUnder(packageSrc('daemon'), 'packages/daemon/src/'),
  ...sourcesUnder(packageSrc('core'), 'packages/core/src/'),
  ...sourcesUnder(packageSrc('ledger'), 'packages/ledger/src/'),
].map(code);

/**
 * `ordinal++`, `ordinal += 1`, `ordinal = ordinal + 1`, `this.ordinal = …`,
 * `#ordinal = …` — every spelling of "keep it and bump it", case-insensitive
 * so `nextOrdinal++` and `_ordinal += 1` are caught too. An assignment inside
 * an object literal (`ordinal: n`) is not a match and must not be.
 */
const HELD_COUNTER =
  /\b[\w.#]*ordinal\s*(\+\+|--|\+=|-=)|\b[\w.#]*ordinal\s*=\s*[\w.#]*ordinal\s*[+-]|\bthis\.#?[\w]*ordinal\s*=|\b#[\w]*ordinal\s*=/i;

const matching = (files: readonly Source[]): string[] =>
  files
    .filter((file) => HELD_COUNTER.test(file.text))
    .map((file) => `${file.path} holds an ordinal`);

suite('no ordinal counter is held anywhere (EPIC-06-S9 scenario 2, AC6)', () => {
  it('scanned a real, non-empty set of sources', () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.map((file) => file.path)).toContain('packages/ledger/src/effects.ts');
    expect(sources.map((file) => file.path)).toContain('packages/daemon/src/effects/durable.ts');
  });

  it('has no incremented or assigned ordinal field in daemon, core or ledger', () => {
    expect(matching(sources)).toEqual([]);
  });

  it('and that is a real result, not an empty scan', () => {
    const planted: Source[] = [
      { path: 'a.ts', text: 'this.ordinal += 1;' },
      { path: 'b.ts', text: 'let ordinal = 0; ordinal++;' },
      { path: 'c.ts', text: 'nextOrdinal = nextOrdinal + 1;' },
      { path: 'd.ts', text: 'this.#ordinal = 0;' },
    ];
    expect(matching(planted)).toHaveLength(4);
  });

  it('does not object to reading a derived ordinal or passing one along', () => {
    const innocent: Source[] = [
      { path: 'a.ts', text: 'const ordinal = nextOrdinal(db, key);' },
      { path: 'b.ts', text: 'return { ordinal: row.ordinal, kind };' },
      { path: 'c.ts', text: 'ikey(runId, nodeId, attempt, ordinal)' },
    ];
    expect(matching(innocent)).toEqual([]);
  });
});
