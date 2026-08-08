/**
 * KAR-12.1 test plan #3 — the milestone rule's second half.
 *
 * Verifies: EPIC-12-S4 · AC4
 */
import type { GateId } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  type GateVerdictRecord,
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
