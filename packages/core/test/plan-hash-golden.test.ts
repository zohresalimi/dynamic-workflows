/**
 * KAR-02.9 — the plan-hash golden.
 *
 * This is the cross-version stability test: `sha256Hex(canonicalJson(...))`
 * over a fixture covering all seven `PlanNode` types is compared to a
 * committed golden hex string. If a refactor of the canonical encoder ever
 * changes this value, every `plan` row in every existing ledger has just
 * been orphaned — that is a migration, never a snapshot update. See
 * docs/delivery/epics/EPIC-02-domain-model.md, KAR-02.9 "Notes / risks".
 *
 * Verifies: EPIC-02-S8 (golden-hash scenario) · AC1
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { canonicalJson } from '../src/canonical-json.ts';
import { sha256Hex } from '../src/hash.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/plans/seven-types.json', import.meta.url));
const planFixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));

suite('plan hash — golden', () => {
  it('sha256Hex(canonicalJson(planFixture)) matches the committed golden', async () => {
    const hex = await sha256Hex(canonicalJson(planFixture));
    await expect(hex).toMatchFileSnapshot('__snapshots__/plan-hash.golden');
  });
});
