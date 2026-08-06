#!/usr/bin/env node
/**
 * A fake package manager on a temp PATH (docs/14-testing-strategy.md §3.3).
 *
 * A **real executable**, symlinked as `pnpm` / `npm` / `yarn`, so that EPIC-07's
 * setup layer is exercised through a real `/bin/sh -c "pnpm install …"` — argv
 * splitting, PATH lookup, stream framing, exit codes and all. Mocking
 * `child_process` would test the mock; every one of those is on the far side of
 * the boundary.
 *
 * It is driven entirely by the environment, because the command DeFlow runs is
 * the *user's* string and the shim must not need to be told anything through it:
 *
 * - `DeFlow_PM_LOG`    — file to append one JSON line to per invocation.
 * - `DeFlow_PM_EXIT`   — exit code. Defaults to 0.
 * - `DeFlow_PM_STDERR` — a line to write to stderr before exiting.
 *
 * On a zero exit it creates a real `node_modules/` in its working directory,
 * which is what makes "each worktree's node_modules is a real directory after
 * provisioning" (EPIC-07-S20) an assertion about a directory rather than about
 * a log line.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const cwd = process.cwd();

const log = process.env.DeFlow_PM_LOG;
if (log !== undefined && log !== '') {
  appendFileSync(log, `${JSON.stringify({ name: process.argv[1], argv, cwd })}\n`);
}

const exitCode = Number.parseInt(process.env.DeFlow_PM_EXIT ?? '0', 10);
const stderrLine = process.env.DeFlow_PM_STDERR;

process.stdout.write(`fake package manager: ${argv.join(' ')}\n`);
if (stderrLine !== undefined && stderrLine !== '') process.stderr.write(`${stderrLine}\n`);

if (exitCode === 0) {
  const modules = join(cwd, 'node_modules');
  mkdirSync(join(modules, '.fake'), { recursive: true });
  writeFileSync(join(modules, '.fake', 'installed'), `${argv.join(' ')}\n`);
}

process.exit(exitCode);
