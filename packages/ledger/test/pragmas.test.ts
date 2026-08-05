/**
 * KAR-03.1 — the seven PRAGMAs, their order, and the constant behind
 * `synchronous`.
 *
 * The order is asserted by *observing the calls*, not by reading the end state
 * back off a connection. Three of the seven are already the compile-time
 * default of the binary this project ships (measured against
 * `PRAGMA compile_options` on better-sqlite3@13.0.2: `DEFAULT_WAL_SYNCHRONOUS=1`,
 * `DEFAULT_FOREIGN_KEYS`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`), and
 * better-sqlite3's own `timeout` option sets a fourth — so a read-back test
 * would pass on a connection that had set nothing at all. The fake `Db` records
 * what was executed, which is the only way to tell those two apart.
 *
 * Verifies: EPIC-03-S2 (scenario 1), EPIC-03-S25 (scenario 4) · AC1, AC8
 */

import { FakeDb } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import { applyPragmas, LEDGER_PRAGMAS, SYNCHRONOUS } from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const readRepoFile = (path: string): string => readFileSync(new URL(path, root), 'utf8');

/** The seven statements of docs/05-durable-execution.md §7.1, in its order. */
const DOCUMENTED = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'busy_timeout = 5000',
  'foreign_keys = ON',
  'wal_autocheckpoint = 1000',
  'journal_size_limit = 67108864',
  'cache_size = -32000',
];

/** The `PRAGMA …;` lines of the fenced SQL block under §7.1, in file order. */
function pragmasFromArchitecture(): string[] {
  const doc = readRepoFile('docs/05-durable-execution.md');
  const start = doc.indexOf('### 7.1 PRAGMAs, in this order, on every open');
  expect(start).toBeGreaterThan(-1);
  const section = doc.slice(start, doc.indexOf('\n### ', start + 1));
  return [...section.matchAll(/^PRAGMA\s+(.+?);/gm)].map((match) => (match[1] ?? '').trim());
}

suite('the pragma list (AC1)', () => {
  it('is the seven statements the architecture names, in its order', () => {
    expect([...LEDGER_PRAGMAS]).toEqual(DOCUMENTED);
  });

  it('agrees with docs/05-durable-execution.md §7.1 rather than restating it', () => {
    expect(pragmasFromArchitecture()).toEqual([...LEDGER_PRAGMAS]);
  });

  it('applies them to a connection in exactly that order', () => {
    const db = new FakeDb();
    applyPragmas(db);
    expect(db.pragmaLog).toEqual([...LEDGER_PRAGMAS]);
  });

  it('puts journal_mode first, because it is the only persistent one', () => {
    expect(LEDGER_PRAGMAS[0]).toBe('journal_mode = WAL');
  });

  it('puts busy_timeout before anything that could contend', () => {
    const applied = [...LEDGER_PRAGMAS];
    expect(applied.indexOf('busy_timeout = 5000')).toBeLessThan(applied.length - 1);
  });
});

suite('the synchronous constant (AC8)', () => {
  const source = readRepoFile('packages/ledger/src/pragmas.ts');

  it('is one named constant, and the pragma list is built from it', () => {
    expect(SYNCHRONOUS).toBe('NORMAL');
    expect(LEDGER_PRAGMAS).toContain(`synchronous = ${SYNCHRONOUS}`);
  });

  it('carries the measured cost of the alternative in a comment', () => {
    expect(source).toContain('979');
    expect(source).toContain('22,982');
    expect(source).toContain('23');
  });

  it('names the machine and the date the shipping value was measured on', () => {
    // EPIC-03-S25 scenario 4: the setting comes from a measurement on the
    // target machine, not from the doc's Linux figures (roadmap A1-1).
    expect(source).toContain('Mac15,4');
    expect(source).toContain('2026-08-04');
  });
});
