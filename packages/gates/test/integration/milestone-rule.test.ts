/**
 * KAR-12.1 test plan #3, at the level S4 declares it — a file-backed ledger and
 * a real git repository.
 *
 * `:memory:` is not an option here: the whole point of the rule is an ordering
 * between two rows, and the seq the rule compares has to be one SQLite really
 * assigned. The write side is a real commit read back with
 * `git show --name-only`, because "the paths in its scope" is a claim about the
 * tree rather than about a payload somebody wrote by hand.
 *
 * Verifies: EPIC-12-S4, EPIC-12-S27 · AC4, KAR-12.4 AC6 · KAR-12.4 test plan #7
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, readRange } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { gateVerdictsFromEvents, type Milestone, milestoneStatus } from '../../src/milestone.ts';

const RUN: RunId = RunIdSchema.parse('run_20260808T041500Z_1a2b3c');
const SPEC_HASH = `sha256-${'12'.repeat(32)}`;

const M1: Milestone = {
  id: 'm1',
  requires: ['unit'],
  scope: ['packages/ui/**'],
} as Milestone;

const verdictDraft = (outcome: 'pass' | 'fail') => ({
  runId: RUN,
  ts: 1_754_308_293_000,
  kind: 'gate.evaluated',
  v: 2,
  epoch: 1,
  payload: {
    gate: 'unit',
    node: 'gate-unit' as NodeId,
    verdict: {
      schemaId: 'DeFlow.verdict.v2',
      outcome,
      gate: 'unit',
      evaluatedNode: 'impl-1' as NodeId,
      by: { node: 'gate-unit' as NodeId, provider: 'deflow', model: 'deterministic-gate' },
      criteria: [{ id: 'ac-1', status: outcome === 'pass' ? 'satisfied' : 'unsatisfied' }],
      findings: [],
      summary: `unit ${outcome}`,
      specHash: SPEC_HASH,
    },
  },
});

/**
 * The Background this file inherits: *"a TaskSpec has been approved, producing
 * `run.spec.approved` and a pinned specHash"*. It is seeded rather than assumed
 * because it is load-bearing for the rule — `gateVerdictsFromEvents` admits a
 * verdict only against the hash the run is currently judged against (AC6), so a
 * ledger with no approval in it is a run whose greens are all about a draft.
 */
const approvalDraft = (specHash: string) => ({
  runId: RUN,
  ts: 1_754_308_292_000,
  kind: 'run.spec.approved',
  v: 1,
  epoch: 1,
  payload: { specHash, by: 'ui' },
});

const commitDraft = (node: string) => ({
  runId: RUN,
  ts: 1_754_308_294_000,
  kind: 'node.completed',
  v: 1,
  epoch: 1,
  payload: { node, attempt: 1, result: { kind: 'text', text: 'committed' } },
});

/** The paths the repository's tip commit touched, POSIX and repo-relative. */
async function committedPaths(repo: { git(...args: string[]): Promise<string> }) {
  const output = await repo.git('show', '--name-only', '--pretty=format:', 'HEAD');
  return output.split('\n').filter((line) => line.trim() !== '');
}

suite('a repair loop touches files after the gate ran (S4, first scenario)', () => {
  it('reports the milestone unadvanced with reason stale-green, and re-schedules the gate', async ({
    tmp,
  }) => {
    const repo = await makeRepo({
      dir: join(tmp, 'worktree'),
      files: { 'packages/ui/src/DatePicker.vue': '<template><div /></template>\n' },
    });
    const db = openLedger(tmp);
    try {
      // 1. The gate passes over the tree as it then was.
      const [, passSeq] = appendEvents(db, [approvalDraft(SPEC_HASH), verdictDraft('pass')]);

      // 2. A fix node commits inside the milestone's scope, afterwards.
      await writeFile(
        join(repo.dir, 'packages/ui/src/DatePicker.vue'),
        '<template><div class="fixed" /></template>\n',
      );
      await repo.git('add', '-A');
      await repo.git('commit', '-m', 'fix: the date picker');
      const paths = await committedPaths(repo);
      expect(paths).toEqual(['packages/ui/src/DatePicker.vue']);
      const [writeSeq] = appendEvents(db, [commitDraft('fix-a13f')]);

      expect(writeSeq).toBeGreaterThan(passSeq as number);

      const events = readRange(db, RUN, 0, 100).events;
      const verdicts = gateVerdictsFromEvents(events);
      expect(verdicts).toEqual([{ gate: 'unit', outcome: 'pass', seq: passSeq }]);

      const stale = milestoneStatus(M1, verdicts, [{ seq: writeSeq as number, paths }]);
      expect(stale.advanced).toBe(false);
      expect(stale.reason).toBe('stale-green');
      expect(stale.rescheduled).toEqual(['unit']);
      expect(stale.lastWriteSeq).toBe(writeSeq);

      // 3. The re-run pass advances it (S4, second scenario).
      appendEvents(db, [verdictDraft('pass')]);
      const after = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      const advanced = milestoneStatus(M1, after, [{ seq: writeSeq as number, paths }]);
      expect(advanced.advanced).toBe(true);
      expect(advanced.reason).toBeNull();
    } finally {
      db.close();
    }
  });
});

suite('writes outside the scope do not invalidate it (S4, third scenario)', () => {
  it('stays advanced when the commit only touched docs', async ({ tmp }) => {
    const repo = await makeRepo({
      dir: join(tmp, 'worktree'),
      files: { 'docs/adr/0004.md': '# 0004\n', 'packages/ui/src/App.vue': '<template />\n' },
    });
    const db = openLedger(tmp);
    try {
      const [, passSeq] = appendEvents(db, [approvalDraft(SPEC_HASH), verdictDraft('pass')]);
      await writeFile(join(repo.dir, 'docs/adr/0004.md'), '# 0004 — amended\n');
      await repo.git('add', '-A');
      await repo.git('commit', '-m', 'docs: amend 0004');
      const paths = await committedPaths(repo);
      const [writeSeq] = appendEvents(db, [commitDraft('docs-1')]);

      const verdicts = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      const status = milestoneStatus(M1, verdicts, [{ seq: writeSeq as number, paths }]);

      expect(passSeq).toBeLessThan(writeSeq as number);
      expect(status.advanced).toBe(true);
      expect(status.rescheduled).toEqual([]);
      expect(status.lastWriteSeq).toBeNull();
    } finally {
      db.close();
    }
  });
});

/**
 * KAR-12.4 test plan #7, at the level EPIC-12-S27 declares it — *"file-backed
 * ledger: edit the spec mid-run → new specHash → the prior `pass` verdict is
 * void and the gate re-runs"*, red when "verdicts are trusted regardless of
 * specHash".
 *
 * A real ledger rather than a hand-built array because the ordering is the
 * claim: the approval that voids the pass is appended *after* it, at a seq
 * SQLite assigned, and the projection has to reach the right answer reading the
 * rows back in that order. An in-memory list of two objects would let the test
 * agree with a filter that only looks forwards.
 */
suite('the spec is edited after the gate passed (EPIC-12-S27, first scenario)', () => {
  const EDITED_HASH = `sha256-${'34'.repeat(32)}`;

  it('voids the pass, unadvances the milestone and re-schedules the gate', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const [, passSeq] = appendEvents(db, [approvalDraft(SPEC_HASH), verdictDraft('pass')]);

      // Nothing was written, so this is the void rule on its own: under the
      // seq comparison alone the milestone advances, and it must not.
      const before = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      expect(before).toEqual([{ gate: 'unit', outcome: 'pass', seq: passSeq }]);
      expect(milestoneStatus(M1, before, []).advanced).toBe(true);

      // The operator edits one word and re-approves at the new hash.
      const [editSeq] = appendEvents(db, [approvalDraft(EDITED_HASH)]);
      expect(editSeq).toBeGreaterThan(passSeq as number);

      const after = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      expect(after).toEqual([]);
      const status = milestoneStatus(M1, after, []);
      expect(status.advanced).toBe(false);
      expect(status.reason).toBe('gate-not-evaluated');
      expect(status.rescheduled).toEqual(['unit']);

      // The void verdict stays in the ledger, visible rather than deleted —
      // "this clears a projection, not history".
      const kinds = readRange(db, RUN, 0, 100).events.map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'gate.evaluated')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('re-approving the same spec voids nothing (second scenario)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [approvalDraft(SPEC_HASH), verdictDraft('pass'), approvalDraft(SPEC_HASH)]);
      const verdicts = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      expect(verdicts).toHaveLength(1);
      expect(milestoneStatus(M1, verdicts, []).advanced).toBe(true);
    } finally {
      db.close();
    }
  });

  it('a re-run at the edited hash advances it again', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        approvalDraft(SPEC_HASH),
        verdictDraft('pass'),
        approvalDraft(EDITED_HASH),
      ]);
      appendEvents(db, [
        {
          ...verdictDraft('pass'),
          payload: {
            ...verdictDraft('pass').payload,
            verdict: { ...verdictDraft('pass').payload.verdict, specHash: EDITED_HASH },
          },
        },
      ]);
      const verdicts = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      expect(verdicts).toEqual([{ gate: 'unit', outcome: 'pass', seq: 4 }]);
      expect(milestoneStatus(M1, verdicts, []).advanced).toBe(true);
    } finally {
      db.close();
    }
  });
});

suite('a red gate never advances a milestone, whatever else is in the ledger (S5)', () => {
  it('stays unadvanced with reason gate-not-passed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [approvalDraft(SPEC_HASH), verdictDraft('pass'), verdictDraft('fail')]);
      const verdicts = gateVerdictsFromEvents(readRange(db, RUN, 0, 100).events);
      const status = milestoneStatus(M1, verdicts, []);
      expect(status.advanced).toBe(false);
      expect(status.reason).toBe('gate-not-passed');
    } finally {
      db.close();
    }
  });
});
