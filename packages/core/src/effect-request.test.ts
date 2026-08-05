/**
 * KAR-06.3 test plan #7 — `requestHash` is stable across key reordering and
 * unaffected by an explicitly-`undefined` field (EPIC-06-S10 scenario 3).
 *
 * The hash is what stands between a `PlanPatch` landing under a journaled
 * effect and the runner returning the memoised result of the *old* operation
 * as if it were the new one, so its stability is not a nicety: an encoder that
 * hashed `{a,b}` and `{b,a}` differently would raise
 * `effect.request-hash-mismatch` on every restart, and one that ignored a
 * field would return the wrong memoised result silently. Both failures are
 * invisible until they matter.
 *
 * Verifies: EPIC-06-S10 (scenario 3) · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { type EffectRequest, requestHash } from './effect-request.ts';

const base: EffectRequest = {
  brief: 'migrate the header component to the new design tokens',
  provider: 'claude',
  model: 'claude-opus-4',
  permission: 'worktree',
  pathScopes: { write: ['src/**'], read: ['spec/**'] },
  reads: ['spec/tokens'],
  writes: ['src/components/Header.vue'],
};

suite('requestHash covers the six things a plan edit can change (AC7)', () => {
  it('is a sha256-<64 hex> string', async () => {
    await expect(requestHash(base)).resolves.toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it.each([
    ['brief', { brief: 'do something else entirely' }],
    ['provider', { provider: 'codex' }],
    ['model', { model: 'gpt-5' }],
    ['permission', { permission: 'worktree+net' }],
    ['pathScopes', { pathScopes: { write: ['**'] } }],
    ['reads', { reads: ['spec/tokens', 'finding/*'] }],
    ['writes', { writes: [] }],
  ] as const)('changes when %s changes', async (_field, patch) => {
    const before = await requestHash(base);
    const after = await requestHash({ ...base, ...patch } as EffectRequest);
    expect(after).not.toBe(before);
  });
});

suite('the hash is canonical, not incidental (EPIC-06-S10 scenario 3)', () => {
  it('is identical for two descriptors that differ only in key insertion order', async () => {
    const reordered: EffectRequest = {
      writes: base.writes,
      reads: base.reads,
      pathScopes: { read: base.pathScopes.read, write: base.pathScopes.write },
      permission: base.permission,
      model: base.model,
      provider: base.provider,
      brief: base.brief,
    };
    expect(await requestHash(reordered)).toBe(await requestHash(base));
  });

  it('hashes an explicit undefined field equal to one that omits it', async () => {
    const { model: _model, ...omitted } = base;
    const explicit = { ...omitted, model: undefined } as unknown as EffectRequest;
    expect(await requestHash(explicit)).toBe(await requestHash(omitted as EffectRequest));
  });

  it('but still distinguishes an absent model from an explicitly null one', async () => {
    const { model: _model, ...omitted } = base;
    expect(await requestHash(omitted as EffectRequest)).not.toBe(
      await requestHash({ ...base, model: null }),
    );
  });

  it('does not depend on anything outside the six fields it documents', async () => {
    const withExtra = { ...base, title: 'a title nobody hashes' } as unknown as EffectRequest;
    expect(await requestHash(withExtra)).toBe(await requestHash(base));
  });

  it('distinguishes a null provider from the string "null"', async () => {
    const nulled = await requestHash({ ...base, provider: null });
    const stringy = await requestHash({ ...base, provider: 'null' } as EffectRequest);
    expect(nulled).not.toBe(stringy);
  });
});
