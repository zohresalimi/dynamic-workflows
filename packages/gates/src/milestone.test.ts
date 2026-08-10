/**
 * KAR-12.1 test plan #3 — the milestone rule's second half.
 *
 * Verifies: EPIC-12-S4, EPIC-12-S27 (the milestone clause) · AC4, KAR-12.4 AC6
 */
import type { GateId } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  type GateVerdictRecord,
  gateVerdictsFromEvents,
  type LedgerEventLike,
  type Milestone,
  milestoneStatus,
  type WriteRecord,
} from './milestone.ts';

const M1: Milestone = {
  id: 'm1',
  requires: ['unit' as GateId],
  scope: ['packages/ui/**'],
};

const passAt = (seq: number, gate = 'unit'): GateVerdictRecord => ({
  gate: gate as GateId,
  outcome: 'pass',
  seq,
});

const wrote = (seq: number, ...paths: string[]): WriteRecord => ({ seq, paths });

suite('a pass after the last in-scope write advances the milestone', () => {
  it('advances when no write followed the pass', () => {
    const status = milestoneStatus(M1, [passAt(4120)], [wrote(4100, 'packages/ui/src/App.vue')]);
    expect(status.advanced).toBe(true);
    expect(status.reason).toBeNull();
  });

  it('advances on the re-run pass (S4, second scenario)', () => {
    const status = milestoneStatus(
      M1,
      [passAt(4120), passAt(4230)],
      [wrote(4180, 'packages/ui/src/DatePicker.vue')],
    );
    expect(status.advanced).toBe(true);
    expect(status.lastWriteSeq).toBe(4180);
  });
});

suite('a pass recorded before the last in-scope write is a stale green (S4)', () => {
  const status = milestoneStatus(
    M1,
    [passAt(4120)],
    [wrote(4180, 'packages/ui/src/DatePicker.vue')],
  );

  it('leaves the milestone unadvanced', () => {
    expect(status.advanced).toBe(false);
  });

  it('names the reason stale-green on the projection', () => {
    expect(status.reason).toBe('stale-green');
  });

  it('re-schedules the gate rather than advancing', () => {
    expect(status.rescheduled).toEqual(['unit']);
  });
});

suite('writes outside the scope do not invalidate it (S4, third scenario)', () => {
  it('stays advanced and re-schedules nothing', () => {
    const status = milestoneStatus(M1, [passAt(4120)], [wrote(4180, 'docs/adr/0004.md')]);
    expect(status.advanced).toBe(true);
    expect(status.rescheduled).toEqual([]);
    expect(status.lastWriteSeq).toBeNull();
  });
});

suite('the first half of the rule: every required gate needs a pass', () => {
  const twoGates: Milestone = {
    ...M1,
    requires: ['unit' as GateId, 'typecheck' as GateId],
  };

  it('does not advance while a required gate has no verdict at all', () => {
    const status = milestoneStatus(twoGates, [passAt(4120)], []);
    expect(status.advanced).toBe(false);
    expect(status.reason).toBe('gate-not-evaluated');
    expect(status.rescheduled).toEqual(['typecheck']);
  });

  it('does not advance on a fail, whatever its seq', () => {
    const status = milestoneStatus(
      M1,
      [{ gate: 'unit' as GateId, outcome: 'fail', seq: 9999 }],
      [wrote(1, 'packages/ui/src/App.vue')],
    );
    expect(status.advanced).toBe(false);
    expect(status.reason).toBe('gate-not-passed');
  });

  it('takes the latest verdict per gate, so a later fail undoes an earlier pass', () => {
    const status = milestoneStatus(
      M1,
      [passAt(10), { gate: 'unit' as GateId, outcome: 'fail', seq: 20 }],
      [],
    );
    expect(status.advanced).toBe(false);
    expect(status.reason).toBe('gate-not-passed');
  });

  it('advances a milestone whose scope was never written to', () => {
    expect(milestoneStatus(M1, [passAt(10)], []).advanced).toBe(true);
  });
});

/**
 * KAR-12.4 AC6, EPIC-12-S27 — "a verdict whose `specHash` differs from the
 * run's current pinned `specHash` is void: it does not satisfy a criterion,
 * **does not advance a milestone**, and the gate is re-scheduled."
 *
 * The filter belongs here rather than inside `milestoneStatus`, and that is the
 * whole design: `MILESTONE_ADVANCE_INPUTS` says the rule has two inputs and
 * ../test/no-escape-hatch.test.ts holds it to that, so a void verdict must stop
 * being a `GateVerdictRecord` at all rather than become a third thing the rule
 * consults. The reader is where the ledger's own answer to "which contract is
 * pinned now" lives, so it is where the answer gets applied — and it uses the
 * same test `reduce` applies to `gateVerdicts` (../../core/src/reduce.ts), so
 * the projection and the scheduler cannot disagree about which greens count.
 */
suite('a verdict void by specHash is not evidence for the rule (AC6)', () => {
  const CURRENT = `sha256-${'a'.repeat(64)}`;
  const SUPERSEDED = `sha256-${'b'.repeat(64)}`;

  const approved = (specHash: string, seq: number): LedgerEventLike => ({
    seq,
    kind: 'run.spec.approved',
    payload: { specHash, by: 'ui' },
  });

  const evaluated = (specHash: string | undefined, seq: number): LedgerEventLike => ({
    seq,
    kind: 'gate.evaluated',
    payload: {
      gate: 'unit',
      node: 'gate-unit',
      verdict: {
        outcome: 'pass',
        by: { node: 'gate-unit' },
        ...(specHash === undefined ? {} : { specHash }),
      },
    },
  });

  it('keeps a verdict that names the run’s current pinned hash', () => {
    expect(gateVerdictsFromEvents([approved(CURRENT, 1), evaluated(CURRENT, 2)])).toEqual([
      { gate: 'unit', outcome: 'pass', seq: 2 },
    ]);
  });

  it('drops a verdict that names a hash nobody approved', () => {
    expect(gateVerdictsFromEvents([approved(CURRENT, 1), evaluated(SUPERSEDED, 2)])).toEqual([]);
  });

  /** The order a mid-run edit really arrives in: the pass was honest, and the
   * contract moved underneath it afterwards. */
  it('drops a pass the spec was edited out from under', () => {
    const events = [approved(SUPERSEDED, 1), evaluated(SUPERSEDED, 2), approved(CURRENT, 3)];
    expect(gateVerdictsFromEvents(events)).toEqual([]);
    expect(milestoneStatus(M1, gateVerdictsFromEvents(events), []).advanced).toBe(false);
    expect(milestoneStatus(M1, gateVerdictsFromEvents(events), []).rescheduled).toEqual(['unit']);
  });

  it('re-approving the same hash voids nothing', () => {
    const events = [approved(CURRENT, 1), evaluated(CURRENT, 2), approved(CURRENT, 3)];
    expect(milestoneStatus(M1, gateVerdictsFromEvents(events), []).advanced).toBe(true);
  });

  it('drops a verdict that names no hash at all — "it did not say" is not a citation', () => {
    expect(gateVerdictsFromEvents([approved(CURRENT, 1), evaluated(undefined, 2)])).toEqual([]);
  });

  it('counts nothing on a run whose spec was never approved', () => {
    expect(gateVerdictsFromEvents([evaluated(CURRENT, 2)])).toEqual([]);
  });
});

suite('the comparison is on seq, never on a timestamp (S4 notes)', () => {
  it('ignores wall-clock ordering entirely: only seq is an input', () => {
    // A verdict recorded at seq 4230 advances over a write at seq 4180 even
    // though nothing here carries a `ts` at all — the rule is immune to a
    // non-monotonic clock because it never reads one.
    const record: GateVerdictRecord = passAt(4230);
    expect(Object.keys(record).sort()).toEqual(['gate', 'outcome', 'seq']);
    expect(milestoneStatus(M1, [record], [wrote(4180, 'packages/ui/a.ts')]).advanced).toBe(true);
  });
});
