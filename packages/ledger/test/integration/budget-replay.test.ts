/**
 * KAR-14.1 — EPIC-14-S6: the accounting rollup survives `kill -9` for free,
 * and the restart double-counts nothing.
 *
 * Accounting in DeFlow is a **projection**, not a table: there is no running
 * total in the daemon and nothing a crash can lose, so "the figures survive a
 * crash" is a property of the reducer rather than a feature somebody has to
 * remember to flush. This spec is what turns that sentence into a measurement.
 *
 * `SIGKILL`, never `SIGTERM`: SIGTERM tests the shutdown handler, and the
 * shutdown handler is exactly what a crashed laptop does not run. The reopen is
 * a **fresh engine over the same file** — the code path a daemon restart really
 * takes, and one an in-memory database cannot express at all
 * (docs/14-testing-strategy.md §7).
 *
 * The de-duplication assertion is deliberately made against `(runId, nodeId,
 * attempt)` on the *events*, not against the rollup. A projection that quietly
 * collapsed two records into one would hide a genuine double execution behind a
 * silent dedup, and the thing that must prevent the second record is the effect
 * journal's idempotency key — which the scripted run really uses.
 *
 * The scripted run is the crash-fuzz suite's, reused rather than re-scaffolded:
 * it is the only thing in the tree that performs the real durable-execution
 * protocol against a real `.DeFlow/` directory, spawning real fake-agent
 * binaries, and it is what EPIC-06's orchestrator will replace.
 *
 * `vi.useFakeTimers()` is forbidden here: a child process is alive throughout.
 *
 * Verifies: EPIC-14-S6 · KAR-14.1 AC1, AC5, AC6 · test plan #9
 */
import {
  canonicalJson,
  consumptionKey,
  foldEvents,
  initialRunState,
  type RunId,
  type RunState,
} from '@DeFlow/core';
import { it, sleep, waitFor } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { drainEvents, openAndReplay } from '../../src/index.ts';
import { FUZZ_RUN, startScriptedRun, WEDGE_BUDGET_MS } from '../crash-fuzz/support/scripted-run.ts';

/**
 * The phase to kill in.
 *
 * By the time the run announces node index 3, nodes 0–2 have reached a terminal
 * event each — and node 2 is the one scripted to fail its first attempt, so the
 * committed prefix contains a failed attempt's spend as well as three
 * successful ones. Killing earlier would make the "no double count" assertion
 * true for the boring reason that there was nothing to count.
 */
const KILL_PHASE = /^node:3:/;

/** Two is the scenario's minimum; three nodes' worth is what this waits for. */
const MINIMUM_RECORDS = 2;

interface Consumed {
  readonly node: string | null;
  readonly attempt: number | null;
}

/** Every `budget.consumed` in the ledger, in `seq` order, as its own payload. */
function consumptions(dataDir: string): Consumed[] {
  const opened = openAndReplay(dataDir, { enabled: false });
  try {
    return [...drainEvents(opened.db, FUZZ_RUN)]
      .filter((event) => event.kind === 'budget.consumed')
      .map((event) => event.payload as unknown as Consumed);
  } finally {
    opened.db.close();
  }
}

/** The reduced state of the whole surviving ledger, and the database's verdict. */
function replay(dataDir: string): { readonly state: RunState; readonly integrity: unknown } {
  const opened = openAndReplay(dataDir, { enabled: false });
  try {
    let state = initialRunState();
    for (const event of drainEvents(opened.db, FUZZ_RUN)) {
      state = foldEvents([event], state).state;
    }
    return { state, integrity: opened.db.pragma('integrity_check') };
  } finally {
    opened.db.close();
  }
}

/**
 * The projections the scripted run recorded, minus the torn tail a SIGKILL is
 * allowed to leave. The file is appended synchronously after every commit, so
 * at most the final line may be unreadable.
 */
function readProjections(path: string): { seq: number; state: string }[] {
  if (!existsSync(path)) return [];
  const entries: { seq: number; state: string }[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
    try {
      entries.push(JSON.parse(line) as { seq: number; state: string });
    } catch {
      // The crash landed mid-write. Only the last line may be like this.
    }
  }
  return entries;
}

suite('EPIC-14-S6 — replay after kill -9 reproduces the rollups', () => {
  it('rebuilds byte-identical figures and counts no spend twice', async ({ tmp, agentPath }) => {
    const sideEffects = join(tmp, 'side-effects.ndjson');
    const projections = join(tmp, 'projections.ndjson');
    const options = { dataDir: tmp, agent: agentPath.binary, sideEffects, projections, seed: 14 };

    const first = startScriptedRun(options);
    await waitFor(
      () => {
        if (first.settled()) throw new Error('the scripted run finished before it could be killed');
        return KILL_PHASE.test(first.phase());
      },
      { describe: 'the scripted run to reach its fourth node', timeoutMs: WEDGE_BUDGET_MS },
    );
    // Somewhere inside the window rather than always on its first instruction.
    await sleep(30);

    const crashed = await first.child.sigkill();
    expect(crashed.signal, 'the run must be killed, not allowed to finish').toBe('SIGKILL');

    // ── what the dead process left behind ───────────────────────────────────
    const beforeCrash = consumptions(tmp);
    expect(
      beforeCrash.length,
      'the crash landed before any spend was committed',
    ).toBeGreaterThanOrEqual(MINIMUM_RECORDS);

    const preCrash = replay(tmp);
    expect(preCrash.integrity).toBe('ok');
    const snapshot = canonicalJson(preCrash.state.budget);

    // The pre-crash rollup is a real one, not an empty object that would make
    // every equality below vacuous.
    expect(preCrash.state.budget.run.costUsd.subscription).toBeGreaterThan(0);
    expect(Object.keys(preCrash.state.budget.nodes).length).toBeGreaterThanOrEqual(MINIMUM_RECORDS);

    // A failed attempt's spend is in there too, and is not discounted (AC5).
    const failed = preCrash.state.budget.nodes['step-03'];
    expect(failed?.attempts.map((entry) => entry.attempt)).toEqual([0, 1]);
    expect(failed?.costUsd.subscription).toBeGreaterThan(
      failed?.attempts[1]?.costUsd.subscription ?? 0,
    );

    // ── a fresh engine over the same file ───────────────────────────────────
    const reopened = replay(tmp);
    expect(reopened.integrity).toBe('ok');
    expect(canonicalJson(reopened.state.budget)).toBe(snapshot);

    // And the same claim through the checkpoint cache the daemon really uses,
    // rather than only through a fold from zero.
    const cached = openAndReplay(tmp);
    try {
      expect(canonicalJson(cached.runs.get(FUZZ_RUN as RunId)?.budget ?? null)).toBe(snapshot);
      expect(cached.db.pragma('integrity_check')).toBe('ok');
    } finally {
      cached.db.close();
    }

    // ── the restart, and what it must not append ────────────────────────────
    const completedBefore = new Set(
      Object.entries(preCrash.state.nodes)
        .filter(([, node]) => node.status === 'completed')
        .map(([id]) => id),
    );
    expect(completedBefore.size).toBeGreaterThanOrEqual(MINIMUM_RECORDS);

    const second = startScriptedRun(options);
    expect(await second.child.exited, second.child.stderr()).toEqual({ code: 0, signal: null });

    const afterRestart = consumptions(tmp);
    // Nothing was re-executed, so nothing was re-charged: every node that had
    // already completed contributes exactly the records it contributed before.
    for (const node of completedBefore) {
      const before = beforeCrash.filter((entry) => entry.node === node).length;
      expect(afterRestart.filter((entry) => entry.node === node)).toHaveLength(before);
    }

    // The triple is unique across the whole ledger, first life and second.
    const keys = afterRestart.map((entry) => consumptionKey(FUZZ_RUN, entry.node, entry.attempt));
    expect(new Set(keys).size, `duplicated: ${keys.join(', ')}`).toBe(keys.length);

    // Not vacuous: the restart really did finish the run it inherited.
    expect(afterRestart.length).toBeGreaterThan(beforeCrash.length);
    const finished = replay(tmp);
    expect(finished.state.status).toBe('completed');
    expect(finished.state.budget.run.costUsd.subscription).toBeGreaterThan(
      preCrash.state.budget.run.costUsd.subscription ?? 0,
    );
  });
});
