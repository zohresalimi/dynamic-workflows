/**
 * KAR-02.4 — the three-op patch fixture: the corpus the plan-evolution
 * scrubber (F10.2) and KAR-11.3's applier both read.
 *
 * It is pinned against the same `seven-types.json` graph the plan schema and
 * the `planHash` golden agree on, so "this patch is well-formed" is asserted
 * against a real document rather than a bespoke two-node graph.
 *
 * Verifies: EPIC-02-S13 · AC1, AC5, AC6
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { PlanGraphSchema } from '../src/plan-graph.ts';
import { PlanPatchSchema, patchIsWellFormed, retirementsOf } from '../src/plan-patch.ts';

const read = (relative: string): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));

const planFixture = read('./fixtures/plans/seven-types.json');
const patchFixture = read('./fixtures/patches/three-ops.json');

suite('PlanPatchSchema — the three-op scrubber fixture', () => {
  it('parses', () => {
    const result = PlanPatchSchema.safeParse(patchFixture);

    expect(result.success, JSON.stringify(result, null, 2)).toBe(true);
  });

  it('is well-formed against the seven-types plan', () => {
    const graph = PlanGraphSchema.parse(planFixture);
    const patch = PlanPatchSchema.parse(patchFixture);

    expect(patchIsWellFormed(patch, graph)).toEqual({ ok: true });
  });

  it('pins the ops and the policy block the scrubber renders', () => {
    const patch = PlanPatchSchema.parse(patchFixture);

    expect({
      proposedBy: patch.proposedBy,
      ops: patch.ops.map((op) =>
        op.op === 'insert-nodes'
          ? { op: op.op, nodes: op.nodes.map((node) => node.id) }
          : op.op === 'abandon-branch'
            ? { op: op.op, root: op.root }
            : { op: op.op, node: op.node },
      ),
      policy: patch.policy,
      retires: retirementsOf(patch),
    }).toMatchInlineSnapshot(`
      {
        "ops": [
          {
            "node": "recon-auth-surface",
            "op": "replace-provider",
          },
          {
            "nodes": [
              "harden-auth-tests",
            ],
            "op": "insert-nodes",
          },
          {
            "op": "abandon-branch",
            "root": "ship-it",
          },
        ],
        "policy": {
          "addsWriteCapability": true,
          "blastRadius": {
            "nodeCount": 3,
            "paths": [
              "test/auth/**",
            ],
          },
          "escalatesPermission": {
            "from": "read",
            "to": "worktree",
          },
          "estimatedCostDeltaUsd": 2.75,
          "estimatedWallClockDeltaMs": 480000,
          "replanDepth": 2,
        },
        "proposedBy": "recon-auth-surface",
        "retires": [
          {
            "lifecycle": "abandoned",
            "node": "ship-it",
          },
        ],
      }
    `);
  });
});
