/**
 * Starting one daemon life and watching which phase it is in, so the harness
 * can put the knife somewhere specific (EPIC-06-S29).
 *
 * The phase is published to a file rather than to stdout because the reader is
 * a *parent polling a process it is about to SIGKILL*: a line still sitting in
 * a pipe buffer when the signal lands is a line that never existed, and the
 * harness would then kill during a window it thinks it has already left.
 */
import { type Crashable, startCrashable } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.ts', import.meta.url));

/**
 * How long a restarted run may take before the suite calls it wedged.
 *
 * Generous on purpose — it is not a performance budget, it is the line between
 * "slow" and "never". A wedge is a failure rather than a timeout, and this
 * number is what turns one into the other.
 */
export const WEDGE_BUDGET_MS = 120_000;

export interface DaemonLifeOptions {
  readonly dataDir: string;
  readonly agent: string;
  readonly sideEffects: string;
  readonly projections: string;
  readonly seed: number;
  readonly settleMs?: number;
}

export interface DaemonLife {
  readonly child: Crashable;
  /** The phase marker the life last published; `''` before the first one. */
  phase(): string;
  /** True once the child process has gone, however it went. */
  settled(): boolean;
}

export function startDaemonLife(options: DaemonLifeOptions): DaemonLife {
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
      ...(options.settleMs === undefined
        ? {}
        : { DeFlow_FUZZ_SETTLE_MS: String(options.settleMs) }),
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
