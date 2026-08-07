/**
 * KAR-10.3 AC5 — an edit is an RFC 6902 patch of exactly what changed, and a
 * new `specHash`.
 *
 * Unit, because every claim is about two documents and a differ: no clock, no
 * database, no process. The half that is about a transaction — `spec.amended`
 * beside `human.responded`, the pre-edit spec still readable — is
 * ../../test/integration/spec-gate.test.ts.
 *
 * Verifies: EPIC-10-S14 (first and third scenarios) · AC5
 */
import type { TaskSpecDraft } from '@DeFlow/core';
import { sealTaskSpec } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { amendSpec } from './amend.ts';

const FRAMED: TaskSpecDraft = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.framed.json', import.meta.url),
    ),
    'utf8',
  ),
) as TaskSpecDraft;

const framed = (): TaskSpecDraft => structuredClone(FRAMED);

/** S14's two edits: sharpen a criterion, add a non-goal. */
function edited(): TaskSpecDraft {
  const document = framed();
  const target = document.acceptanceCriteria[0];
  if (target === undefined) throw new Error('the fixture has no acceptance criteria');
  (target as { statement: string }).statement =
    'pnpm build exits zero and emits no new type errors.';
  return {
    ...document,
    nonGoals: [...document.nonGoals, 'changing the public API of @voyado/ui'],
  };
}

suite('amendSpec (EPIC-10-S14)', () => {
  it('carries a patch of exactly the two changes, and a different specHash', async () => {
    const before = await sealTaskSpec(framed());
    const amendment = await amendSpec(before, edited());

    // `/nonGoals/-` rather than `/nonGoals/1`: RFC 6902 §4.1 spells an append
    // that way, and the operations arrive in the differ's own order.
    expect(amendment.patch).toEqual([
      { op: 'add', path: '/nonGoals/-', value: 'changing the public API of @voyado/ui' },
      {
        op: 'replace',
        path: '/acceptanceCriteria/0/statement',
        value: 'pnpm build exits zero and emits no new type errors.',
      },
    ]);
    expect(amendment.from).toBe(before.specHash);
    expect(amendment.to).toBe(amendment.spec.specHash);
    expect(amendment.to).not.toBe(before.specHash);
  });

  it('leaves the previous spec object untouched', async () => {
    const before = Object.freeze(await sealTaskSpec(framed()));
    const amendment = await amendSpec(before, edited());
    expect(before.nonGoals).toEqual(FRAMED.nonGoals);
    expect(amendment.spec.nonGoals).toHaveLength(FRAMED.nonGoals.length + 1);
  });

  it('refuses an edit that changes nothing rather than writing a no-op amendment', async () => {
    const before = await sealTaskSpec(framed());
    await expect(amendSpec(before, framed())).rejects.toThrow(/changes nothing/);
  });

  it('refuses an edit that breaks the criteria contract, with the framing text', async () => {
    const before = await sealTaskSpec(framed());
    const broken = framed();
    const target = broken.acceptanceCriteria[0];
    if (target === undefined) throw new Error('the fixture has no acceptance criteria');
    delete (target as { verifiedBy?: unknown }).verifiedBy;

    await expect(amendSpec(before, broken)).rejects.toThrow(
      /acceptance criterion ac-1 must name at least one gate in verifiedBy/,
    );
  });
});
