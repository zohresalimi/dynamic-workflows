#!/usr/bin/env node
/**
 * The `DeFlow` executable — the first of the published package's three bins.
 *
 * The shebang is not decoration: it is the first line tsdown copies to
 * `dist/bin.mjs`, and `packages/cli/scripts/build.ts` sets the exec bit on the
 * emitted file. Lose either and `npx DeFlow` fails with a shell syntax error
 * that names none of this (AC6).
 *
 * Nothing here has behaviour. Argv in, exit code out, and every command body
 * lives behind `./index.ts` so it can be tested without a process — the same
 * split `packages/daemon/bin/DeFlow-mcp.ts` and `packages/mock-agent/bin/
 * mock-agent.ts` already use.
 *
 * `up` (KAR-18.2) is the one command here that does not return: it starts a
 * daemon and then waits for a signal. The waiting is this file's job, because
 * "how the process ends" is a property of the process rather than of the
 * command — `runUp` hands back a `stop()` and stays testable without one.
 *
 * `run` (KAR-18.3) owns its own signal handling instead, and that is not an
 * inconsistency: `up`'s Ctrl-C means "stop the daemon" and `run`'s means
 * "detach, unless you say it twice", which is a decision about the *run* rather
 * than about the process. It is registered inside `runRun` so that the
 * three-second window and the sentence it prints can be tested without a
 * process at all.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runAnswer } from './answer.ts';
import { runCancel } from './cancel.ts';
import { runDoctor } from './doctor/run.ts';
import { runInit } from './index.ts';
import { parseLedgerArgs, runLedgerSnapshot } from './ledger-snapshot.ts';
import { processStyle } from './render/style.ts';
import { runRun } from './run/run.ts';
import { parseStatusArgs, runStatus } from './status.ts';
import { parseUpArgs, runUp, type StartedUp } from './up.ts';

/** sysexits(3) `EX_USAGE`, the same code the MCP shim uses for a bad argv. */
const EX_USAGE = 64;

/**
 * KAR-18.9 AC7 — the styling decision, computed **once per process** and
 * passed to every command from here.
 *
 * Here and nowhere else: this is the only place that knows whether stdout is a
 * terminal, how wide it is and what the operator's environment asked for, and
 * a second call site deriving its own is how one forgotten branch writes an
 * escape sequence into somebody's log file. `test/render-guard.test.ts` is the
 * mechanical check that keeps it that way.
 */
const STYLE = processStyle(process.argv.slice(2));

/**
 * `../package.json` from this module, which is the right file in both layouts:
 * `packages/cli/src/bin.ts` and `packages/cli/dist/bin.mjs` are both one
 * directory below the manifest. npm always ships package.json, whatever
 * `files` says.
 */
function version(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
    const declared = manifest.version;
    if (typeof declared === 'string') return declared;
  }
  return '0.0.0';
}

const USAGE = `DeFlow — dynamic multi-agent workflows

Usage: DeFlow <command> [options]

Commands:
  init            Prepare .DeFlow/ in the current git repository
  up              Start the daemon and open the UI
  run             Start a run and watch it, with no browser at all
  answer          Answer a human gate a run is waiting on, with no browser
  cancel          Stop a run, whether or not it ever started
  doctor          Report what this machine can do, and what it cannot
  status          Report the running daemon, or say there is none
  ledger snapshot Copy the ledger to one file, for a bug report

Options for "up":
  --port <n>      Bind this port instead of 7777, or fail if it is taken
  --no-open       Print the URL without launching a browser
  --timings       Print per-step milliseconds for the eight boot steps

Options for "run":
  --file <path>   Take the task from a file in this repository
  --issue <ref>   Take it from a git issue: a URL, or owner/repo#42
  --spec <path>   Take it from a spec document
  --attach <id>   Watch a run that already exists instead of creating one
  --json          One JSON object per line, for a pipe
  --no-wait       Exit 4 on an open human gate instead of waiting for it
  --permission <level>
                  read | worktree | repo | system; worktree by default

Ctrl-C once detaches — the run keeps going and the daemon keeps serving it.
Ctrl-C twice within three seconds cancels the run.

Exit codes for "run": 0 completed with every gate passed, 1 a failed gate or a
failed node, 2 the daemon refused to start, 3 paused on a budget ceiling, 4
waiting on a human gate under --no-wait, 5 this machine cannot host a run, 130
interrupted.

Usage for "cancel":
  DeFlow cancel <runId> [--force]
                  Stop a run. Cooperative by default: the agent is given the
                  chance to flush its transcript first. --force walks
                  session/cancel, SIGTERM, a grace window and SIGKILL, and
                  answers only once the kill is verified — the transcript may
                  be truncated. A run that never started is ended outright, and
                  a run that has already ended is reported and left alone.
  --mode <mode>   cooperative | forceful; the long spelling of --force

Exit codes for "cancel": 0 stopped, or already ended; 1 the daemon refused,
including an unknown run id; 2 no daemon is running.

Usage for "answer":
  deflow answer <runId> --gate <node> --option <id> [--text <text>]
                  Answer the human gate a run has stopped on. The gate and the
                  option are named, never guessed: "deflow run" prints the
                  exact line when the run stops, and "deflow status" names the
                  gate of every run that is waiting.
  --text <text>   A rejection's reason, an inject option's guidance, or a note
                  on any option.

Exit codes for "answer": 0 answered; 1 the daemon refused, including an option
the gate does not offer and a gate that is not open; 2 no daemon is running;
64 the argv was wrong.

Options for "doctor":
  --json          Emit one machine-readable document instead of the report
  --fix           Install the missing ACP adapter for every vendor CLI that is
                  already on your PATH, without asking. Without it, doctor
                  offers once per provider when stdout is a terminal and
                  installs nothing otherwise. One package, one attempt, no
                  retry — and the result is re-checked, not assumed.
  --skip-conformance
                  Skip the F3.4 battery, which spawns a real turn per
                  assertion per installed adapter. The section then reports
                  that it did not run, which is not the same as passing.

Options:
  -h, --help      Print this message
  -v, --version   Print the version
  --no-color      Never emit an ANSI escape, even on a terminal. NO_COLOR in
                  the environment and TERM=dumb do the same; --json never
                  colours whatever else is set.

Exit codes for "doctor": 0 when every check is ok or warn, 5 when any check
fails. Nothing else, so CI can branch on it without a table.

Options for "status":
  --json          One JSON document instead of the report

"status" always exits 0 — it is a query, not an assertion, and "no daemon is
running" is the ordinary answer.

Usage for "ledger":
  DeFlow ledger snapshot <runId> --out <path>
                  One consistent SQLite file, WAL included and no sidecar,
                  inspectable with plain sqlite3 on a machine with no DeFlow.
`;

/**
 * Holds the process open until a signal, then shuts the daemon down and
 * resolves with the exit code.
 *
 * Both handlers are registered before anything is awaited, and the second
 * signal is ignored: a user who presses Ctrl-C twice while a five-second kill
 * grace is running would otherwise re-enter the shutdown and race it.
 */
function runUntilSignalled(started: StartedUp): Promise<number> {
  return new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`\nDeFlow up: ${signal} received, stopping\n`);
      void started.stop().then(
        () => resolve(0),
        (error: unknown) => {
          process.stderr.write(
            `DeFlow up: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          resolve(1);
        },
      );
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

async function up(argv: readonly string[]): Promise<number> {
  const parsed = parseUpArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return EX_USAGE;
  }

  const result = await runUp({
    env: process.env,
    port: parsed.args.port,
    open: parsed.args.open,
    timings: parsed.args.timings,
  });

  if (result.kind === 'refused') {
    process.stderr.write(result.stderr);
    return result.exitCode;
  }

  process.stdout.write(result.stdout);
  return runUntilSignalled(result);
}

/**
 * `DeFlow doctor` (KAR-18.4).
 *
 * The exit code comes straight off the report — `runDoctor` reduced it, and
 * this function does not get to have an opinion. That is the whole of AC10:
 * CI consumes the exit code, humans consume the text, and both come out of one
 * status model.
 */
async function doctor(argv: readonly string[]): Promise<number> {
  const known = new Set(['--json', '--fix', '--skip-conformance', '--no-color']);
  const unknown = argv.filter((flag) => !known.has(flag));
  if (unknown.length > 0) {
    process.stderr.write(`DeFlow doctor: unknown option "${unknown[0]}"\n\n${USAGE}`);
    return EX_USAGE;
  }

  const result = await runDoctor({
    cwd: process.cwd(),
    env: process.env,
    json: argv.includes('--json'),
    fix: argv.includes('--fix'),
    conformance: !argv.includes('--skip-conformance'),
    style: STYLE,
    // Read at call time rather than captured at import, for the same reason
    // `run`'s `isTty` is: a module-level `process.stdout.isTTY` is evaluated
    // once, before anything knows whether this process's stdout is a pipe.
    isTty: () => process.stdout.isTTY === true,
  });

  process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  return result.exitCode;
}

/**
 * `DeFlow status` (KAR-18.7) — and it does not get to fail.
 *
 * The exit code is the command's own, which is always 0: a bad *flag* is a
 * usage error and exits 64, but every answer about the daemon — running, stale,
 * absent — is a successful query.
 */
function status(argv: readonly string[]): number {
  const parsed = parseStatusArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return EX_USAGE;
  }

  const result = runStatus({ env: process.env, json: parsed.args.json, style: STYLE });
  process.stdout.write(result.stdout);
  return result.exitCode;
}

/**
 * `DeFlow answer <runId> --gate <node> --option <id>` (KAR-19.12) — the command
 * the gate announcement tells the operator to run.
 *
 * No usage text on a bad argv beyond the parser's own sentence, for the reason
 * `cancel` gives: printing the whole of `USAGE` for a missing `--option` buries
 * the one line that says what to pass.
 */
async function answer(argv: readonly string[]): Promise<number> {
  const result = await runAnswer({ argv, env: process.env, style: STYLE });
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  return result.exitCode;
}

/** `DeFlow ledger snapshot <runId> --out <path>` (KAR-18.7). */
function ledger(argv: readonly string[]): number {
  const parsed = parseLedgerArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return EX_USAGE;
  }

  const result = runLedgerSnapshot({
    env: process.env,
    cwd: process.cwd(),
    runId: parsed.args.runId,
    out: parsed.args.out,
    style: STYLE,
  });
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  return result.exitCode;
}

/**
 * `DeFlow cancel <runId>` (KAR-19.6) — the command `run`'s own detach sentence
 * has always named.
 *
 * No usage text on a bad argv beyond the parser's own sentence: `cancel` takes
 * one argument and one flag, and printing the whole of `USAGE` for a mistyped
 * mode buries the one line that says which two modes exist.
 */
async function cancel(argv: readonly string[]): Promise<number> {
  const result = await runCancel({ argv, env: process.env, style: STYLE });
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  return result.exitCode;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (command === 'up') return up(argv.slice(1));

  if (command === 'doctor') return doctor(argv.slice(1));

  if (command === 'status') return status(argv.slice(1));

  if (command === 'ledger') return ledger(argv.slice(1));

  if (command === 'cancel') return cancel(argv.slice(1));

  if (command === 'answer') return answer(argv.slice(1));

  if (command === 'run') {
    return runRun({
      argv: argv.slice(1),
      cwd: process.cwd(),
      env: process.env,
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
      // Read per line rather than captured here, which is what keeps colour
      // out of a pipe even when the command was started from a terminal. The
      // width and the charset come from STYLE, which does not change under a
      // live transcript.
      isTty: () => process.stdout.isTTY === true,
      style: STYLE,
    });
  }

  if (command === 'init') {
    const result = await runInit({ cwd: process.cwd(), style: STYLE });
    if (result.stdout !== '') process.stdout.write(result.stdout);
    if (result.stderr !== '') process.stderr.write(result.stderr);
    return result.exitCode;
  }

  process.stderr.write(`DeFlow: unknown command "${command}"\n\n${USAGE}`);
  return EX_USAGE;
}

// Set rather than forced with `process.exit`, so stdout drains before the
// process ends — the same rule the mock agent's bin follows, and for the same
// reason: exiting here truncates whatever is still in the pipe.
process.exitCode = await main(process.argv.slice(2));
