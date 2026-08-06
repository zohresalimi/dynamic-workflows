/**
 * EPIC-06-S12 (shell rows) and EPIC-06-S15 — the probe that often cannot tell,
 * and the escalation designed on day one rather than bolted on
 * (KAR-06.4 AC4, AC5, AC6, AC9, AC10; roadmap risk **A1-5**).
 *
 * Everything here is real: a real git repository, a real `git status
 * --porcelain` child process, a real command child process that appends one
 * line per invocation to a log of its own, and two real daemon lives over one
 * file-backed ledger. The log — not the effect journal — is what "ran twice"
 * is checked against, because the journal is the mechanism under test and
 * asking it whether it worked proves only that it agrees with itself.
 *
 * The last suite is the important one. `unknown` has **no correct automatic
 * action**: retrying might apply a migration twice, skipping might drop it,
 * and neither is detectable afterwards. So the assertions are about what does
 * *not* happen — no re-run, and no `StartNode` on any tick, for six hours of
 * simulated time — and about the evidence a human is handed to decide with.
 *
 * Verifies: EPIC-06-S12, EPIC-06-S15, EPIC-06-S16 · AC4, AC5, AC6, AC9, AC10
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { decide, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  openLedger,
  readEffect,
  readRange,
  replayRun,
} from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { expect, describe as suite } from 'vitest';
import {
  createEffectRunner,
  type Effect,
  type EffectCtx,
  EffectNeedsReconciliation,
  porcelainHash,
  runGit,
  type ShellEffectPorts,
  type ShellResult,
  shellEffect,
} from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T141133Z_9f2a1c');
const NODE: NodeId = NodeIdSchema.parse('db-migrate');
const DOWNSTREAM: NodeId = NodeIdSchema.parse('announce');
const HASH = `sha256-${'a'.repeat(64)}`;
const PLAN_HASH = `sha256-${'b'.repeat(64)}`;
const DAEMON_STARTED_AT = 1_754_313_000_000;
const IKEY = `${RUN}/db-migrate/0/0`;

const openRunner = (dataDir: string, daemonStartedAt = DAEMON_STARTED_AT) => {
  const db = openLedger(dataDir);
  const clock = new TestClock(daemonStartedAt + 1000);
  return { db, clock, runner: createEffectRunner({ db, clock, daemonStartedAt, epoch: 1 }) };
};

const eventsOf = (db: ReturnType<typeof openLedger>, kind: string): Record<string, unknown>[] =>
  readRange(db, RUN, 0, 500)
    .events.filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

/**
 * The command: a real child process that appends one line to `log` and, when
 * asked, writes a file into the worktree so the porcelain hash really moves.
 */
function command(repo: string, log: string, mutates: boolean): ShellEffectPorts['run'] {
  return async (): Promise<ShellResult> => {
    const script =
      `require('node:fs').appendFileSync(process.env.LOG, 'ran\\n');` +
      (mutates ? `require('node:fs').writeFileSync(process.env.OUT, 'migrated\\n');` : '');
    const result = await execa(process.execPath, ['-e', script], {
      cwd: repo,
      env: { LOG: log, OUT: join(repo, 'migrated.txt') },
      reject: false,
    });
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
  };
}

const porcelain = (repo: string) => async (): Promise<string> =>
  (await runGit(repo, ['status', '--porcelain'], { env: GIT_ENV })).stdout;

const ranCount = async (log: string): Promise<number> => {
  try {
    return (await readFile(log, 'utf8')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

const migrateEffect = (
  repo: string,
  log: string,
  classification: 'pure' | 'mutating',
  mutates = classification === 'mutating',
) =>
  shellEffect(
    { runId: RUN, nodeId: NODE, attempt: 0, ordinal: 0, requestHash: HASH, classification },
    { run: command(repo, log, mutates), porcelain: porcelain(repo) },
  );

/** The daemon dying the instant `perform()` returns — the S16 window. */
function killedAfterPerform<T>(effect: Effect<T>): Effect<T> {
  return {
    ...effect,
    async perform(ctx: EffectCtx): Promise<T> {
      await effect.perform(ctx);
      throw new Error('SIGKILL: the command landed and markDone never ran');
    },
  };
}

suite('shell `pure`: the cost of recovery is time (AC4)', () => {
  it('reconciles not-started and re-runs the command', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    const log = join(tmp, 'ran.log');
    await makeRepo({ dir: repo });

    const first = openRunner(tmp);
    try {
      await first.runner
        .durable(killedAfterPerform(migrateEffect(repo, log, 'pure')))
        .catch(() => undefined);
      expect(await ranCount(log)).toBe(1);
    } finally {
      first.db.close();
    }

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      await second.runner.durable(migrateEffect(repo, log, 'pure'));

      // Twice on purpose. A test that re-runs is the *correct* behaviour for a
      // pure command, and pretending otherwise is how a `mutating` one ends up
      // classified `pure`.
      expect(await ranCount(log)).toBe(2);
      expect(eventsOf(second.db, 'effect.completed')[0]).toMatchObject({ reconciled: false });
    } finally {
      second.db.close();
    }
  });
});

suite('shell `mutating`: the before-hash is journalled before perform (AC5)', () => {
  it('is on the pending row before the command is spawned', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    const log = join(tmp, 'ran.log');
    await makeRepo({ dir: repo });
    const clean = await porcelainHash(await porcelain(repo)());

    const { db, runner } = openRunner(tmp);
    try {
      let atSpawn: string | null = null;
      await runner.durable({
        ...migrateEffect(repo, log, 'mutating'),
        async perform(ctx: EffectCtx): Promise<ShellResult> {
          const base = migrateEffect(repo, log, 'mutating');
          const result = await base.perform({
            ...ctx,
            // Observed at the instant the scaffold is taken, from a *second*
            // read of the row: what matters is that it is durable, not that
            // the effect remembers writing it.
            scaffold: (value: unknown) => {
              ctx.scaffold(value);
              atSpawn ??= readEffect(db, IKEY)?.resultJson ?? null;
            },
          });
          return result;
        },
      });

      expect(JSON.parse(atSpawn ?? 'null')).toEqual({
        kind: 'shell.mutating',
        before: clean,
        after: null,
        result: null,
      });
    } finally {
      db.close();
    }
  });

  it('matches the BEFORE hash after a crash before the command ⇒ not-started', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    const log = join(tmp, 'ran.log');
    await makeRepo({ dir: repo });

    const first = openRunner(tmp);
    try {
      // The scaffold is written, then the spawn fails: the world is untouched.
      await first.runner
        .durable(
          shellEffect(
            {
              runId: RUN,
              nodeId: NODE,
              attempt: 0,
              ordinal: 0,
              requestHash: HASH,
              classification: 'mutating',
            },
            {
              run: () => Promise.reject(new Error('SIGKILL: before the command')),
              porcelain: porcelain(repo),
            },
          ),
        )
        .catch(() => undefined);
    } finally {
      first.db.close();
    }

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const result = await second.runner.durable(migrateEffect(repo, log, 'mutating'));

      expect(result.exitCode).toBe(0);
      expect(await ranCount(log)).toBe(1);
      expect(eventsOf(second.db, 'effect.completed')[0]).toMatchObject({ reconciled: false });
    } finally {
      second.db.close();
    }
  });

  it('matches the AFTER hash after a crash inside the window ⇒ done, and never re-runs', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    const log = join(tmp, 'ran.log');
    await makeRepo({ dir: repo });

    const first = openRunner(tmp);
    try {
      await first.runner
        .durable(killedAfterPerform(migrateEffect(repo, log, 'mutating')))
        .catch(() => undefined);
      expect(await ranCount(log)).toBe(1);
      expect(readEffect(first.db, IKEY)?.state).toBe('pending');
    } finally {
      first.db.close();
    }

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const result = await second.runner.durable(migrateEffect(repo, log, 'mutating'));

      // The memoised result came out of the scaffold, and the migration ran
      // exactly once across two daemon lives.
      expect(result).toMatchObject({ exitCode: 0 });
      expect(await ranCount(log)).toBe(1);
      expect(eventsOf(second.db, 'effect.completed')[0]).toMatchObject({ reconciled: true });
      expect(readEffect(second.db, IKEY)?.state).toBe('done');
    } finally {
      second.db.close();
    }
  });
});

/** A minimal running plan: the mutating node, and one node behind it. */
function runningPlan(repo: string): EventDraft[] {
  const node = (id: string, deps: readonly string[]): Record<string, unknown> => ({
    id,
    title: `do ${id}`,
    type: 'agent',
    deps: [...deps],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    brief: `brief for ${id}`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'always-replay',
  });

  const draft = (kind: string, payload: unknown): EventDraft => ({
    runId: RUN,
    ts: DAEMON_STARTED_AT,
    kind,
    v: 1,
    epoch: 1,
    payload,
  });

  return [
    draft('run.created', {
      spec: JSON.parse(
        // The real spec fixture the other suites fold, so `run.created`
        // validates against the same schema production writes.
        readFileSyncText(),
      ),
      cwd: repo,
      repo: { head: 'e83c516', branch: 'main' },
    }),
    draft('plan.proposed', {
      version: 1,
      planHash: PLAN_HASH,
      graph: {
        schemaId: 'DeFlow.plangraph.v1',
        runId: RUN,
        version: 1,
        planHash: PLAN_HASH,
        parent: null,
        taskSpecHash: `sha256-${'c'.repeat(64)}`,
        createdBy: 'planner',
        createdAt: '2026-08-05T14:11:33.000Z',
        nodes: [node(NODE, []), node(DOWNSTREAM, [NODE])],
        edges: [{ from: NODE, to: DOWNSTREAM, kind: 'control' }],
      },
      by: 'planner',
    }),
    draft('run.started', { planHash: PLAN_HASH }),
  ];
}

/** The real TaskSpec fixture, so `run.created` validates against the same
 * schema production writes rather than a hand-rolled shape. */
function readFileSyncText(): string {
  return readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  );
}

suite('reconcile returns unknown and nothing moves (EPIC-06-S15, AC6, AC9, AC10)', () => {
  it('escalates with evidence and never auto-retries the command', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    const log = join(tmp, 'ran.log');
    await makeRepo({ dir: repo });

    const first = openRunner(tmp);
    try {
      appendEvents(first.db, runningPlan(repo));
      await first.runner
        .durable(killedAfterPerform(migrateEffect(repo, log, 'mutating')))
        .catch(() => undefined);
    } finally {
      first.db.close();
    }

    // The world moved again while the daemon was dead — a half-applied
    // migration, a colleague's edit, a rollback script. The probe cannot tell
    // which, and that is the point.
    await writeFile(join(repo, 'unrelated.txt'), 'somebody else was here\n');

    const second = openRunner(tmp, DAEMON_STARTED_AT + 100_000);
    try {
      const thrown = await second.runner
        .durable(migrateEffect(repo, log, 'mutating'))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(EffectNeedsReconciliation);
      // The command was NOT run again.
      expect(await ranCount(log)).toBe(1);
      // And the row is still pending: only a human's answer can close it.
      expect(readEffect(second.db, IKEY)?.state).toBe('pending');

      const needsHuman = eventsOf(second.db, 'run.needs_human');
      expect(needsHuman).toHaveLength(1);
      expect(needsHuman[0]).toMatchObject({ reason: 'reconcile-unknown' });

      const failed = eventsOf(second.db, 'node.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        node: NODE,
        attempt: 0,
        failure: { reason: 'effect.reconcile-unknown', class: 'gate' },
      });

      // AC10: evidence, not a message. All three hashes, and they differ.
      const detail = (failed[0] as { failure: { detail: Record<string, string> } }).failure.detail;
      expect(detail).toMatchObject({ ikey: IKEY, kind: 'shell', requestHash: HASH });
      expect(new Set([detail.before, detail.after, detail.observed]).size).toBe(3);

      // AC6 / EPIC-06-S15: nothing moves until a human decides. Not on the
      // next tick, not on the thousandth, not six hours later.
      const state = replayRun(second.db, RUN).state;
      expect(state.status).toBe('needs-human');
      for (let tick = 0; tick < 1000; tick += 1) {
        const commands = decide(state, DAEMON_STARTED_AT + tick * 1000);
        expect(commands.filter((command) => command.kind === 'StartNode')).toEqual([]);
      }
      const sixHoursLater = DAEMON_STARTED_AT + 6 * 60 * 60 * 1000;
      expect(decide(state, sixHoursLater).filter((c) => c.kind === 'StartNode')).toEqual([]);
    } finally {
      second.db.close();
    }
  });
});
