/**
 * KAR-14.4 AC7 — the proposal event: the patch, and the cause the scheduler
 * proposed it for.
 *
 * `plan.patch.proposed` gains one optional field. It goes there rather than
 * inside the `PlanPatch` document because `DeFlow.planpatch.v1` is a shipped,
 * content-pinned schema (`packages/core/test/schemas-append-only.test.ts` holds
 * its hash) — a field on the document is a `.v2` and belongs to EPIC-11's patch
 * application. The cause is a fact about the *proposal* in any case: the same
 * patch is a different decision depending on why somebody asked for it.
 *
 * Verifies: EPIC-14-S24 · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from '../../../test/support/workspace.ts';
import { EVENT_SCHEMAS } from '../src/event-payloads.ts';
import type { EventSeq, NodeId, ProviderId, RunId } from '../src/ids.ts';
import type { NodeFailure } from '../src/node-failure.ts';
import { PATCH_CAUSES } from '../src/plan-patch.ts';
import { QUOTA_CAUSE } from '../src/rate-limit.ts';
import { reroutePatch } from '../src/retry.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c' as RunId;
const NODE = 'impl-1' as NodeId;
const CODEX = 'codex' as ProviderId;

const limited: NodeFailure = {
  reason: 'provider.rate-limited',
  class: 'transient',
  message: 'claude: rate limited, reset time unknown',
  evidence: [],
  occurredAtEvent: 12 as EventSeq,
  attempt: 0,
};

const patch = reroutePatch({
  runId: RUN_ID,
  node: NODE,
  provider: CODEX,
  nextAttempt: 1,
  failure: limited,
  cause: QUOTA_CAUSE,
});

const parse = (payload: unknown) => EVENT_SCHEMAS['plan.patch.proposed'].payload.safeParse(payload);

suite('AC7 — the cause is a closed vocabulary, carried on the proposal', () => {
  it('is one value today, and a set so the next one cannot widen an existing rule', () => {
    expect(PATCH_CAUSES).toEqual(['quota']);
    expect(QUOTA_CAUSE).toBe('quota');
  });

  it('accepts a proposal that names its cause', () => {
    const result = parse({ patch, cause: QUOTA_CAUSE });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ cause: 'quota' });
  });

  it('still accepts a proposal with no cause — a planner-proposed patch has none', () => {
    expect(parse({ patch }).success).toBe(true);
  });

  it('refuses a cause outside the set, rather than storing an unrenderable word', () => {
    expect(parse({ patch, cause: 'because' }).success).toBe(false);
  });

  it('is v2, and the bump is recorded', () => {
    expect(EVENT_SCHEMAS['plan.patch.proposed'].v).toBe(2);
    expect(readText('schemas/CHANGELOG.md')).toContain('plan.patch.proposed v2');
  });
});

suite('AC7 — a v1 proposal still reads, and does not gain a cause it never had', () => {
  it('upcasts by leaving the field absent', async () => {
    const { upcast } = await import('../src/upcasters.ts');
    const v1 = { patch };
    const upcasted = upcast('plan.patch.proposed', 1, v1) as Record<string, unknown>;

    expect(parse(upcasted).success).toBe(true);
    // Absent, not `'quota'`: a payload written before the reactive rate-limit
    // path existed cannot have been proposed because of a quota, and filling
    // it in would make every historical planner patch read as a vendor swap.
    expect(upcasted.cause).toBeUndefined();
  });
});
