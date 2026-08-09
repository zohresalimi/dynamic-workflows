/**
 * KAR-11.3 AC6 — the proposal records the graph it was derived against.
 *
 * `basePlanHash` goes on `plan.patch.proposed` rather than inside the
 * `PlanPatch` document, for the reason KAR-14.4 put `cause` there:
 * `DeFlow.planpatch.v1` is a shipped, content-pinned schema
 * (`packages/core/test/schemas-append-only.test.ts` holds its hash), and a field
 * on the document is a `.v2` every run directory on disk would then be reading
 * with the wrong shape. It is also a fact about the *proposal* rather than
 * about the ops: the same three ops derived against v3 and against v7 are the
 * same patch and a different proposal, and which of the two it is decides
 * whether it applies at all.
 *
 * Optional on the payload, required by the tool boundary that mints one, so a
 * proposal written before this field existed still reads back as itself — there
 * is no honest hash to invent for it, and inventing one would make a historical
 * proposal look like it had passed a concurrency check nobody ran.
 *
 * Verifies: EPIC-11-S16 (first scenario) · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from '../../../test/support/workspace.ts';
import { EVENT_SCHEMAS } from '../src/event-payloads.ts';
import { PlanPatchSchema } from '../src/plan-patch.ts';

const BASE = `sha256-${'3'.repeat(64)}`;

const patch = PlanPatchSchema.parse({
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-3a91f0',
  proposedBy: 'recon-auth-surface',
  reason: 'recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API',
  ops: [{ op: 'extend-loop', node: 'fix-lint', maxRounds: 8 }],
  policy: {
    estimatedCostDeltaUsd: 0.4,
    estimatedWallClockDeltaMs: 120_000,
    blastRadius: { paths: [], nodeCount: 3 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
});

const parse = (payload: unknown) => EVENT_SCHEMAS['plan.patch.proposed'].payload.safeParse(payload);

suite('AC6 — the base a proposal was derived against is on the record', () => {
  it('accepts a proposal that names its base', () => {
    const result = parse({ patch, basePlanHash: BASE });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ basePlanHash: BASE });
  });

  it('refuses a base that is not a plan hash, rather than storing an unjoinable string', () => {
    expect(parse({ patch, basePlanHash: 'v3' }).success).toBe(false);
  });

  it('still accepts a proposal with no base', () => {
    expect(parse({ patch }).success).toBe(true);
  });

  it('is v3, and the bump is recorded', () => {
    expect(EVENT_SCHEMAS['plan.patch.proposed'].v).toBe(3);
    expect(readText('schemas/CHANGELOG.md')).toContain('plan.patch.proposed v3');
  });
});

suite('AC6 — a v2 proposal still reads, and gains no base it never had', () => {
  it('upcasts by leaving the field absent', async () => {
    const { upcast } = await import('../src/upcasters.ts');
    const upcasted = upcast('plan.patch.proposed', 2, { patch, cause: 'quota' }) as Record<
      string,
      unknown
    >;

    expect(parse(upcasted).success).toBe(true);
    // Absent, not the run's current hash: stamping that on a historical
    // proposal would make it read as having been derived against a graph it
    // could not have seen — and `basePlanHash` exists precisely to answer that
    // question.
    expect(upcasted.basePlanHash).toBeUndefined();
    expect(upcasted.cause).toBe('quota');
  });

  it('carries a v1 payload the whole way, one hop at a time', async () => {
    const { upcast } = await import('../src/upcasters.ts');
    const upcasted = upcast('plan.patch.proposed', 1, { patch }) as Record<string, unknown>;

    expect(parse(upcasted).success).toBe(true);
    expect(upcasted.basePlanHash).toBeUndefined();
  });
});
