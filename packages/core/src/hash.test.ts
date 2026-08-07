/**
 * KAR-02.9 — sha256Hex and the planHash/specHash/contentHash wrappers.
 *
 * Verifies: EPIC-02-S6 (identity-under-approval half), EPIC-02-S8 · AC1, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { contentHash, planHash, sha256Hex, specHash } from './hash.ts';

suite('sha256Hex', () => {
  it('matches the well-known SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the well-known SHA-256 of the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is deterministic: the same input always hashes the same', async () => {
    const inputs = ['hello world', '{"a":1}', 'café'];
    for (const input of inputs) {
      expect(await sha256Hex(input)).toBe(await sha256Hex(input));
    }
  });
});

suite('planHash — excludes planHash itself (AC7)', () => {
  it('is unchanged when the planHash field itself changes', async () => {
    const withoutHash = { schemaId: 'DeFlow.plangraph.v1', version: 1, nodes: [] };
    const first = await planHash({ ...withoutHash, planHash: 'sha256-aaaa' });
    const second = await planHash({ ...withoutHash, planHash: 'sha256-bbbb' });
    expect(first).toBe(second);
  });

  it('changes when any other field changes', async () => {
    const first = await planHash({ schemaId: 'DeFlow.plangraph.v1', version: 1 });
    const second = await planHash({ schemaId: 'DeFlow.plangraph.v1', version: 2 });
    expect(first).not.toBe(second);
  });

  it('produces a value matching the PlanHash format, sha256-<64 hex>', async () => {
    const hash = await planHash({ schemaId: 'DeFlow.plangraph.v1' });
    expect(hash).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('is key-order invariant, because it hashes through canonicalJson', async () => {
    const first = await planHash({ a: 1, b: 2 });
    const second = await planHash({ b: 2, a: 1 });
    expect(first).toBe(second);
  });
});

suite('specHash — excludes approvedBy (AC7)', () => {
  /**
   * KAR-09.4 AC8. A gate resolves its criteria from the ledger *by specHash*,
   * which is only possible if recomputing the digest of a spec that already
   * carries one reproduces it — exactly as `planHash` omits `planHash`. The
   * schema in ./task-spec.ts has always said "over everything except this field
   * and approvedBy"; before this the field itself was hashed, so no document on
   * record could be verified against its own digest.
   */
  it('is unchanged by the specHash field it computes, so a spec verifies against itself', async () => {
    const spec = { schemaId: 'DeFlow.taskspec.v1', goal: 'ship the thing', approvedBy: null };
    const identity = await specHash(spec);

    expect(await specHash({ ...spec, specHash: identity })).toBe(identity);
  });

  it('is unchanged when approvedBy changes from null to an approval record', async () => {
    const base = { schemaId: 'DeFlow.taskspec.v1', goal: 'ship the thing' };
    const before = await specHash({ ...base, approvedBy: null });
    const after = await specHash({
      ...base,
      approvedBy: { at: '2026-08-02T15:00:00Z', via: 'ui' },
    });
    expect(before).toBe(after);
  });

  it('changes when goal changes by one character', async () => {
    const before = await specHash({ goal: 'ship the thing', approvedBy: null });
    const after = await specHash({ goal: 'ship the thingy', approvedBy: null });
    expect(before).not.toBe(after);
  });

  it('is unchanged by a JSON.parse(JSON.stringify(...)) round trip with shuffled keys', async () => {
    const spec = {
      schemaId: 'DeFlow.taskspec.v1',
      goal: 'ship the thing',
      nonGoals: ['rewrite the world'],
      approvedBy: { at: '2026-08-02T15:00:00Z', via: 'ui' },
    };
    const roundTripped = JSON.parse(JSON.stringify(spec)) as typeof spec;
    const shuffled = {
      approvedBy: roundTripped.approvedBy,
      goal: roundTripped.goal,
      nonGoals: roundTripped.nonGoals,
      schemaId: roundTripped.schemaId,
    };
    expect(await specHash(shuffled)).toBe(await specHash(spec));
  });
});

suite('contentHash', () => {
  it('hashes the given text directly, not as JSON', async () => {
    const hash = await contentHash('the pinned segment text, verbatim');
    expect(hash).toBe(`sha256-${await sha256Hex('the pinned segment text, verbatim')}`);
  });

  it('changes when a single character of the text changes', async () => {
    const before = await contentHash('constraint A');
    const after = await contentHash('constraint B');
    expect(before).not.toBe(after);
  });
});
