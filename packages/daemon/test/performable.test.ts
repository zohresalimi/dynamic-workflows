/**
 * KAR-23.9 — `PERFORMABLE_NODE_TYPES` is what `byNodeType` really routes.
 *
 * The constant is what `plan/validate.ts` refuses a plan against, and the
 * registry in `pipeline/live-nodes.ts` is what actually runs a node. They are
 * held together at compile time by `satisfies Record<PerformableNodeType,
 * NodePerformer>`, which errors on a missing key *and* on an extra one — but a
 * `satisfies` clause is invisible in a diff review and a reader deserves the
 * claim checked at runtime too. So this file asserts the biconditional
 * directly: `byNodeType` performs exactly the constant's members and refuses
 * exactly its complement.
 *
 * The refusal message is asserted as well, because on 2026-08-24 an operator
 * read *"nothing in this daemon knows how to perform a tool node"* and had no
 * way to tell an unsupported type from an unwired one.
 */
import { NODE_TYPES, type NodeType, type StartNode } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { PERFORMABLE_NODE_TYPES } from '../src/exec/performable.ts';
import type { ExecContext, NodePerformer } from '../src/exec/run-executor.ts';
import { byNodeType } from '../src/gates/gate-performer.ts';

const command = (nodeType: NodeType): StartNode =>
  ({
    kind: 'StartNode',
    runId: 'run_20260824T101500Z_9f2a1c',
    node: `the-${nodeType}`,
    attempt: 0,
    nodeType,
    title: `do the ${nodeType}`,
    provider: null,
    model: null,
    permission: 'read',
    pathScopes: { write: [] },
    worktree: null,
    retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  }) as StartNode;

/** A ctx nothing below reads: every case here settles inside `byNodeType`. */
const ctx = {} as ExecContext;

/** The production registry's shape, with each performer replaced by a marker.
 * What is under test is the routing table, not what a performer does. */
function registry(): Record<string, NodePerformer> {
  const performers: Record<string, NodePerformer> = {};
  for (const type of PERFORMABLE_NODE_TYPES) {
    performers[type] = () => Promise.resolve();
  }
  return performers;
}

suite('KAR-23.9 — byNodeType performs exactly the performable set', () => {
  it('names agent, gate and tool — human is answered, not performed', () => {
    expect([...PERFORMABLE_NODE_TYPES].toSorted()).toEqual(['agent', 'gate', 'tool']);
  });

  for (const type of NODE_TYPES) {
    const performable = (PERFORMABLE_NODE_TYPES as readonly string[]).includes(type);

    it(`${type}: ${performable ? 'routes to a performer' : 'is refused'}`, async () => {
      const perform = byNodeType(registry());

      if (performable) {
        await expect(perform(command(type), ctx)).resolves.toBeUndefined();
        return;
      }
      await expect(perform(command(type), ctx)).rejects.toThrow(
        new RegExp(`nothing in this daemon knows how to perform a ${type} node`),
      );
    });
  }

  it('the refusal names what this daemon *can* run, so the reader is not left guessing', async () => {
    const perform = byNodeType(registry());
    await expect(perform(command('map'), ctx)).rejects.toThrow(/agent, gate, tool/);
    await expect(perform(command('map'), ctx)).rejects.toThrow(/answered by a person/);
  });
});
