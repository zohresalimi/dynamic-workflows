/**
 * KAR-14.2 AC9 — the vendor's own ceiling, below DeFlow's.
 *
 * Claude Code accepts `--max-budget-usd <amt>` and ends the turn with
 * `{ type: 'result', subtype: 'error_max_budget_usd', is_error: true }`. Two
 * things have to be true about that envelope, and neither is free:
 *
 * 1. It is a **gate**, not a `transient` failure. The whole point of
 *    `transient` is that a retry might succeed; a vendor budget refusal will
 *    refuse identically three more times, at the cost of three more spawns and
 *    whatever the vendor charges for reaching the same wall.
 * 2. It carries a **breach**, so the pause path can say what the numbers were
 *    and that the ceiling was the vendor's. Without it the scheduler knows only
 *    that something gated, and an operator raising DeFlow's ceiling would find
 *    the run stopping in exactly the same place.
 *
 * The stimulus is the committed corpus rather than an object literal here: a
 * literal is the parser's own author agreeing with themselves about what a
 * vendor emits.
 *
 * Verifies: EPIC-14-S14 · KAR-14.2 AC9
 */

import type { EventSeq, Handle, NodeId } from '@DeFlow/core';
import { budgetBreachOf, ProviderIdSchema, toNodeFailure } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { providerSpec } from '../src/provider-registry.ts';
import { parseShimLine, shimResultCostUsd, shimResultFailure } from '../src/shim-frames.ts';

const NODE = 'impl-router' as NodeId;

const streamPath = (name: string): string =>
  fileURLToPath(new URL(`../../../test/fixtures/streams/${name}`, import.meta.url));

const linesOf = (name: string) =>
  readFileSync(streamPath(name), 'utf8')
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => parseShimLine(text))
    .filter((line) => line !== null);

const RESULT_LINE = linesOf('max-budget-usd.stream-json.jsonl').at(-1);
if (RESULT_LINE === undefined) throw new Error('the committed fixture has no result envelope');

const failureOf = (ceiling?: { node: NodeId; limitUsd: number }) => {
  const thrown = shimResultFailure(RESULT_LINE, ceiling === undefined ? {} : { ceiling });
  if (thrown === null) throw new Error('the fixture result envelope reported no failure');
  return toNodeFailure(thrown, {
    occurredAtEvent: 1 as EventSeq,
    attempt: 0,
    captureEvidence: () => `artifact://${'0'.repeat(64)}` as Handle,
  });
};

suite('the vendor ceiling is a gate, never a retry', () => {
  it('classifies error_max_budget_usd as gate', () => {
    const failure = failureOf();

    expect(failure.class).toBe('gate');
    expect(failure.class).not.toBe('transient');
    expect(failure.class).not.toBe('permanent');
  });

  it('records the breach, with the vendor named as the ceiling that fired', () => {
    const failure = failureOf({ node: NODE, limitUsd: 2 });
    const breach = budgetBreachOf(failure);

    expect(breach).toEqual({
      scope: 'node',
      node: NODE,
      dimension: 'cost',
      limit: 2,
      // The vendor stops *after* the turn that crossed its ceiling, so the
      // reported spend is above the limit rather than exactly on it.
      actual: shimResultCostUsd(RESULT_LINE),
      firedBy: 'vendor',
    });
    expect(breach?.actual).toBeGreaterThan(2);
  });

  it('still gates when DeFlow passed no ceiling of its own, and claims no numbers', () => {
    // A turn can only end this way if *something* set a ceiling — the vendor's
    // own config, for instance. The class is what the scheduler reads, and it
    // is unchanged; what is absent is a `limit` nobody here measured.
    const failure = failureOf();

    expect(failure.class).toBe('gate');
    expect(budgetBreachOf(failure)).toBeNull();
  });

  it('keeps the vendor diagnostics beside the breach rather than instead of it', () => {
    const failure = failureOf({ node: NODE, limitUsd: 2 });

    expect(failure.detail).toMatchObject({
      subtype: 'error_max_budget_usd',
      stopReason: 'max_budget',
    });
  });
});

suite('DeFlow arms the vendor ceiling it is going to be gated by', () => {
  const resolved = (provider: string) => ({
    provider: ProviderIdSchema.parse(provider),
    path: `/usr/local/bin/${provider}`,
  });

  /** The registered spec, or a failure naming the provider rather than a throw
   * about `undefined` five lines later. */
  function shimOf(provider: string) {
    const spec = providerSpec(provider);
    if (spec === undefined) throw new Error(`${provider} is not a registered provider`);
    return spec.shim;
  }

  const argvFor = (costCeilingUsd?: number): readonly string[] =>
    shimOf('claude').argv({
      resolved: resolved('claude'),
      worktree: '/tmp/wt',
      prompt: 'refactor the router',
      sessionId: '5c7d1e94-3f28-4a6b-8d10-2e9f4c6b7a30',
      permission: 'worktree',
      ...(costCeilingUsd === undefined ? {} : { costCeilingUsd }),
    });

  it('passes --max-budget-usd when the node has a cost ceiling', () => {
    const argv = argvFor(2);
    const at = argv.indexOf('--max-budget-usd');

    expect(at).toBeGreaterThan(-1);
    expect(argv[at + 1]).toBe('2');
  });

  it('passes nothing at all when the node has none', () => {
    expect(argvFor()).not.toContain('--max-budget-usd');
  });

  it('leaves a vendor with no such flag untouched rather than approximating one', () => {
    // Codex has no budget flag. Passing one anyway would be a spawn that fails
    // on an unknown option, which is a worse outcome than an unarmed ceiling —
    // DeFlow's own ceiling still applies either way.
    const argv = shimOf('codex').argv({
      resolved: resolved('codex'),
      worktree: '/tmp/wt',
      prompt: 'refactor the router',
      sessionId: '5c7d1e94-3f28-4a6b-8d10-2e9f4c6b7a30',
      permission: 'read',
      costCeilingUsd: 2,
    });

    expect(argv).not.toContain('--max-budget-usd');
  });
});
