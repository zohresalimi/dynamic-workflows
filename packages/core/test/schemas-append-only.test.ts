/**
 * KAR-02.8 — `schemaId` versioning is append-only.
 *
 * `pnpm schemas:check` proves the files match the Zod source. It says nothing
 * about whether the *shape* was allowed to change, and that is the failure
 * with teeth: a `.v1` edited in place silently reinterprets every document
 * already written by an older daemon, in a run directory nobody will re-read
 * until something breaks. So each shipped file's content hash is pinned here,
 * one row per id.
 *
 * **A red row is not a licence to update the hash.** The fix is a new
 * `.v2` — a new registry entry, a new file, the old one untouched — and an
 * entry in `schemas/CHANGELOG.md` saying why. Editing the number below is
 * correct in exactly one case: the id is new, and this is the commit that
 * ships it.
 *
 * Verifies: EPIC-02-S24 (last scenario) · AC6 · test plan #7
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { REGISTERED_SCHEMA_IDS } from '../src/json-schema.ts';

const schemasDir = new URL('../../../schemas/', import.meta.url).pathname;

/** sha256 of the file's bytes, hex. */
const hashOf = (schemaId: string): string =>
  createHash('sha256')
    .update(readFileSync(join(schemasDir, `${schemaId}.json`)))
    .digest('hex');

/** schemaId -> sha256 of the committed file. Append rows; never edit one. */
const SHIPPED: Record<string, string> = {
  // Shipped 2026-08-05, KAR-02.8.
  'DeFlow.contextpacket.v1': 'fb54a712f512db16243382fc82c826e5626b00ba0ba48c9076ddfbdabce9060d',
  'DeFlow.fact.v1': '2cc3d15cc2017ce689bf461d63de269f15db6c7673e5f917434153be5d6a833d',
  'DeFlow.finding.v1': 'd30968a40695f687e1c2873022924f9989056d560f43da4ea2690747cfbe4abe',
  'DeFlow.plangraph.v1': '95d378c35d62a39a716912f510601b439f7b55b22ab72fc22e6dba72fcd5b827',
  'DeFlow.planpatch.v1': '7552c451fdaa297ff8b18cecc17b139fb15b3f3f1e3768c35c6cda716d144779',
  'DeFlow.taskspec.v1': '4a3543cd4abd3bd3360f4751321af3e662d30a1eb228308ac8c4c24849dae8a8',
  // Shipped 2026-08-07, KAR-10.2 — the framing interview's return contract.
  'DeFlow.taskspecdraft.v1': 'dc33cef5a3dd88eedaa7a285cbb9cb5810f4b16cb0fadc13ed12e90d2f61d4ea',
  'DeFlow.verdict.v1': 'c089c51606833975418c288e8be97bf3839e8fc4582adce448c7b69394e8843d',
};

suite('the committed schemas are append-only (AC6)', () => {
  it('pins a content hash for every registered schemaId', () => {
    expect(Object.keys(SHIPPED).sort()).toEqual([...REGISTERED_SCHEMA_IDS].sort());
  });

  for (const [schemaId, expected] of Object.entries(SHIPPED)) {
    it(`${schemaId}.json is unchanged since it shipped`, () => {
      expect(
        hashOf(schemaId),
        `${schemaId}.json changed content. schemaId versioning is append-only: publish ` +
          `${schemaId.replace(/\.v(\d+)$/, (_, v) => `.v${Number(v) + 1}`)} and leave this file ` +
          'alone (schemas/CHANGELOG.md).',
      ).toBe(expected);
    });
  }

  it('every .json in schemas/ is a registered id, so nothing ships unpinned', () => {
    const files = readdirSync(schemasDir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual([...REGISTERED_SCHEMA_IDS].sort());
  });
});
