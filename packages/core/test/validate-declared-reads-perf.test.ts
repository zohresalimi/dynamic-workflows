/**
 * KAR-09.1 AC7 / epic test-plan row 8: a generated 400-node `map` fan-out
 * validates in under 50 ms, so the check stays affordable on every patch.
 *
 * This lives outside packages/core/src on purpose. Measuring elapsed time
 * needs `performance.now`, and packages/core/src is linted (.oxlintrc.json)
 * to refuse that identifier in every file under it, tests included — "a
 * clock read wearing a different name" applies just as much to a test
 * asserting a budget as to production code. `validateDeclaredReads` itself
 * stays clock-free; only the *test* needs a clock, so only the test moves.
 *
 * Verifies: EPIC-09-S2 (third scenario) · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { PlanGraphSchema } from '../src/plan-graph.ts';
import { validateDeclaredReads } from '../src/validate-declared-reads.ts';

const RETURNS = { schemaId: 'DeFlow.finding.v1', maxTokens: 500 };

function agent(
  id: string,
  deps: string[],
  extra: { reads?: unknown[]; writes?: unknown[] } = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    type: 'agent',
    deps,
    lifecycle: 'active',
    reads: extra.reads ?? [],
    writes: extra.writes ?? [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: RETURNS,
    brief: `Do ${id}.`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
  };
}

suite('KAR-09.1 AC7 — a 400-node fan-out validates in under 50 ms', () => {
  it('completes well inside the budget, with an ancestor set computed once per node', () => {
    // A 20-deep spine so each fan-out child's ancestor set is non-trivial,
    // then 400 children hanging off the tail, each declaring two reads.
    // Recomputing the ancestor set per *read* instead of per *node* is the
    // trap this scenario guards: invisible at ten nodes, an O(V·E) walk at
    // four hundred — see the module note on validate-declared-reads.ts.
    const spine: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i += 1) {
      spine.push(
        agent(`spine-${i}`, i === 0 ? [] : [`spine-${i - 1}`], {
          writes: [{ kind: 'fact', key: `finding/spine-${i}`, schemaId: 'DeFlow.finding.v1' }],
        }),
      );
    }
    const children: Record<string, unknown>[] = [];
    for (let i = 0; i < 400; i += 1) {
      children.push(
        agent(`child-${i}`, ['spine-19'], {
          reads: [
            { kind: 'fact', key: 'finding/spine-0' },
            { kind: 'fact', key: `finding/never-written-${i}` },
          ],
        }),
      );
    }

    const graph = PlanGraphSchema.parse({
      schemaId: 'DeFlow.plangraph.v1',
      runId: 'run_20260802T141133Z_9f2a1c',
      version: 1,
      planHash: `sha256-${'0'.repeat(64)}`,
      parent: null,
      taskSpecHash: `sha256-${'a'.repeat(64)}`,
      createdBy: 'planner',
      createdAt: '2026-08-02T14:11:33.000Z',
      nodes: [...spine, ...children],
      edges: [],
    });

    const started = performance.now();
    const errors = validateDeclaredReads(graph);
    const elapsedMs = performance.now() - started;

    expect(errors).toHaveLength(400); // each child's second read is genuinely dangling
    expect(elapsedMs).toBeLessThan(50);
  });
});
