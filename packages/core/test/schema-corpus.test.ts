/**
 * KAR-02.8 — the conformance corpus is checked against the Zod source, not
 * only against the emitted JSON Schema.
 *
 * `packages/daemon/src/schema-store.test.ts` runs every fixture through Ajv.
 * That proves the *emitted* document behaves, and it would keep passing if a
 * fixture drifted away from what the domain actually accepts — an emitted
 * schema is necessarily weaker than its Zod source, because Zod's cross-field
 * refinements (kind vs key prefix, pinned implies not compactable,
 * `pinnedDigests` matching the pinned segments) have no JSON Schema
 * expression. Holding the same files to both keeps the corpus honest and
 * documents exactly where the two disagree.
 *
 * Verifies: EPIC-02-S25 · AC1
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import type { z } from 'zod';
import { ContextPacketSchema } from '../src/context-packet.ts';
import { FactSchema } from '../src/fact.ts';
import { TaskSpecDraftSchema } from '../src/framing.ts';
import { REGISTERED_SCHEMA_IDS } from '../src/json-schema.ts';
import { PlanGraphSchema } from '../src/plan-graph.ts';
import { PlanPatchSchema } from '../src/plan-patch.ts';
import { ReconFactValueSchema, ReconSurveySchema } from '../src/recon.ts';
import { TaskSpecSchema } from '../src/task-spec.ts';
import { FindingSchema, VerdictSchema, VerdictV2Schema } from '../src/verdict.ts';

const repoRoot = new URL('../../../', import.meta.url).pathname;
const corpus = join(repoRoot, 'fixtures/schemas');

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const CONFORMING: Record<string, string> = {
  'DeFlow.contextpacket.v1': join(corpus, 'DeFlow.contextpacket.v1.valid.json'),
  'DeFlow.fact.v1': join(corpus, 'DeFlow.fact.v1.valid.json'),
  'DeFlow.finding.v1': join(corpus, 'DeFlow.finding.v1.valid.json'),
  'DeFlow.plangraph.v1': join(repoRoot, 'packages/core/test/fixtures/plans/seven-types.json'),
  'DeFlow.planpatch.v1': join(repoRoot, 'packages/core/test/fixtures/patches/three-ops.json'),
  'DeFlow.reconfact.v1': join(corpus, 'DeFlow.reconfact.v1.valid.json'),
  'DeFlow.reconsurvey.v1': join(corpus, 'DeFlow.reconsurvey.v1.valid.json'),
  'DeFlow.taskspec.v1': join(repoRoot, 'packages/core/test/fixtures/specs/vue3-migration.json'),
  'DeFlow.taskspecdraft.v1': join(
    repoRoot,
    'packages/core/test/fixtures/specs/vue3-migration.framed.json',
  ),
  'DeFlow.verdict.v1': join(corpus, 'DeFlow.verdict.v1.valid.json'),
  'DeFlow.verdict.v2': join(corpus, 'DeFlow.verdict.v2.valid.json'),
};

const ZOD: Record<string, z.ZodType> = {
  'DeFlow.contextpacket.v1': ContextPacketSchema,
  'DeFlow.fact.v1': FactSchema,
  'DeFlow.finding.v1': FindingSchema,
  'DeFlow.plangraph.v1': PlanGraphSchema,
  'DeFlow.planpatch.v1': PlanPatchSchema,
  'DeFlow.reconfact.v1': ReconFactValueSchema,
  'DeFlow.reconsurvey.v1': ReconSurveySchema,
  'DeFlow.taskspec.v1': TaskSpecSchema,
  'DeFlow.taskspecdraft.v1': TaskSpecDraftSchema,
  'DeFlow.verdict.v1': VerdictSchema,
  'DeFlow.verdict.v2': VerdictV2Schema,
};

suite('the conformance corpus agrees with the Zod source', () => {
  it('covers every registered schemaId', () => {
    expect(Object.keys(CONFORMING).sort()).toEqual([...REGISTERED_SCHEMA_IDS].sort());
    expect(Object.keys(ZOD).sort()).toEqual([...REGISTERED_SCHEMA_IDS].sort());
  });

  for (const schemaId of Object.keys(ZOD)) {
    it(`${schemaId}: the conforming fixture parses under Zod`, () => {
      const schema = ZOD[schemaId] as z.ZodType;
      const result = schema.safeParse(readJson(CONFORMING[schemaId] as string));
      expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
    });

    it(`${schemaId}: the counter-fixture is rejected by Zod too`, () => {
      const schema = ZOD[schemaId] as z.ZodType;
      expect(schema.safeParse(readJson(join(corpus, `${schemaId}.counter.json`))).success).toBe(
        false,
      );
    });
  }
});
