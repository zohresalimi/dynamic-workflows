/**
 * KAR-02.7 AC8 — the versioning rule is written down, and the write-down is
 * checked.
 *
 * "If an upcaster cannot be written (a genuinely lossy schema change), that is
 * a new `kind`, not a new `v`" is a judgement no test can make. What a test
 * can do is refuse to let a version bump ship without a stated reason, and
 * refuse the mechanical form of the mistake (see
 * `checkUpcastersPreserveRequiredFields` in ../src/upcasters.ts).
 *
 * Verifies: EPIC-02-S22 · AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { exists, readText } from '../../../test/support/workspace.ts';
import { EVENT_KINDS, EVENT_SCHEMAS } from '../src/event-payloads.ts';

const CHANGELOG = 'schemas/CHANGELOG.md';

suite('schemas/CHANGELOG.md states the rule (AC8)', () => {
  it('exists', () => {
    expect(exists(CHANGELOG)).toBe(true);
  });

  it('states that a lossy change is a new kind, not a new v', () => {
    const text = readText(CHANGELOG).toLowerCase();

    expect(text).toContain('lossy');
    expect(text).toContain('new `kind`');
    expect(text).toContain('not a new `v`');
  });

  it('records an entry for every kind that has moved past v1', () => {
    // Vacuous today — the ledger has no history and every kind is at v1 — and
    // that is precisely why it is written now: the first `v: 2` in
    // ../src/event-payloads.ts fails here until its reason is recorded.
    const text = readText(CHANGELOG);
    const bumped = EVENT_KINDS.filter((kind) => EVENT_SCHEMAS[kind].v > 1);

    for (const kind of bumped) {
      for (let version = 2; version <= EVENT_SCHEMAS[kind].v; version += 1) {
        expect(text, `${CHANGELOG} has no entry for ${kind} v${version}`).toContain(
          `${kind} v${version}`,
        );
      }
    }
  });

  it('names the two mechanisms a reader has to know about', () => {
    const text = readText(CHANGELOG);

    expect(text).toContain('assertUpcasterChainsComplete');
    expect(text).toContain('registerUpcaster');
  });
});
