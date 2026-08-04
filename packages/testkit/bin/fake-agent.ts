#!/usr/bin/env node
/**
 * The fake exec-shim agent (docs/14-testing-strategy.md §3.2).
 *
 * A **real executable**, symlinked onto a temp PATH — never a mocked
 * `child_process`. Mocking the process boundary would test the mock: the spawn
 * logic, the argv construction, the stream parser, the backpressure handling,
 * the timeout and the kill path are all on the other side of it.
 *
 * KAR-01.4 gives it the minimum EPIC-01 needs to prove the fixture works. The
 * full F3.4 conformance vocabulary — scripted chunks with delays, stream-json
 * envelopes, malformed JSON, exit-without-output, hang forever, ignore SIGTERM,
 * a single 10 MB line — is EPIC-04/EPIC-05's, and belongs here.
 *
 * Scenario is read from the environment so the binary's own argv stays exactly
 * whatever the code under test passed it:
 *   DeFlow_FAKE_LOG        append one NDJSON line per invocation to this file
 *   DeFlow_FAKE_EXIT_CODE  exit with this code instead of 0
 *   DeFlow_FAKE_STDERR     write this to stderr before exiting
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const invocation = {
  argv: process.argv.slice(2),
  invokedAs: process.argv[1],
  cwd: process.cwd(),
  pid: process.pid,
};

const log = process.env.DeFlow_FAKE_LOG;
if (log !== undefined && log !== '') appendFileSync(log, `${JSON.stringify(invocation)}\n`);

const stderr = process.env.DeFlow_FAKE_STDERR;
if (stderr !== undefined && stderr !== '') process.stderr.write(stderr);

process.stdout.write(`${JSON.stringify(invocation)}\n`);

const exitCode = Number.parseInt(process.env.DeFlow_FAKE_EXIT_CODE ?? '0', 10);
process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
