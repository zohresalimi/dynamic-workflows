#!/usr/bin/env node
/**
 * The `deflow-mcp` executable — the second bin of the published `DeFlow`
 * package (docs/07-provider-adapter-layer.md §7.2).
 *
 * It is never run by a person. DeFlowd names it in the `mcpServers` entry of
 * every `session/new`, with `command` set to `process.execPath` so the shim
 * runs on the same Node as the daemon whose socket it is about to open, and
 * the agent spawns it as part of setting up its own tool loop.
 *
 * Nothing lives here but wiring: argv, the three standard streams and the exit
 * code. `src/mcp/shim.ts` is the part with behaviour, so it can be exercised
 * without a process — though every spec that matters spawns this file for
 * real, because "the shim exits when its stdin closes" is not a claim about a
 * function.
 */
import process from 'node:process';
import { runMcpShim } from '../src/mcp/shim.ts';

const code = await runMcpShim({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exit(code);
