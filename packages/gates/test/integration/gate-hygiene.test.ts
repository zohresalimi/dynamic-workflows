/**
 * KAR-12.6 test plan #8, AC6, AC7 — the gate-hygiene projection over a **real
 * ledger**: the sampled runs come from `event` rows in a file-backed SQLite
 * database, not from a hand-built array.
 *
 * This is the half of S38 that a pure reducer spec cannot reach. "The last 10
 * runs contain no `gate.evaluated` for gate id `a11y`" is a claim about a
 * window over the log — which runs are in it, which are outside it, and where
 * the defined-gate list comes from — and every way of getting that wrong
 * (ordering by `ts` instead of `seq`, taking the newest events rather than the
 * newest runs, reading `gates.loaded` only from the latest run) produces a
 * report that is confidently wrong while the reducer's own tests stay green.
 *
 * File-backed rather than `:memory:` because the window is defined by `seq`,
 * the ledger's only total order, and it has to be one SQLite really assigned
 * across a sequence of appends.
 *
 * Verifies: EPIC-12-S38 · AC6, AC7
 */
import type { NodeId, RunId, VerdictOutcome } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, sampleGateHygiene } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { type GateHygieneReport, gateHygiene } from '../../src/hygiene.ts';

const SPEC_HASH = `sha256-${'ab'.repeat(32)}`;

/** Run n of the fixture. Minted so that a later n sorts after an earlier one,
 * exactly as the real minter does (docs/04-domain-model.md §1.2). */
const runOf = (n: number): RunId => {
  const two = String(n).padStart(2, '0');
  return RunIdSchema.parse(`run_20260801T00${two}00Z_0000${two}`);
};

/** A `gates.loaded` draft naming every gate this run discovered. */
const loadedDraft = (runId: RunId, gates: readonly string[]) => ({
  runId,
  ts: 1_754_308_293_000,
  kind: 'gates.loaded',
  v: 1,
  epoch: 1,
  payload: {
    gates: gates.map((id, index) => ({
      id,
      path: `.DeFlow/gates/${id}.yaml`,
      sha256: String(index + 1)
        .repeat(64)
        .slice(0, 64),
    })),
  },
});

/** A `gate.evaluated` draft carrying a whole `DeFlow.verdict.v4`. */
const evaluatedDraft = (runId: RunId, gate: string, outcome: VerdictOutcome) => ({
  runId,
  ts: 1_754_308_294_000,
  kind: 'gate.evaluated',
  v: 4,
  epoch: 1,
  payload: {
    gate,
    node: `gate-${gate}` as NodeId,
    verdict: {
      schemaId: 'DeFlow.verdict.v4',
      outcome,
      gate,
      evaluatedNode: 'impl-1' as NodeId,
      by: { node: `gate-${gate}` as NodeId, provider: 'deflow', model: 'deterministic-gate' },
      criteria: [{ id: 'ac-1', status: outcome === 'pass' ? 'satisfied' : 'unsatisfied' }],
      findings: [],
      summary: `${gate} ${outcome}`,
      specHash: SPEC_HASH,
    },
  },
});

const byGate = (reports: readonly GateHygieneReport[], id: string): GateHygieneReport => {
  const report = reports.find((one) => one.gate === id);
  if (!report) throw new Error(`no hygiene report for gate ${id}`);
  return report;
};

suite('a gate nothing schedules is decoration (S38, first scenario)', () => {
  it('reports a11y as never evaluated across the last 10 runs of a real ledger', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      // Run 1 is the eleventh-most-recent: it defined a11y *and* evaluated it,
      // so anything that samples eleven runs sees a healthy a11y and anything
      // that samples ten sees decoration. That is the discrimination.
      appendEvents(db, [
        loadedDraft(runOf(1), ['typecheck', 'a11y']),
        evaluatedDraft(runOf(1), 'typecheck', 'pass'),
        evaluatedDraft(runOf(1), 'a11y', 'pass'),
      ]);

      // Runs 2..11 — the window. a11y is still defined (run 2 says so, and no
      // later run re-declares it), and nothing ever schedules it again.
      for (let n = 2; n <= 11; n += 1) {
        const run = runOf(n);
        appendEvents(db, [
          ...(n === 2 ? [loadedDraft(run, ['typecheck', 'a11y'])] : []),
          evaluatedDraft(run, 'typecheck', n % 3 === 0 ? 'fail' : 'pass'),
        ]);
      }

      const sample = sampleGateHygiene(db, { runs: 10 });
      expect(sample.sampledRuns).toBe(10);
      expect(sample.runIds).toEqual(
        Array.from({ length: 10 }, (_, index) => runOf(index + 2)).reverse(),
      );
      // The defined-gate list spans the window, not just its newest run.
      expect([...sample.definedGates].sort()).toEqual(['a11y', 'typecheck']);

      const reports = gateHygiene(sample);
      const a11y = byGate(reports, 'a11y');
      expect(a11y.neverEvaluated).toBe(true);
      expect(a11y.evaluations).toBe(0);
      expect(a11y.sampledRuns).toBe(10);
      expect(a11y.advice).toContain('10');
      expect(byGate(reports, 'typecheck').neverEvaluated).toBe(false);

      // Widen the window by one run and the same ledger says the opposite —
      // which is what makes the ten-run answer a measurement rather than an
      // artefact of the fixture holding no a11y events at all.
      const wider = gateHygiene(sampleGateHygiene(db, { runs: 11 }));
      expect(byGate(wider, 'a11y').neverEvaluated).toBe(false);
      expect(byGate(wider, 'a11y').sampledRuns).toBe(11);
    } finally {
      db.close();
    }
  });

  it('reports the runs it really found when the ledger holds fewer than N', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        loadedDraft(runOf(1), ['typecheck', 'a11y']),
        evaluatedDraft(runOf(1), 'typecheck', 'pass'),
      ]);
      appendEvents(db, [
        loadedDraft(runOf(2), ['typecheck', 'a11y']),
        evaluatedDraft(runOf(2), 'typecheck', 'pass'),
      ]);

      const reports = gateHygiene(sampleGateHygiene(db, { runs: 10 }));
      // Two runs exist, so "the last 10 runs" was checked over two — and the
      // advice has to say two, not ten, or the operator reads a count the
      // ledger never supported.
      const a11y = byGate(reports, 'a11y');
      expect(a11y.neverEvaluated).toBe(true);
      expect(a11y.sampledRuns).toBe(2);
      expect(a11y.advice).toContain('2');
      expect(a11y.advice).not.toContain('10');
    } finally {
      db.close();
    }
  });
});

suite('the sample decides which gates get a report at all', () => {
  it('reports a gate evaluated inside the window whose gates.loaded fell outside it', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      // The only declaration of `unit` is in run 1, eleven runs back. Ten runs
      // of evidence about it are inside the window. Reporting no rate for it
      // because the *definition* event aged out would hide the rate for
      // exactly the gate that is being scheduled most.
      appendEvents(db, [loadedDraft(runOf(1), ['unit'])]);
      for (let n = 2; n <= 11; n += 1) {
        appendEvents(db, [evaluatedDraft(runOf(n), 'unit', n <= 6 ? 'pass' : 'fail')]);
      }

      const sample = sampleGateHygiene(db, { runs: 10 });
      expect(sample.definedGates).toContain('unit');

      const unit = byGate(gateHygiene(sample), 'unit');
      expect(unit.passes).toBe(5);
      expect(unit.fails).toBe(5);
      expect(unit.firstPassRate).toBe(0.5);
    } finally {
      db.close();
    }
  });
});

suite('the first-pass rate is informative at both tails (S38, outline)', () => {
  it('computes 0.43, 0.10 and 1.00 per gate id from real gate.evaluated rows', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // typecheck: 3 passes, 4 fails. unit: 1 pass, 9 fails. a11y: 10 passes.
      // review: one needs-human and nothing else. Spread across ten runs, in
      // the order a real ledger would have recorded them.
      const typecheck: VerdictOutcome[] = ['pass', 'fail', 'pass', 'fail', 'pass', 'fail', 'fail'];
      const unit: VerdictOutcome[] = [
        'pass',
        ...Array.from({ length: 9 }, (): VerdictOutcome => 'fail'),
      ];

      for (let n = 1; n <= 10; n += 1) {
        const run = runOf(n);
        appendEvents(db, [
          loadedDraft(run, ['typecheck', 'unit', 'a11y', 'review']),
          ...(typecheck[n - 1] ? [evaluatedDraft(run, 'typecheck', typecheck[n - 1]!)] : []),
          evaluatedDraft(run, 'unit', unit[n - 1]!),
          evaluatedDraft(run, 'a11y', 'pass'),
          ...(n === 4 ? [evaluatedDraft(run, 'review', 'needs-human')] : []),
        ]);
      }

      const sample = sampleGateHygiene(db, { runs: 10 });
      expect(sample.sampledRuns).toBe(10);
      expect(sample.evaluations).toHaveLength(7 + 10 + 10 + 1);

      const reports = gateHygiene(sample);

      expect(byGate(reports, 'typecheck').firstPassRate).toBe(0.43);
      expect(byGate(reports, 'typecheck').advice).toBe('healthy');

      expect(byGate(reports, 'unit').firstPassRate).toBe(0.1);
      expect(byGate(reports, 'unit').advice).toBe('below 40%: the plan or the spec is wrong');

      expect(byGate(reports, 'a11y').firstPassRate).toBe(1);
      expect(byGate(reports, 'a11y').advice).toBe('at 100%: testing nothing, or being written to');

      // needs-human counts as scheduled, and rates nothing.
      const review = byGate(reports, 'review');
      expect(review.neverEvaluated).toBe(false);
      expect(review.firstPassRate).toBeNull();

      // S38's third scenario: pooled, every gate would read 14/27 ≈ 0.52.
      const rated = reports.filter((report) => report.firstPassRate !== null);
      expect(new Set(rated.map((report) => report.firstPassRate)).size).toBe(3);
      expect(rated.map((report) => report.firstPassRate)).not.toContain(0.52);
    } finally {
      db.close();
    }
  });

  it('is scoped to the sampled window, so an old red run stops counting', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // Run 1: typecheck failed four times. Runs 2..11: it passed once each.
      appendEvents(db, [
        loadedDraft(runOf(1), ['typecheck']),
        ...Array.from({ length: 4 }, () => evaluatedDraft(runOf(1), 'typecheck', 'fail')),
      ]);
      for (let n = 2; n <= 11; n += 1) {
        appendEvents(db, [
          loadedDraft(runOf(n), ['typecheck']),
          evaluatedDraft(runOf(n), 'typecheck', 'pass'),
        ]);
      }

      const ten = byGate(gateHygiene(sampleGateHygiene(db, { runs: 10 })), 'typecheck');
      expect(ten.passes).toBe(10);
      expect(ten.fails).toBe(0);
      expect(ten.firstPassRate).toBe(1);

      const eleven = byGate(gateHygiene(sampleGateHygiene(db, { runs: 11 })), 'typecheck');
      expect(eleven.fails).toBe(4);
      expect(eleven.firstPassRate).toBe(0.71);
    } finally {
      db.close();
    }
  });
});
