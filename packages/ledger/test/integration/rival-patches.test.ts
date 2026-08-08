/**
 * KAR-11.3 AC10 / EPIC-11-S16, second scenario — two proposers, one winner, no
 * merge.
 *
 * The in-process version of this is in `patch-apply.test.ts` and proves the
 * function is correct. This one proves the *database* is, which is a different
 * claim: two real processes, each with its own write connection to the same
 * `ledger.db`, released together and racing for the same base. SQLite permits
 * exactly one writer, `BEGIN IMMEDIATE` takes that lock up front, and the
 * staleness check is the first statement inside the transaction — so the loser
 * meets a `run.plan_hash` that is no longer the base it reasoned about, however
 * close the two starts were.
 *
 * The epic's note is that this is *"more real than it looks even for a
 * single-user tool: two `map` children finishing within the same tick can both
 * propose"*, and the rule is deliberately crude — one wins, the other
 * re-derives — because a rebase *"would silently apply that reason to a graph it
 * was never about"*.
 *
 * Verifies: EPIC-11-S16 (second scenario) · AC10 · test plan #7
 */
import type { PlanGraph } from '@DeFlow/core';
import { PlanGraphSchema, planHash } from '@DeFlow/core';
import { it, startCrashable, waitFor } from '@DeFlow/testkit';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { openLedger, persistPlanVersion, readPlanDoc, readRange } from '../../src/index.ts';
import { RIVAL_BASE_HASH_FILE, RIVAL_RUN } from './support/rival-patch-run.ts';

const WORKER = fileURLToPath(new URL('./support/rival-patch-worker.ts', import.meta.url));
const TS = 1_754_640_000_000;
const EPOCH = 1;
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;

const node = (id: string) => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief: `Do ${id}, carefully.`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
});

interface RivalResult {
  readonly label: string;
  readonly planHash: string;
  readonly outcome: { readonly outcome: string; readonly code?: string };
}

/** Seeds v1 and the `run` projection, then closes: the rivals need the write
 * lock, and this process must not be holding it. */
async function seed(dataDir: string): Promise<PlanGraph> {
  const db = openLedger(dataDir);
  try {
    const parsed = PlanGraphSchema.parse({
      schemaId: 'DeFlow.plangraph.v1',
      runId: RIVAL_RUN,
      version: 1,
      planHash: `sha256-${'0'.repeat(64)}`,
      parent: null,
      taskSpecHash: `sha256-${'1'.repeat(64)}`,
      createdBy: 'planner',
      createdAt: '2026-08-08T12:00:00.000Z',
      nodes: [node('recon')],
      edges: [],
    });
    const base: PlanGraph = {
      ...parsed,
      planHash: await planHash(parsed as unknown as Record<string, unknown>),
    };

    await persistPlanVersion(db, {
      runDir: join(dataDir, 'runs', RIVAL_RUN),
      graph: base,
      by: 'planner',
      planner: PLANNER,
      diagnostics: [],
      ts: TS,
      epoch: EPOCH,
    });
    db.prepare(
      `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
          daemon_epoch)
        VALUES (?, 'running', ?, 0, '{}', 1, ?)`,
    ).run(RIVAL_RUN, base.planHash, EPOCH);

    writeFileSync(join(dataDir, RIVAL_BASE_HASH_FILE), base.planHash);
    return base;
  } finally {
    db.close();
  }
}

suite('AC10 — two processes propose against the same base', () => {
  it('applies exactly one, refuses the other with PATCH_STALE, and merges nothing', async ({
    tmp,
  }) => {
    const base = await seed(tmp);
    const startFile = join(tmp, 'start');
    const labels = ['ui', 'forms'] as const;

    const rivals = labels.map((label) =>
      startCrashable({
        script: WORKER,
        env: {
          ...process.env,
          DeFlow_RIVAL_DATA_DIR: tmp,
          DeFlow_RIVAL_LABEL: label,
          DeFlow_RIVAL_START: startFile,
          DeFlow_RIVAL_READY: join(tmp, `ready-${label}`),
          DeFlow_RIVAL_OUT: join(tmp, `out-${label}.json`),
        },
      }),
    );

    try {
      // Both are open, composed and blocked before either is released, so the
      // race is over the write lock rather than over process startup.
      await waitFor(() => labels.every((label) => existsSync(join(tmp, `ready-${label}`))), {
        describe: 'both rivals to be ready',
        timeoutMs: 30_000,
      });
      writeFileSync(startFile, 'go');

      const exits = await Promise.all(rivals.map((rival) => rival.exited));
      for (const [index, exit] of exits.entries()) {
        expect(exit.code, `rival ${labels[index]} failed: ${rivals[index]?.stderr()}`).toBe(0);
      }

      const results = labels.map(
        (label) => JSON.parse(readFileSync(join(tmp, `out-${label}.json`), 'utf8')) as RivalResult,
      );
      const applied = results.filter((result) => result.outcome.outcome === 'applied');
      const stale = results.filter((result) => result.outcome.outcome === 'stale');

      expect(applied).toHaveLength(1);
      expect(stale).toHaveLength(1);
      expect(stale[0]?.outcome.code).toBe('PATCH_STALE');

      const db = openLedger(tmp);
      try {
        const patched = readRange(db, RIVAL_RUN, 0, 500).events.filter(
          (row) => row.kind === 'plan.patched',
        );
        expect(patched).toHaveLength(1);

        // No merged graph: the loser's document was never written, and the run
        // is on the winner's — not on some third thing containing both nodes.
        expect(readPlanDoc(db, String(applied[0]?.planHash))).not.toBeNull();
        expect(readPlanDoc(db, String(stale[0]?.planHash))).toBeNull();
        expect(
          db
            .prepare<{ plan_hash: string }>('SELECT plan_hash FROM run WHERE run_id = ?')
            .get(RIVAL_RUN)?.plan_hash,
        ).toBe(applied[0]?.planHash);
        // And the base is still there, unchanged, addressable by its own hash.
        expect(readPlanDoc(db, base.planHash)).not.toBeNull();
      } finally {
        db.close();
      }

      // NF8 — `cat plan/v2.json` shows the version that actually ran. The
      // loser composed a `v2` too and would have written the same path; it
      // never gets to, because the file is written once the race is won.
      const onDisk = JSON.parse(
        readFileSync(join(tmp, 'runs', RIVAL_RUN, 'plan', 'v2.json'), 'utf8'),
      ) as { planHash: string; nodes: { id: string }[] };
      expect(onDisk.planHash).toBe(applied[0]?.planHash);
      expect(onDisk.nodes.map((one) => one.id)).not.toContain(`analyse-${stale[0]?.label}`);

      const db2 = openLedger(tmp);
      try {
        expect(readPlanDoc(db2, onDisk.planHash)).not.toBeNull();
      } finally {
        db2.close();
      }
    } finally {
      await Promise.all(rivals.map((rival) => rival.sigkill()));
    }
  });
});
