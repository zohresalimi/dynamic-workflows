/**
 * KAR-28.5 — the phases projection over the committed run corpus.
 *
 * `run-phases.test.ts` folds hand-built plans and proves each rule in
 * isolation. This file folds the ledgers KAR-16.3 committed — the same bytes
 * the replay harness serves and the frontend's projection suite reads — and
 * asserts the shape they actually produce. Two things only a real corpus can
 * catch:
 *
 *   1. **`stress-400`'s fan-out.** 400 `migrate-views--<hash>` children minted by
 *      the production `mapChildId`, plus the `migrate-one-view` template that
 *      *"stays in the graph and never runs"*. If containment ever stops
 *      recognising the `<parent>--<itemId>` id form, this run answers 402 phases
 *      instead of 3, which is the failure mode
 *      [ADR 0018](../../../docs/adr/0018-a-phase-is-a-top-level-step-of-the-executing-plan.md)
 *      records as the cost of deriving containment from a convention.
 *   2. **Evidence, not optimism.** `stress-400` ends `completed` with a passing
 *      `gate.evaluated`, and its gate phase still reads `pending` — because that
 *      fixture never recorded the gate *node* scheduling, starting or finishing.
 *      A projection that read the verdict as a node completion would be claiming
 *      a run of work the ledger has no record of, and every other fixture here
 *      shows what a gate that really ran looks like.
 *
 * Verifies: EPIC-28-S20, EPIC-28-S21 · KAR-28.5 AC1, AC2
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { parseEvent } from '../src/events.ts';
import { reduce } from '../src/reduce.ts';
import { type RunPhase, runPhases } from '../src/run-phases.ts';
import { initialRunState, type RunState } from '../src/run-state.ts';

const CORPUS = fileURLToPath(new URL('../../../test/fixtures/runs/', import.meta.url));

/** One committed fixture, folded exactly as the daemon folds it. */
function fold(fixture: string): RunState {
  const text = readFileSync(`${CORPUS}${fixture}/events.jsonl`, 'utf8');
  let state = initialRunState();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseEvent(JSON.parse(line));
    if (parsed.status !== 'ok') {
      throw new Error(`${fixture} holds a line this build cannot read: ${JSON.stringify(parsed)}`);
    }
    state = reduce(state, parsed.event);
  }
  return state;
}

const row = (phase: RunPhase): string =>
  `${phase.id} ${phase.state} ${phase.completed}/${phase.total}`;

suite('EPIC-28-S20 — the projection over recorded ledgers', () => {
  it('folds stress-400 into three phases, one of them 400 items wide', () => {
    const projection = runPhases(fold('stress-400'));

    expect(projection.basis).toBe('plan');
    expect(projection.phases.map(row)).toEqual([
      'recon-legacy-views complete 1/1',
      'migrate-views complete 400/400',
      // The gate node has a passing `gate.evaluated` and no node events at all
      // in this fixture, so the honest answer is that nothing has been recorded
      // running it. See the module note.
      'gate-typecheck pending 0/1',
    ]);
  });

  it('puts the map body template inside the map rather than beside it', () => {
    const projection = runPhases(fold('stress-400'));
    const ids = projection.phases.map((phase) => phase.id);
    expect(ids).not.toContain('migrate-one-view');

    const migrate = projection.phases.find((phase) => phase.id === 'migrate-views');
    expect(migrate?.nodes).toHaveLength(400);
    expect(migrate?.nodes).not.toContain('migrate-one-view');
    expect(migrate?.nodes.every((id) => id.startsWith('migrate-views--'))).toBe(true);
  });

  it('reports a mid-flight run as a mix of complete, running and failed', () => {
    const projection = runPhases(fold('happy-path-12'));

    // Twelve top-level steps, none of which fans out: the honest shape of a
    // flat plan is a phase per step (EPIC-28-S21).
    expect(projection.phases).toHaveLength(12);
    expect(projection.phases.every((phase) => phase.total === 1)).toBe(true);
    expect(projection.phases.map(row)).toContain('recon-auth-surface complete 1/1');
    expect(projection.phases.map(row)).toContain('impl-login failed 0/1');
    // Scheduled and not yet started is still work the scheduler has in hand,
    // so the phase is running with nothing completed — not pending.
    expect(projection.phases.map(row)).toContain('smoke-tests running 0/1');
  });

  it('drops the nodes a repair superseded and keeps the ones that replaced them', () => {
    const projection = runPhases(fold('gate-failure-repair'));
    // v3 supersedes the first `gate-typecheck` with `gate-typecheck-r2` after
    // the repair node lands; the superseded gate is not this plan's work.
    expect(projection.phases.map((phase) => phase.id)).toEqual([
      'impl-1',
      'fix-65207341fbd9',
      'gate-typecheck-r2',
    ]);
  });

  it('answers every fixture without inventing a phase or a total', () => {
    for (const fixture of [
      'happy-path-12',
      'stress-400',
      'three-patches',
      'gate-failure-repair',
      'five-minute-diagnosis',
      'repair-attempts',
    ]) {
      const state = fold(fixture);
      const projection = runPhases(state);
      const planned = new Set((state.plan?.nodes ?? []).map((node) => node.id));

      expect(projection.basis).toBe('plan');
      for (const phase of projection.phases) {
        // Every phase, and every item of it, is a node this plan holds.
        expect(planned.has(phase.id)).toBe(true);
        expect(phase.nodes.every((id) => planned.has(id))).toBe(true);
        // `total` is a count of things that exist, and `completed` cannot
        // exceed it.
        expect(phase.total).toBe(phase.nodes.length);
        expect(phase.completed).toBeLessThanOrEqual(phase.total);
        expect(phase.total).toBeGreaterThan(0);
      }
      // No node is claimed by two phases.
      const claimed = projection.phases.flatMap((phase) => phase.nodes);
      expect(new Set(claimed).size).toBe(claimed.length);
    }
  });
});
