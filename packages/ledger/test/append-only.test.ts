/**
 * KAR-03.3 — the `event` table is append-only, and the cursor contract is
 * "strictly greater than".
 *
 * Both are properties of the *absence* of code, which is why they are grep
 * tests rather than behaviour tests: an `amendEvent()` helper or a
 * `cursor + 1` resume would each pass every other test in this package while
 * quietly destroying the one guarantee `seq` exists to give. The scan is over
 * production sources only — migrations may create and alter tables, and a test
 * may delete a row to *prove* pruning does not reuse a number.
 *
 * Verifies: EPIC-03-S9 (scenario 2's last clause) · AC3, AC7
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { SQL_AGGREGATE_PROJECTION } from '../../../test/support/guards.ts';

interface Source {
  readonly path: string;
  readonly text: string;
}

const packageRoot = (name: string): string =>
  new URL(`../../${name}/src/`, import.meta.url).pathname;

function typeScriptSources(dir: string, prefix: string): Source[] {
  const found: Source[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...typeScriptSources(full, `${prefix}${entry}/`));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    found.push({ path: `${prefix}${entry}`, text: readFileSync(full, 'utf8') });
  }
  return found;
}

const ledgerSources = typeScriptSources(packageRoot('ledger'), 'packages/ledger/src/');
const daemonSources = typeScriptSources(packageRoot('daemon'), 'packages/daemon/src/');

/** Everything except `src/migrations/`, which is the one place DDL belongs. */
const nonMigrationLedgerSources = ledgerSources.filter(
  (source) => !source.path.startsWith('packages/ledger/src/migrations/'),
);

const matching = (sources: readonly Source[], pattern: RegExp): string[] =>
  sources
    .filter((source) => pattern.test(source.text))
    .map((source) => `${source.path} matches ${pattern}`);

/**
 * The same sources with comments removed.
 *
 * The rule is about expressions, not prose: a file that documents "resume from
 * strictly greater than your cursor, never `cursor + 1`" is the file doing it
 * right, and a scan that cannot tell the two apart would punish the
 * explanation and reward silence.
 */
const code = (sources: readonly Source[]): Source[] =>
  sources.map((source) => ({
    ...source,
    text: source.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
  }));

suite('nothing mutates a row in event (AC7)', () => {
  it('scanned a real, non-empty set of sources', () => {
    expect(ledgerSources.length).toBeGreaterThan(0);
    expect(daemonSources.length).toBeGreaterThan(0);
    expect(ledgerSources.map((source) => source.path)).toContain('packages/ledger/src/append.ts');
  });

  it('has no UPDATE against event outside migrations', () => {
    expect(matching(nonMigrationLedgerSources, /\bUPDATE\s+event\b/i)).toEqual([]);
    expect(matching(daemonSources, /\bUPDATE\s+event\b/i)).toEqual([]);
  });

  it('has no DELETE FROM event outside migrations', () => {
    expect(matching(nonMigrationLedgerSources, /\bDELETE\s+FROM\s+event\b/i)).toEqual([]);
    expect(matching(daemonSources, /\bDELETE\s+FROM\s+event\b/i)).toEqual([]);
  });

  /**
   * The verbs an event mutator would have to be spelled with. Applied to
   * exported **functions** only: the guard is about the API offering a way to
   * amend the log, and a constant cannot be called. `PATCH_STALE` — KAR-11.3's
   * rejection code for a proposal derived against a plan that has moved on — is
   * exactly that shape, and it names a *refusal to write* rather than a write.
   */
  const MUTATOR = /^(amend|update|delete|remove|prune|rewrite|patch)/i;

  it('exports no amend, update, delete, prune or rewrite for events', async () => {
    const ledger: Record<string, unknown> = await import('../src/index.ts');
    const suspicious = Object.entries(ledger)
      .filter(([name, value]) => MUTATOR.test(name) && typeof value === 'function')
      .map(([name]) => name);
    expect(suspicious).toEqual([]);
  });

  it('and that guard still has teeth: a mutator function would be caught', () => {
    const planted = { patchEvent: () => undefined, PATCH_STALE: 'PATCH_STALE' };
    const suspicious = Object.entries(planted)
      .filter(([name, value]) => MUTATOR.test(name) && typeof value === 'function')
      .map(([name]) => name);
    expect(suspicious).toEqual(['patchEvent']);
  });

  it('and that is a real result, not an empty scan', () => {
    // Take the guard's own subject away and it must object — otherwise this
    // suite would pass for ever on a typo in the pattern.
    const planted: Source[] = [
      { path: 'planted.ts', text: "db.prepare('UPDATE event SET payload = ? WHERE seq = ?')" },
    ];
    expect(matching(planted, /\bUPDATE\s+event\b/i)).toHaveLength(1);
  });
});

suite('no consumer computes cursor + 1 (EPIC-03-S9 scenario 2, AC3)', () => {
  const CURSOR_ARITHMETIC = /\b(seq|cursor|last_?seq|lastSeq|afterSeq)\s*\+\s*1\b/i;

  it('has no such expression in packages/ledger or packages/daemon', () => {
    expect(matching(code(ledgerSources), CURSOR_ARITHMETIC)).toEqual([]);
    expect(matching(code(daemonSources), CURSOR_ARITHMETIC)).toEqual([]);
  });

  it('and that is a real result, not an empty scan', () => {
    const planted: Source[] = [{ path: 'planted.ts', text: 'const from = cursor + 1;' }];
    expect(matching(code(planted), CURSOR_ARITHMETIC)).toHaveLength(1);
  });

  /**
   * SQL in this package lives one statement to a string or template literal, so
   * the rule can be applied per statement rather than per file. That is
   * stricter than a file-wide scan — a file holding one good window no longer
   * vouches for a bad one next to it — and it is what lets counting aggregates
   * be exempted honestly (KAR-03.4's `readRunStats`, KAR-03.8's run
   * discovery): `count(*)`, `max(seq)` and `min(seq) … GROUP BY run_id` return
   * a single row — one per run at worst — hold no cursor and hand nobody a
   * `seq` to resume from, so there is no window for them to get wrong.
   */
  const SQL_LITERALS = /`[^`]*`|'(?:[^'\\\n]|\\.)*'/g;

  const eventReads = (source: Source): { path: string; sql: string }[] =>
    (source.text.match(SQL_LITERALS) ?? [])
      .filter((sql) => /\bSELECT\b/i.test(sql) && /\bFROM\s+event\b/i.test(sql))
      .map((sql) => ({ path: source.path, sql }));

  it('every event read in the ledger is a strictly-greater-than window', () => {
    const statements = code(nonMigrationLedgerSources).flatMap(eventReads);
    expect(statements.length).toBeGreaterThan(0);
    for (const { path, sql } of statements) {
      if (SQL_AGGREGATE_PROJECTION.test(sql)) continue;
      expect(sql, `${path} reads event rows without "seq > ?"`).toMatch(
        /run_id\s*=\s*\?\s+AND\s+seq\s*>\s*\?/i,
      );
    }
    // `>=` is wrong everywhere, aggregate or not: it re-delivers the event the
    // caller's cursor already named.
    for (const source of code(nonMigrationLedgerSources)) {
      expect(source.text, `${source.path} uses >= where the contract is >`).not.toMatch(
        /\bseq\s*>=\s*\?/i,
      );
    }
  });

  it('and that per-statement scan is a real result, not an empty match', () => {
    const planted: Source[] = [
      {
        path: 'planted.ts',
        text: "const SQL = 'SELECT seq FROM event WHERE run_id = ? ORDER BY seq LIMIT ?';",
      },
    ];
    const [found] = code(planted).flatMap(eventReads);
    expect(found?.sql).not.toMatch(/run_id\s*=\s*\?\s+AND\s+seq\s*>\s*\?/i);
  });
});

suite('the README states the cursor contract (AC3)', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('says resume from strictly greater than the cursor', () => {
    expect(readme).toMatch(/strictly greater than/i);
  });

  it('says never cursor + 1', () => {
    expect(readme).toContain('cursor + 1');
  });

  it('records why gaps exist — pruning and the one global sequence', () => {
    expect(readme).toMatch(/gap/i);
    expect(readme).toMatch(/prun/i);
    expect(readme).toMatch(/sqlite_sequence/);
  });
});
