/**
 * KAR-03.2 — shipped migrations are append-only.
 *
 * "Never edited once shipped" (docs/05-durable-execution.md §7.2) is a rule
 * nothing else in the tree enforces: `up()` runs against whatever bytes are on
 * disk today, and an edited migration silently reinterprets every ledger a
 * prior build already applied it to. So each shipped file's content hash is
 * pinned here, one row per migration.
 *
 * **A red row is not a licence to update the hash.** Migrations are
 * append-only: fix forward with a new numbered file, and leave this one
 * alone.
 *
 * Verifies: KAR-03.2 test plan #7 · AC7
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const migrationsDir = new URL('../src/migrations/', import.meta.url).pathname;

const hashOf = (filename: string): string =>
  createHash('sha256')
    .update(readFileSync(join(migrationsDir, filename)))
    .digest('hex');

/** Filename -> sha256 of the committed file. Append rows; never edit one. */
const SHIPPED: Record<string, string> = {
  // Shipped 2026-08-05, KAR-03.2.
  '0001-initial-schema.ts': 'ce9aa2b46a0614760259a9c9f5e14758a4249fc67dbafa0676072afd71650529',
  // Shipped 2026-08-05, KAR-03.3 — event.epoch.
  '0002-event-epoch.ts': '60c4b67cd912c12f807fb1175a381036b03492b562bc5e49d8b995fe17f5c548',
  // Shipped 2026-08-05, KAR-03.7 — the daemon epoch counter.
  '0003-daemon-epoch.ts': '583b917b806f13161f5c1d16188dd1d9fbdb5615193920772f45c51489954f87',
  // Shipped 2026-08-05, KAR-05.2 — the probed capability manifest.
  '0004-provider-capabilities.ts':
    '2efbb532aee1382ceaee7bc0bc15ab67af6be5c5211f2012b83719e44539f575',
};

const shippedMigrationFiles = readdirSync(migrationsDir).filter(
  (name) => name !== 'index.ts' && name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

suite('shipped migration files are unchanged (AC7)', () => {
  it('pins a content hash for every shipped migration file', () => {
    expect(shippedMigrationFiles.sort()).toEqual(Object.keys(SHIPPED).sort());
  });

  for (const [filename, expected] of Object.entries(SHIPPED)) {
    it(`${filename} is unchanged since it shipped`, () => {
      expect(
        hashOf(filename),
        `${filename} changed content. Migrations are append-only: ship a new numbered file ` +
          'instead of editing this one.',
      ).toBe(expected);
    });
  }
});
