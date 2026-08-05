/**
 * The harness side of the scripted run: start it, watch which phase it is in,
 * and hand the spec a handle it can `kill -9` (EPIC-03-S26).
 *
 * The phase is published to a file rather than to stdout because the reader is
 * a *parent polling a process it is about to SIGKILL*: a line still sitting in
 * a pipe buffer when the signal lands is a line that never existed, and the
 * harness would then kill during a window it thinks it has already left.
 * `writeFileSync` has returned only once the bytes reached the file.
 */
import { type Crashable, startCrashable } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

/** The run every iteration of the suite writes. @see ./worker.ts */
export const FUZZ_RUN = 'run_20260805T091500Z_c7a3d1';

/** Nodes in the scripted run. Kept in step with the worker's default. */
export const FUZZ_NODES = 6;

/**
 * How long a restarted run may take before the suite calls it wedged.
 *
 * Generous on purpose — it is not a performance budget, it is the line between
 * "slow" and "never". EPIC-03-S26 is explicit that a wedge is a failure rather
 * than a timeout, and this number is what turns one into the other.
 */
export const WEDGE_BUDGET_MS = 60_000;

export interface ScriptedRunOptions {
  /** The `.DeFlow/` directory. Reused across the crash and the restart. */
  readonly dataDir: string;
  /** Absolute path to the linked fake agent binary. */
  readonly agent: string;
  /** Where every invocation appends `{runId,nodeId,attempt,idempotencyKey}`. */
  readonly sideEffects: string;
  /** Where the run appends its projection after every committed event. */
  readonly projections: string;
  readonly seed: number;
  readonly nodes?: number;
}

export interface ScriptedRun {
  readonly child: Crashable;
  /** The phase marker the run last published; `''` before the first one. */
  phase(): string;
  /** True once the child process has gone, however it went. */
  settled(): boolean;
}

export function startScriptedRun(options: ScriptedRunOptions): ScriptedRun {
  const phaseFile = join(options.dataDir, 'phase.txt');

  const child = startCrashable({
    script: WORKER,
    env: {
      ...process.env,
      DeFlow_FUZZ_DATA_DIR: options.dataDir,
      DeFlow_FUZZ_AGENT: options.agent,
      DeFlow_FUZZ_SIDE_EFFECTS: options.sideEffects,
      DeFlow_FUZZ_PROJECTIONS: options.projections,
      DeFlow_FUZZ_PHASE: phaseFile,
      DeFlow_FUZZ_SEED: String(options.seed),
      DeFlow_FUZZ_NODES: String(options.nodes ?? FUZZ_NODES),
    },
  });

  let settled = false;
  void child.exited.then(() => {
    settled = true;
  });

  return {
    child,
    phase: () => (existsSync(phaseFile) ? readFileSync(phaseFile, 'utf8') : ''),
    settled: () => settled,
  };
}
