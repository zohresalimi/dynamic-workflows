#!/usr/bin/env node
/**
 * The `DeFlow-mcp` executable — the published package's second bin.
 *
 * It is never run by a person. DeFlowd names it in the `mcpServers` entry of
 * every `session/new`, and the agent spawns it (docs/07 §7.2).
 *
 * The behaviour is `@DeFlow/daemon`'s `runMcpShim`, and inside the workspace
 * `packages/daemon/bin/DeFlow-mcp.ts` is the file that runs. This one exists so
 * that the *tarball* has the same bin — one that resolves without a
 * `packages/` directory, because tsdown has inlined the shim into it.
 */
import { runMcpShim } from '@DeFlow/daemon';
import process from 'node:process';

const code = await runMcpShim({
  argv: process.argv.slice(2),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exit(code);
