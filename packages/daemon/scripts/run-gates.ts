/**
 * Runs one seeded run to settle, with the gate performer, in its own process.
 *
 * This is DeFlowd's executor and gate path — `executeRun` + `gateNodePerformer`
 * — behind a `main()` that takes a data directory and a worktree. It exists
 * because the run *has* to be a separate process for `e2e/` to be an e2e at
 * all: `@DeFlow/daemon` is a leaf (repo layout R2) and `e2e/` may not import
 * it, and a run driven inside the spec's own process would be an integration
 * test with an e2e's name on it.
 *
 * It holds no policy of its own. Gate definitions come from
 * `<worktree>/.DeFlow/gates/*.yaml` through KAR-12.6's discovery — hashed
 * bytes, the same ones the run manifest records — and which gate judges which
 * node comes from the plan, not from here.
 *
 * Usage: `node packages/daemon/scripts/run-gates.ts <dataDir> <worktree> <runId>`
 */
import { type NodeId, type RunId, RunIdSchema, seededRandom } from '@DeFlow/core';
import { discoverGateDefinitions, type GateDefinition } from '@DeFlow/gates';
import { openLedger, replayRun } from '@DeFlow/ledger';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { systemClock } from '../src/clock.ts';
import { createEffectRunner } from '../src/effects/durable.ts';
import { executeRun } from '../src/exec/run-executor.ts';
import { gateNodePerformer } from '../src/gates/gate-performer.ts';

export interface RunGatesOptions {
  readonly dataDir: string;
  /** The worktree the gates run in, and where `.DeFlow/gates/` is read from. */
  readonly worktree: string;
  readonly runId: RunId;
  readonly epoch?: number;
}

/**
 * Runs the plan until it settles, and returns the run's final status.
 *
 * Exported so a spec can drive it in-process when what it is testing is the
 * loop rather than the process boundary; `e2e/` spawns the module instead.
 */
export async function runGates(options: RunGatesOptions): Promise<string> {
  const discovered = await discoverGateDefinitions({
    gatesDir: join(options.worktree, '.DeFlow', 'gates'),
  });
  const byGateId = new Map<string, GateDefinition>(
    discovered.map((gate) => [gate.definition.id, gate.definition]),
  );
  const shaByGateId = new Map<string, string>(
    discovered.map((gate) => [gate.definition.id, gate.sha256]),
  );

  const db = openLedger(options.dataDir);
  const clock = systemClock;
  const epoch = options.epoch ?? 1;
  const startedAt = clock.now();

  try {
    const { state } = replayRun(db, options.runId);
    const specHash = state.specApproved?.specHash ?? '';

    await executeRun({
      db,
      runId: options.runId,
      clock,
      epoch,
      daemonStartedAt: startedAt,
      random: seededRandom(1),
      effects: createEffectRunner({ db, clock, daemonStartedAt: startedAt, epoch }),
      perform: gateNodePerformer({
        dataDir: options.dataDir,
        scrubbedEnv: [],
        resolve: (node, current) => {
          const planned = current.plan?.nodes.find((entry) => entry.id === node);
          if (planned === undefined || planned.type !== 'gate') return null;
          if (planned.gate.kind !== 'deterministic') return null;
          const definition = byGateId.get(planned.gate.gateId);
          if (definition === undefined) return null;
          const sha = shaByGateId.get(planned.gate.gateId);
          return {
            definition,
            worktree: options.worktree,
            repoRoot: options.worktree,
            // Whose work this gate judges: its first control dependency, which
            // is what the plan says and what the verdict has to name.
            evaluatedNode: (planned.deps[0] ?? planned.id) as NodeId,
            specHash: current.specApproved?.specHash ?? specHash,
            ...(sha === undefined ? {} : { definitionSha256: sha }),
          };
        },
      }),
      // Real ticks against real child processes; the clock is the system one,
      // so nothing here advances it.
      tickStepMs: 0,
      tickMs: 20,
      // A ref'd timer: in this process the loop is the only work there is, and
      // `systemClock`'s deliberately unref'd default would let Node decide the
      // run had finished and exit between two ticks.
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
      budgetMs: 120_000,
    });

    return replayRun(db, options.runId).state.status;
  } finally {
    db.close();
  }
}

// Run only when invoked as a script, exactly as `build-compaction-fixture.ts`
// guards itself: an import that drove a run as a side effect would make a
// passing spec indistinguishable from one that had just executed a plan.
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    process.stderr.write('usage: run-gates.ts <dataDir> <worktree> <runId>\n');
    process.exit(64);
  }
  const status = await runGates({
    dataDir: args[0],
    worktree: args[1],
    runId: RunIdSchema.parse(args[2]),
  });
  process.stdout.write(`${status}\n`);
}
