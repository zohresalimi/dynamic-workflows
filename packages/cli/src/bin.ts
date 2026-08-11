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
 * `up`, `run` and `doctor` are deliberately absent: they are KAR-18.2, KAR-18.3
 * and KAR-18.4, and a usage line advertising a command that does not exist is
 * worse than one that does not mention it. What this file settles is the
 * *packaging* claim — that there is a real, executable, single-file `DeFlow` in
 * the tarball with the whole daemon inlined behind it.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { runInit } from './index.ts';

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

Options:
  -h, --help      Print this message
  -v, --version   Print the version
`;

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
