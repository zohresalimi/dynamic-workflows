/**
 * KAR-03.1 — the README says what `synchronous = NORMAL` does *not* buy.
 *
 * This is a test rather than a review note because the failure mode is silence:
 * a document that never mentions power loss reads exactly like one that
 * promises invulnerability, and the epic's Definition of Done asks for the
 * sentence explicitly.
 *
 * Verifies: EPIC-03-S25 (scenario 2) · AC8
 */
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

suite('packages/ledger/README.md is honest about durability', () => {
  it('states that NORMAL does not fsync the WAL on every commit', () => {
    expect(readme).toMatch(/does not fsync the WAL on every commit/i);
  });

  it('names what can be lost — a kernel panic or a power cut, not a process crash', () => {
    expect(readme).toMatch(/kernel panic/i);
    expect(readme).toMatch(/power cut/i);
    expect(readme).toMatch(/process crash/i);
  });

  it('records the measured price of the alternative', () => {
    expect(readme).toContain('979');
    expect(readme).toContain('22,982');
  });

  it('says NORMAL is the right trade for a laptop daemon', () => {
    expect(readme).toMatch(/laptop daemon/i);
  });

  it('names the one case that switches to FULL, and how to ask for it', () => {
    expect(readme).toContain('withFullSync');
    expect(readme).toMatch(/irreversible/i);
  });

  it('states the ":memory:" rule before the first durability test relies on it', () => {
    expect(readme).toMatch(/pure projection/i);
    expect(readme).toContain('*.projection.test.ts');
  });
});

/**
 * KAR-03.4 / EPIC-03-S13 scenario 3: the reason unbounded reads are banned has
 * to be written down, because "add a LIMIT" reads like fussiness until someone
 * knows that the driver is synchronous and the cost lands on every other
 * request in the process.
 *
 * Verifies: EPIC-03-S13 (scenario 3), EPIC-03-S14 · AC5
 */
suite('packages/ledger/README.md explains why reads are bounded', () => {
  it('says better-sqlite3 is synchronous and what that costs the rest of the daemon', () => {
    expect(readme).toMatch(/synchronous/i);
    expect(readme).toMatch(/SSE/);
    expect(readme).toMatch(/stalls?/i);
  });

  it('records the held-cursor WAL failure and the bounded drain that replaces it', () => {
    expect(readme).toMatch(/iterate\(\)/);
    expect(readme).toMatch(/-wal/);
    expect(readme).toMatch(/wal_checkpoint\(TRUNCATE\)/);
  });
});

/**
 * KAR-03.5 / EPIC-03-S7 scenario 2: the two downgrade mechanisms are stated
 * *together*, because on their own each one reads like an inconsistency —
 * "the ledger tolerates a newer daemon" and "the ledger refuses a newer
 * daemon" are both true, of different layers, and a reader who meets only one
 * of them will assume the other is a bug.
 *
 * Verifies: EPIC-03-S7 (scenario 2)
 */
suite('packages/ledger/README.md states both downgrade rules as a pair', () => {
  const section = readme.slice(readme.indexOf('Downgrade safety is two mechanisms'));

  it('has a section that introduces them as two mechanisms covering different layers', () => {
    expect(readme).toMatch(/Downgrade safety is two mechanisms, not one/);
  });

  it('names the reducer’s unknown-kind tolerance as the event-payload half', () => {
    expect(section).toMatch(/unknown `kind`/);
    expect(section).toMatch(/KAR-03\.5/);
  });

  it('names LedgerTooNew as the schema half, and points at the backups', () => {
    expect(section).toContain('LedgerTooNew');
    expect(section).toContain('pre-migrate-*.db');
  });

  it('says why there is no equivalent tolerance at the schema layer', () => {
    expect(section).toMatch(/constraint it does not know exists/);
  });
});
