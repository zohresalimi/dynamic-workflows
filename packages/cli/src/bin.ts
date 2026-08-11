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
 * `run` and `doctor` are deliberately absent: they are KAR-18.3 and KAR-18.4,
 * and a usage line advertising a command that does not exist is worse than one
 * that does not mention it. What this file settles is the *packaging* claim —
 * that there is a real, executable, single-file `DeFlow` in the tarball with
 * the whole daemon inlined behind it.
 *
 * `up` (KAR-18.2) is the one command here that does not return: it starts a
 * daemon and then waits for a signal. The waiting is this file's job, because
 * "how the process ends" is a property of the process rather than of the
 * command — `runUp` hands back a `stop()` and stays testable without one.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runInit } from './index.ts';
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

Options for "up":
  --port <n>      Bind this port instead of 7777, or fail if it is taken
  --no-open       Print the URL without launching a browser
  --timings       Print per-step milliseconds for the eight boot steps

Options:
  -h, --help      Print this message
  -v, --version   Print the version
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
