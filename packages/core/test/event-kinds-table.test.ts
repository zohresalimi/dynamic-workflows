/**
 * KAR-02.7 test 7 — the §9 table and the code cannot diverge.
 *
 * Forty-one payload schemas is enough that one gets added to the docs and not
 * to the registry, or renamed in the registry and not in the docs. Neither
 * failure is visible in a diff review, and both surface as an event kind the
 * reducer silently skips. So the table in docs/04-domain-model.md §9 is read
 * off disk and compared, kind for kind, against the exported registry.
 *
 * This test was written first, before a single payload schema existed, for
 * exactly the reason the epic's risk table gives.
 *
 * Verifies: KAR-02.7 test 7
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from '../../../test/support/workspace.ts';
import { EVENT_KINDS, EVENT_SCHEMAS } from '../src/event-payloads.ts';

/**
 * Every `kind` named in the first column of the §9 table. Two rows carry a
 * pair (`run.paused` / `run.resumed`, `node.lock.acquired` /
 * `node.lock.released`), so a row can contribute more than one kind — which is
 * why this reads every backticked dotted token in the cell rather than
 * assuming one per row.
 */
function documentedEventKinds(): string[] {
  const markdown = readText('docs/04-domain-model.md');
  const section = markdown.slice(
    markdown.indexOf('## 9. The Event union'),
    markdown.indexOf('### 9.1'),
  );
  expect(section).not.toBe('');

  const kinds = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    const firstCell = line.split('|')[1] ?? '';
    for (const [, token] of firstCell.matchAll(/`([a-z][a-z0-9_.]*)`/g)) {
      if (token !== undefined && token.includes('.')) kinds.add(token);
    }
  }
  return [...kinds].sort();
}

suite('the §9 event table is the registry (test 7)', () => {
  it('reads a non-trivial number of kinds out of the document', () => {
    // Guards the parser itself: a docs refactor that renames the heading would
    // otherwise turn this whole file into a vacuous pass.
    expect(documentedEventKinds().length).toBeGreaterThanOrEqual(40);
  });

  it('every documented kind has a schema, and every schema is documented', () => {
    expect([...EVENT_KINDS].sort()).toEqual(documentedEventKinds());
  });

  it('every registered kind carries a current version of at least 1', () => {
    for (const kind of EVENT_KINDS) {
      const spec = EVENT_SCHEMAS[kind];
      expect(Number.isInteger(spec.v), `${kind}.v must be an integer`).toBe(true);
      expect(spec.v, `${kind}.v must be >= 1`).toBeGreaterThanOrEqual(1);
    }
  });
});
