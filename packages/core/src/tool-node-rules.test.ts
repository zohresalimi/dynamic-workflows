/**
 * KAR-23.13 — the three static refusals of a `tool` node, as one pure rule set.
 *
 * These are the refusals `packages/daemon/src/pipeline/tool-node.ts` has always
 * thrown at execution and that `validate-plan.ts` now files as repairable
 * diagnostics. What is proved here is that they are *the same three*, derived
 * once: the permission level, the tool kind, and the F5.6 deny list applied to
 * a run line that is plain plan content.
 *
 * Verifies: KAR-23.13
 */
import { expect, it, describe as suite } from 'vitest';
import type { ToolNode } from './plan-graph.ts';
import {
  PLAN_TIME_COMMAND_CONTEXT_ROOT,
  type ToolNodeUnderRule,
  toolNodeRefusals,
} from './tool-node-rules.ts';

/** What this daemon composes a performer for today. Passed in everywhere, so
 * the tests never assume the constant. */
const PERFORMABLE = ['script'] as const;

const node = (
  tool: ToolNode['tool'],
  overrides: Partial<ToolNodeUnderRule> = {},
): ToolNodeUnderRule => ({
  id: 'branch-setup',
  permission: 'worktree',
  tool,
  ...overrides,
});

const script = (run: string, cwd?: string): ToolNode['tool'] =>
  cwd === undefined ? { kind: 'script', run } : { kind: 'script', run, cwd };

suite('permission — full is refused on a tool node, and nothing else is', () => {
  it("refuses 'full' with the diagnostic code and the run-time reason both", () => {
    const refusals = toolNodeRefusals(
      node(script('git checkout -b feature'), { permission: 'full' }),
      PERFORMABLE,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.rule).toBe('permission-full');
    expect(refusals[0]?.code).toBe('TOOL_PERMISSION_UNSCHEDULABLE');
    expect(refusals[0]?.reason).toBe('safety.permission-unschedulable');
    expect(refusals[0]?.key).toBe('full');
    expect(refusals[0]?.detail).toMatchObject({ node: 'branch-setup', permission: 'full' });
  });

  it("carries the sentence the performer's own refusal carries", () => {
    // The 2026-08-24 incident's own words, and the string
    // `daemon/test/integration/tool-node.test.ts` greps the run-time failure
    // for. One spelling, two readers.
    const [refusal] = toolNodeRefusals(
      node(script('echo hi'), { permission: 'full' }),
      PERFORMABLE,
    );
    expect(refusal?.message).toContain('full is not a sandbox');
    expect(refusal?.message).toContain("'worktree'");
  });

  it('admits every level DeFlow can actually enforce', () => {
    for (const permission of ['read', 'worktree', 'worktree+net'] as const) {
      expect(toolNodeRefusals(node(script('pnpm install'), { permission }), PERFORMABLE)).toEqual(
        [],
      );
    }
  });
});

suite('kind — only what this daemon composes a performer for', () => {
  it('refuses an http node', () => {
    const refusals = toolNodeRefusals(
      node({ kind: 'http', method: 'POST', url: 'https://example.test/x' }, { id: 'call-api' }),
      PERFORMABLE,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.rule).toBe('kind-unperformable');
    expect(refusals[0]?.code).toBe('TOOL_KIND_UNPERFORMABLE');
    expect(refusals[0]?.reason).toBe('adapter.capability-missing');
    expect(refusals[0]?.key).toBe('http');
    expect(refusals[0]?.message).toBe(
      "tool node 'call-api' is of kind 'http', and this daemon can run tool nodes of kind " +
        'script only. Express the call as a script node, or drop it.',
    );
  });

  it('refuses an mcp node', () => {
    const refusals = toolNodeRefusals(
      node({ kind: 'mcp', server: 'linear', tool: 'create_issue', args: {} }),
      PERFORMABLE,
    );
    expect(refusals.map((refusal) => refusal.rule)).toEqual(['kind-unperformable']);
  });

  it('admits a script node', () => {
    expect(toolNodeRefusals(node(script('pnpm install')), PERFORMABLE)).toEqual([]);
  });

  it('reads the performable set it is given rather than a list of its own', () => {
    // The daemon is the only thing that knows what it composed. Widen the set
    // and the same node stops being refused, with no edit here or in core.
    expect(
      toolNodeRefusals(node({ kind: 'http', method: 'GET', url: 'https://example.test/x' }), [
        'script',
        'http',
      ]),
    ).toEqual([]);
  });
});

suite('the F5.6 deny list, applied to plan content', () => {
  it('refuses an infrastructure action in a run line', () => {
    const refusals = toolNodeRefusals(
      node(script('terraform apply -auto-approve'), { id: 'deploy' }),
      PERFORMABLE,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.rule).toBe('destructive-run-line');
    expect(refusals[0]?.code).toBe('TOOL_COMMAND_REFUSED');
    expect(refusals[0]?.reason).toBe('safety.execution-boundary');
    expect(refusals[0]?.key).toBe('terraform-apply');
    expect(refusals[0]?.detail).toMatchObject({ node: 'deploy', rule: 'terraform-apply' });
    expect(refusals[0]?.message).toContain('terraform apply -auto-approve');
  });

  it('refuses a force push, which the sandbox cannot tell from a fetch', () => {
    const [refusal] = toolNodeRefusals(node(script('git push --force origin main')), PERFORMABLE);
    expect(refusal?.key).toBe('git-push-force');
  });

  it('admits the everyday build verbs a plan is made of', () => {
    for (const run of [
      'git checkout -b feature',
      'pnpm install',
      'pnpm vitest run --project unit',
      'rm -rf ./build',
      'git add -A && git commit -m wip',
    ]) {
      expect(toolNodeRefusals(node(script(run)), PERFORMABLE), run).toEqual([]);
    }
  });

  it('judges path arguments against the synthetic root, so an escape is refused', () => {
    // No worktree exists at plan time. The rules judge the line against
    // `PLAN_TIME_COMMAND_CONTEXT_ROOT`, which every *relative* argument
    // resolves against identically to the real one.
    expect(PLAN_TIME_COMMAND_CONTEXT_ROOT.startsWith('/')).toBe(true);
    const [refusal] = toolNodeRefusals(node(script('rm -rf ../..')), PERFORMABLE);
    expect(refusal?.rule).toBe('destructive-run-line');
  });

  it('resolves tool.cwd against the synthetic root the way perform() resolves it', () => {
    // `cwd: 'packages/web'` puts the command two levels down, so `rm -rf ../..`
    // from there lands exactly on the worktree root rather than outside it —
    // the same arithmetic the performer does against the provisioned path.
    const deep = toolNodeRefusals(node(script('rm -rf ../../..', 'packages/web')), PERFORMABLE);
    expect(deep.map((refusal) => refusal.rule)).toEqual(['destructive-run-line']);
    expect(toolNodeRefusals(node(script('rm -rf ./dist', 'packages/web')), PERFORMABLE)).toEqual(
      [],
    );
  });

  it('never judges a kind that has no run line', () => {
    expect(
      toolNodeRefusals(
        node({ kind: 'http', method: 'POST', url: 'https://example.test' }),
        PERFORMABLE,
      ).map((refusal) => refusal.rule),
    ).toEqual(['kind-unperformable']);
  });
});

suite('every refusal, not the first', () => {
  it('reports both faults of a node that is full and destructive, permission first', () => {
    // §3.5 allows the planner exactly one retry, so a plan with two faults in
    // one node must not cost two turns. `[0]` is still the one `perform()`
    // would have thrown, which is what makes the run-time backstop a
    // projection of this list rather than a second opinion.
    const refusals = toolNodeRefusals(
      node(script('terraform apply -auto-approve'), { permission: 'full', id: 'deploy' }),
      PERFORMABLE,
    );
    expect(refusals.map((refusal) => refusal.rule)).toEqual([
      'permission-full',
      'destructive-run-line',
    ]);
  });

  it('reports a full http node as both, in perform() order', () => {
    const refusals = toolNodeRefusals(
      node({ kind: 'http', method: 'GET', url: 'https://example.test' }, { permission: 'full' }),
      PERFORMABLE,
    );
    expect(refusals.map((refusal) => refusal.rule)).toEqual([
      'permission-full',
      'kind-unperformable',
    ]);
  });
});

suite('purity', () => {
  it('is total over every kind and level, and answers the same way twice', () => {
    const subject = node(script('terraform destroy'), { permission: 'full' });
    expect(toolNodeRefusals(subject, PERFORMABLE)).toEqual(toolNodeRefusals(subject, PERFORMABLE));
  });

  it('keeps every message inside the ledger payload limit', () => {
    for (const refusal of toolNodeRefusals(
      node(script('terraform apply'), { permission: 'full', id: 'a'.repeat(63) }),
      PERFORMABLE,
    )) {
      expect(refusal.message.length).toBeLessThanOrEqual(400);
    }
  });
});
