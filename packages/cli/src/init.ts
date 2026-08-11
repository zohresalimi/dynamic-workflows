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

export interface InitCommandOptions {
  /** The directory the operator ran `DeFlow init` from. */
  readonly cwd: string;
  /** Defaults to `process.env` — `PATH` and `XDG_DATA_HOME`/`DeFlow_DATA_DIR`
   * both come from here. */
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
}

export interface InitCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function renderPaths(paths: InitReport['paths']): string {
  return paths.map((path) => `  ${path.relativePath}  ${path.status}`).join('\n');
}

function renderProviders(providers: InitReport['providers']): string {
  if (providers.length === 0) return '  (no providers registered)';
  return providers.map((provider) => `  ${provider.provider}: ${provider.detail}`).join('\n');
}

function renderReport(report: InitReport): string {
  return (
    `DeFlow init: workspace ready at ${report.repoRoot}\n` +
    `${renderPaths(report.paths)}\n` +
    `global state directory: ${report.dataDir}\n` +
    'providers:\n' +
    `${renderProviders(report.providers)}\n`
  );
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
    return { exitCode: 0, stdout: renderReport(report), stderr: '' };
  } catch (error) {
    if (error instanceof NotAGitWorkingTree || error instanceof DataDirUnwritable) {
      return { exitCode: INIT_EX_REFUSED, stdout: '', stderr: `${error.message}\n` };
    }
    throw error;
  }
}
