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
