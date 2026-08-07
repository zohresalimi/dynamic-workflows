/**
 * KAR-10.3 AC2 / EPIC-10-S16 — `SIGKILL` the daemon at the approval gate and
 * the run is still waiting, with the same node and the same prompt.
 *
 * `SIGKILL`, not `SIGTERM`: SIGTERM tests the shutdown handler and this is about
 * durability. It is a real child process because there is no way to be killed
 * that rudely from inside one, and it is a real file because `:memory:` *"cannot
 * be reopened after a simulated crash, which is the one property that matters
 * most"* (docs/14-testing-strategy.md §7).
 *
 * Its own file rather than a case in ./spec-gate.test.ts: this one spawns and
 * kills a process group, and a leaked child poisoning its neighbours is exactly
 * what the integration slice's `pool: 'forks'` is arranged to contain.
 *
 * Verifies: EPIC-10-S16 (second scenario) · AC2 · test plan #3
 */
import type { Db } from '@DeFlow/core';
import { initialRunState, NO_DEADLINE_WAKE_AT, SPEC_GATE_NODE } from '@DeFlow/core';
import { openLedger, readRange, readWakes, replayAll } from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, waitFor } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { approveSpec } from '../../src/spec/gate.ts';
import { minutes, SPEC_RUN, T0 } from './support/spec-gate-run.ts';

const HANG_SCRIPT = fileURLToPath(new URL('./support/hang-at-spec-gate.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const events = (db: Db) => readRange(db, SPEC_RUN, 0, 500).events;

suite('EPIC-10-S16 — SIGKILL and restart (AC2)', () => {
  it('comes back at the same gate, with the same prompt, and approves as if nothing happened', async ({
    tmp,
  }) => {
    const readyFile = join(tmp, 'ready.json');
    const child = startCrashable({ script: HANG_SCRIPT, args: [tmp, readyFile] });
    alive.push(child);

    await waitFor(() => existsSync(readyFile), {
      describe: 'the child to open the approval gate',
      timeoutMs: 20_000,
    });
    const { specHash } = JSON.parse(readFileSync(readyFile, 'utf8')) as { specHash: string };

    // No cleanup, no flush, no handlers.
    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    const restarted = openLedger(tmp);
    try {
      expect(
        restarted.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get(),
      ).toEqual({ integrity_check: 'ok' });

      // The run is still waiting, and it is waiting for the same thing.
      const state = replayAll(restarted).runs.get(SPEC_RUN) ?? initialRunState();
      expect(state.status).toBe('awaiting-spec-approval');
      expect(state.specApproved).toBeNull();
      expect(state.nodes[SPEC_GATE_NODE]?.status).toBe('suspended');

      const requested = events(restarted).filter((event) => event.kind === 'human.requested');
      expect(requested).toHaveLength(1);
      expect((requested[0]?.payload as { node: string }).node).toBe(SPEC_GATE_NODE);
      const prompt = (requested[0]?.payload as { prompt: string }).prompt;
      expect(prompt).toContain('Acceptance criteria');

      // One row, still there, still costing nothing.
      expect(readWakes(restarted, SPEC_RUN)).toEqual([
        {
          runId: SPEC_RUN,
          nodeId: SPEC_GATE_NODE,
          wakeAt: NO_DEADLINE_WAKE_AT,
          reason: 'human_gate',
        },
      ]);

      // And approving now advances the run exactly as it would have before.
      const approval = await approveSpec({
        db: restarted,
        runId: SPEC_RUN,
        epoch: 2,
        ts: T0 + minutes(90),
        by: 'cli',
      });
      expect(approval.specHash).toBe(specHash);

      const after = replayAll(restarted).runs.get(SPEC_RUN) ?? initialRunState();
      expect(after.status).toBe('spec-approved');
      expect(after.specApproved).toEqual({ specHash, by: 'cli' });
      expect(readWakes(restarted, SPEC_RUN)).toEqual([]);
    } finally {
      restarted.close();
    }
  });
});
