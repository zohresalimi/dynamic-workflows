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
import { runDoctor } from './doctor/run.ts';
import { runInit } from './index.ts';
import { runRun } from './run/run.ts';
import { parseUpArgs, runUp, type StartedUp } from './up.ts';

/** sysexits(3) `EX_USAGE`, the same code the MCP shim uses for a bad argv. */
const EX_USAGE = 64;

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
  doctor          Report what this machine can do, and what it cannot

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

Options for "doctor":
  --json          Emit one machine-readable document instead of the report
  --skip-conformance
                  Skip the F3.4 battery, which spawns a real turn per
                  assertion per installed adapter. The section then reports
                  that it did not run, which is not the same as passing.

Options:
  -h, --help      Print this message
  -v, --version   Print the version

Exit codes for "doctor": 0 when every check is ok or warn, 5 when any check
fails. Nothing else, so CI can branch on it without a table.
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
  const unknown = argv.filter((flag) => flag !== '--json' && flag !== '--skip-conformance');
  if (unknown.length > 0) {
    process.stderr.write(`DeFlow doctor: unknown option "${unknown[0]}"\n\n${USAGE}`);
    return EX_USAGE;
  }

  const result = await runDoctor({
    cwd: process.cwd(),
    env: process.env,
    json: argv.includes('--json'),
    conformance: !argv.includes('--skip-conformance'),
  });

  process.stdout.write(result.stdout);
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

  if (command === 'run') {
    return runRun({
      argv: argv.slice(1),
      cwd: process.cwd(),
      env: process.env,
      stdout: (chunk) => process.stdout.write(chunk),
      stderr: (chunk) => process.stderr.write(chunk),
      // Read per line rather than captured here, which is what keeps colour
      // out of a pipe even when the command was started from a terminal.
      isTty: () => process.stdout.isTTY === true,
    });
  }

  if (command === 'init') {
    const result = await runInit({ cwd: process.cwd() });
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
