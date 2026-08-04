/**
 * KAR-03.2 — the README states the no-`down` rule and the two-layer
 * downgrade story, and nothing under `src/migrations` exports a `down`.
 *
 * Verifies: EPIC-03-S6 (scenario 3), EPIC-03-S7 (scenario 2) · AC6
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const migrationsDir = new URL('../src/migrations/', import.meta.url).pathname;

suite('packages/ledger/README.md documents no-down recovery', () => {
  it('states that recovery is roll forward or restore the pre-migration backup', () => {
    expect(readme).toMatch(/roll forward/i);
    expect(readme).toMatch(/restore the pre-migration backup|restore.*pre-migrate/i);
  });

  it('states there is no down migration', () => {
    expect(readme).toMatch(/no `down` migration/i);
  });

  it('states both downgrade-safety rules together: the reducer and LedgerTooNew', () => {
    expect(readme).toMatch(/reducer's tolerance/i);
    expect(readme).toContain('LedgerTooNew');
  });
});

suite('no migration file exports a down (EPIC-03-S6 scenario 3)', () => {
  it('has zero matches for an exported "down"', () => {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(migrationsDir, file), 'utf8');
      expect(text).not.toMatch(/\bdown\b/i);
    }
  });
});
