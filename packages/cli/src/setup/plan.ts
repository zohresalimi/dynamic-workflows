/**
 * KAR-20.2 — the decisions `deflow setup` makes, separated from the machine it
 * makes them about.
 *
 * Everything here is a pure function over a described machine: which profile
 * file this operator's shell reads, what line to put in it, what `PATH` their
 * *next* shell will have, whether a string is a version, and what exit code a
 * set of step results adds up to. Nothing in this file opens, spawns or writes
 * anything — which is what makes `win32` and `fish` assertable from a macOS
 * laptop, and is why the Windows refusal (AC13) can be proven to happen
 * *before* any filesystem access rather than merely believed to.
 *
 * The one design rule the whole story is built around lives here in
 * `freshShellPath`: **the PATH this process can see is not the PATH the
 * operator's next terminal will have.** `npx deflowai setup` runs with the npx
 * cache's `node_modules/.bin` prepended, so `deflow` resolves inside this very
 * process no matter what the install did. Verifying against that would print a
 * green tick over the exact failure of 2026-08-12 — a link command that exited
 * 0 and produced no usable command.
 *
 * Verifies: EPIC-20-S18 (the exit-code invariant), EPIC-20-S23, EPIC-20-S24
 * (the Windows half) · AC3, AC7, AC8, AC13
 */
import { basename, delimiter, join } from 'node:path';
import { COMMAND } from '../command-name.ts';
import type { ReportState } from '../render/report.ts';

/** The five steps, in the fixed order AC2 pins them to. */
export const SETUP_STEPS = ['install', 'link', 'verify', 'doctor', 'adapters'] as const;

export type SetupStepId = (typeof SETUP_STEPS)[number];

/** One step's outcome — a row in the report, and an entry in `--json`. */
export interface SetupStep {
  readonly id: SetupStepId;
  readonly state: ReportState;
  /** Why it is that state. Never empty, including for the passing ones. */
  readonly detail: string;
  /** The one command to run when this step is the worst thing in the report. */
  readonly action?: string;
  /** Structured extras for `--json`: resolved directories, exit codes, paths. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** The shells AC7 handles by name. Everything else is `unknown`, and is told. */
export type ShellKind = 'zsh' | 'bash' | 'fish' | 'unknown';

/**
 * The shell's *name*, not its path.
 *
 * `/opt/homebrew/bin/zsh`, `/bin/zsh` and `/usr/local/bin/zsh` are one shell
 * with three installations, and a mapping keyed on the whole string would send
 * a Homebrew zsh user down the unknown branch on the machine this story was
 * written on.
 */
export function shellKind(shell: string | undefined): ShellKind {
  const name = shell === undefined || shell === '' ? '' : basename(shell);
  if (name === 'zsh') return 'zsh';
  if (name === 'bash') return 'bash';
  if (name === 'fish') return 'fish';
  return 'unknown';
}

export interface ProfileTarget {
  readonly kind: ShellKind;
  /** The absolute path of the file to append to, or `null` when we do not know
   * which file this shell reads — in which case nothing is written (AC7). */
  readonly file: string | null;
  /** The exact line, in that shell's own syntax. Printed whether or not it is
   * ever written. */
  readonly line: string;
}

export interface ProfileTargetInput {
  /** `$SHELL`, as the operator's environment carries it. */
  readonly shell: string | undefined;
  readonly platform: NodeJS.Platform;
  /** `$HOME`. Read from the environment rather than from the process, so that
   * a fake home is a staged fact and AR-1's "no home of its own" holds. */
  readonly home: string;
  readonly binDir: string;
}

/**
 * Which file, and which line.
 *
 * `bash` is the only row that differs by platform, and it differs for a real
 * reason rather than for tidiness: macOS's Terminal.app starts a **login**
 * shell for every window, which reads `~/.bash_profile` and not `~/.bashrc`,
 * while a Linux terminal emulator starts an interactive non-login shell and
 * reads the opposite one. One hardcoded answer is wrong on one of the two
 * platforms this milestone targets.
 *
 * `fish` gets `fish_add_path` rather than an `export`, because `export PATH=…`
 * is not fish syntax and a line that errors on every new terminal the operator
 * opens is a worse outcome than doing nothing (EPIC-20-S23's note).
 */
export function profileTarget(input: ProfileTargetInput): ProfileTarget {
  const kind = shellKind(input.shell);
  const posix = `export PATH="${input.binDir}:$PATH"`;

  if (kind === 'fish') {
    return {
      kind,
      file: join(input.home, '.config/fish/config.fish'),
      line: `fish_add_path ${input.binDir}`,
    };
  }
  if (kind === 'zsh') return { kind, file: join(input.home, '.zshrc'), line: posix };
  if (kind === 'bash') {
    return {
      kind,
      file: join(input.home, input.platform === 'darwin' ? '.bash_profile' : '.bashrc'),
      line: posix,
    };
  }
  // AC7 — an unrecognised shell is told, not guessed at. The line is still
  // printed: an operator handed neither the directory nor the syntax has been
  // given a puzzle rather than an answer.
  return { kind, file: null, line: posix };
}

/**
 * A `PATH` entry that exists only because *this* process was started by `npx`
 * or by a package manager's run script, and which the operator's next terminal
 * will not have.
 *
 * Both shapes are npm's own: `npx` resolves its target through
 * `<cache>/_npx/<hash>/node_modules/.bin`, and `npm run` / `pnpm run` prepend
 * the workspace's `node_modules/.bin`.
 */
function isEphemeral(entry: string): boolean {
  return /(?:^|[/\\])node_modules[/\\]\.bin[/\\]?$/.test(entry) || /[/\\]_npx[/\\]/.test(entry);
}

export interface FreshShellPathInput {
  /** `$PATH` as this process received it. */
  readonly envPath: string;
  /** Directories the operator's profile now provides, prepended in order. */
  readonly add: readonly string[];
}

/**
 * The `PATH` a shell opened after this command would resolve against.
 *
 * This is the whole of AC3's "in a shell resolving the same PATH a fresh login
 * shell would". Two operations, and each one is load-bearing:
 *
 *  - **drop the ephemeral entries**, so a `deflow` that resolves only because
 *    npx put it there cannot satisfy the verification;
 *  - **add what the profile now provides**, so a run that has just appended a
 *    line verifies against the machine as it will be, not as it was.
 */
export function freshShellPath(input: FreshShellPathInput): string {
  const inherited = input.envPath
    .split(delimiter)
    .filter((entry) => entry !== '' && !isEphemeral(entry));

  const seen = new Set<string>();
  return [...input.add, ...inherited]
    .filter((entry) => entry !== '' && !seen.has(entry) && (seen.add(entry), true))
    .join(delimiter);
}

/** A semver-shaped version, the shape `deflow --version` prints and nothing else. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * The version `deflow --version` printed, or `null`.
 *
 * The **last** non-empty line, because the verification runs through a shell
 * that may have printed the resolved path first, and because a warning on
 * stdout ahead of the answer must not turn a good install into a failed one.
 * `null` is a `fail` at the call site: a binary that exits 0 and prints
 * something unreadable has not been verified, it has merely not complained.
 */
export function parseVersion(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  return VERSION.test(last) ? last : null;
}

/**
 * AC8's invariant, as one function: **a report with a `fail` never exits 0.**
 *
 * `warn` and `skipped` do not reach the exit code, which is AC9's other half —
 * a machine that installed correctly and has a degraded sandbox is a successful
 * install with a warning, and returning `doctor`'s own 5 from here would call
 * it a failure.
 */
export function exitCodeFor(steps: readonly SetupStep[]): number {
  return steps.some((step) => step.state === 'fail') ? 1 : 0;
}

/**
 * AC13 — the one sentence Windows gets, before anything is read or written.
 *
 * NF5 defers Windows to M3 and docs/03 §1 says what to do instead. Saying so
 * in one line is cheaper for everybody than half-working there: a POSIX profile
 * path, a `chmod`, and a `PATH` joined on `:` are each wrong on that platform
 * in a way that would leave a machine worse than it started.
 */
export function windowsRefusal(): string {
  return (
    `${COMMAND} setup: Windows is not supported until M3 (NF5) — use WSL2 and run this command ` +
    'inside it, following the Linux instructions in docs/03-local-development.md §1.\n'
  );
}
