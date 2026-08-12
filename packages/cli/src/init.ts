/**
 * `DeFlow init` (KAR-18.1) — the argv-facing wrapper over `@DeFlow/daemon`'s
 * `initWorkspace`.
 *
 * The `bin` entry and the argv parser that gets an operator's real terminal
 * invocation to this function are KAR-18.5's; until then it is exercised
 * directly, exactly as `runTask` and `approveSpec` above are exercised through
 * their own exported functions rather than through a spawned binary.
 */
import type { Clock } from '@DeFlow/core';
import {
  DataDirUnwritable,
  INIT_EX_REFUSED,
  type InitReport,
  initWorkspace,
  NotAGitWorkingTree,
  systemClock,
} from '@DeFlow/daemon';
import { type Report, type ReportState, renderReport } from './render/report.ts';
import { plainStyle, type Style } from './render/style.ts';

export interface InitCommandOptions {
  /** The directory the operator ran `DeFlow init` from. */
  readonly cwd: string;
  /** Defaults to `process.env` — `PATH` and `XDG_DATA_HOME`/`DeFlow_DATA_DIR`
   * both come from here. */
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  /** KAR-18.9 — the styling decision, computed once by `bin.ts`. */
  readonly style?: Style;
}

export interface InitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A path's disposition as a state (KAR-18.9 AC2).
 *
 * All four are `ok`, and that is the honest reading: `init` is idempotent by
 * design, so *"this was already here and I did not touch it"* is a success and
 * colouring it as anything else would train an operator to ignore the section.
 */
const PATH_STATES: Readonly<Record<InitReport['paths'][number]['status'], ReportState>> = {
  created: 'ok',
  unchanged: 'ok',
  updated: 'ok',
  'kept (edited)': 'ok',
};

/** A provider's detection result as a state. Nothing here is a failure: a
 * machine with no agent CLI is one `init` completes on (KAR-18.1 AC6). */
const PROVIDER_STATES: Readonly<Record<string, ReportState>> = {
  detected: 'ok',
  cached: 'ok',
  'not-installed': 'skipped',
  'probe-failed': 'warn',
};

/** `init`'s own report, as the presentation layer's model (KAR-18.9 AC1). */
export function toReport(report: InitReport): Report {
  return {
    title: `DeFlow init: workspace ready at ${report.repoRoot}`,
    fallbackAction: "run 'DeFlow doctor' for what this machine can and cannot do",
    sections: [
      {
        title: 'Workspace',
        rows: report.paths.map((path) => ({
          id: path.relativePath,
          state: PATH_STATES[path.status],
          detail: path.status,
        })),
      },
      {
        title: 'Global state directory',
        rows: [{ id: 'data dir', state: 'ok', detail: report.dataDir }],
      },
      {
        title: 'Providers',
        rows:
          report.providers.length === 0
            ? [
                {
                  id: 'providers',
                  state: 'skipped',
                  detail: 'no providers are registered in this build',
                },
              ]
            : report.providers.map((provider) => ({
                id: provider.provider,
                state: PROVIDER_STATES[provider.status] ?? 'warn',
                detail: provider.detail,
              })),
      },
    ],
  };
}

/**
 * Runs `initWorkspace` and turns its result — or one of its two typed
 * refusals — into the exit code, stdout and stderr an operator's terminal
 * would see (AC3, AC4, AC5).
 */
export async function runInit(options: InitCommandOptions): Promise<InitCommandResult> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;

  try {
    const report = await initWorkspace(options.cwd, { clock, env });
    return {
      exitCode: 0,
      stdout: renderReport(toReport(report), options.style ?? plainStyle()),
      stderr: '',
    };
  } catch (error) {
    if (error instanceof NotAGitWorkingTree || error instanceof DataDirUnwritable) {
      return { exitCode: INIT_EX_REFUSED, stdout: '', stderr: `${error.message}\n` };
    }
    throw error;
  }
}
