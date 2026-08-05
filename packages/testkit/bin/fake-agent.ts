#!/usr/bin/env node
/**
 * The fake exec-shim agent (docs/14-testing-strategy.md §3.2).
 *
 * A **real executable**, symlinked onto a temp PATH — never a mocked
 * `child_process`. Mocking the process boundary would test the mock: the spawn
 * logic, the argv construction, the stream parser, the backpressure handling,
 * the timeout and the kill path are all on the other side of it.
 *
 * KAR-01.4 gives it the minimum EPIC-01 needs to prove the fixture works.
 * KAR-03.8 adds the two things the crash-fuzz suite cannot be written without:
 * a **side-effect log**, so "this effect was executed twice" is a duplicate-key
 * check on a text file rather than an inference from the journal that is
 * supposed to prevent it, and `--seed`, so everything before the crash is
 * deterministic and the only variable left is where the knife lands.
 *
 * The full F3.4 conformance vocabulary — scripted chunks with delays,
 * stream-json envelopes, malformed JSON, exit-without-output, hang forever,
 * ignore SIGTERM, a single 10 MB line — is EPIC-04/EPIC-05's, and belongs here.
 *
 * Scenario is read from the environment so the binary's own argv stays exactly
 * whatever the code under test passed it — `--seed` is the one exception,
 * because EPIC-03-S26 names it as a flag:
 *   DeFlow_FAKE_LOG               append one NDJSON line per invocation to this file
 *   DeFlow_FAKE_SIDE_EFFECT_LOG   append one {runId,nodeId,attempt,idempotencyKey} per invocation
 *   DeFlow_FAKE_RUN_ID            the run the invocation belongs to
 *   DeFlow_FAKE_NODE_ID           the node
 *   DeFlow_FAKE_ATTEMPT           the attempt index
 *   DeFlow_FAKE_IKEY              the effect's idempotency key
 *   DeFlow_FAKE_EXIT_CODE         exit with this code instead of 0
 *   DeFlow_FAKE_STDERR            write this to stderr before exiting
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { mulberry32 } from '../src/random.ts';

const argv = process.argv.slice(2);

/** `--seed <n>`, the one flag this binary reads out of its own argv. */
function seedFromArgv(): number | null {
  const at = argv.indexOf('--seed');
  if (at < 0) return null;
  const parsed = Number.parseInt(argv[at + 1] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const seed = seedFromArgv();

const invocation = {
  argv,
  invokedAs: process.argv[1],
  cwd: process.cwd(),
  pid: process.pid,
  seed,
  // Derived from the seed and from nothing else. Without one it is null rather
  // than a fresh random number: an unseeded fake that is quietly nondeterministic
  // is worse than one that has no randomness at all.
  nonce: seed === null ? null : mulberry32(seed)(),
};

/**
 * The side-effect log, written **first** and synchronously.
 *
 * First, because this is the record that the effect happened, and an effect
 * whose record is written after the work is an effect that can be performed
 * without leaving a trace. Synchronously, because the process this file exists
 * to test is one that gets `SIGKILL`ed: a line sitting in a stream buffer when
 * the signal lands is a line that never existed.
 */
const sideEffectLog = process.env.DeFlow_FAKE_SIDE_EFFECT_LOG;
if (sideEffectLog !== undefined && sideEffectLog !== '') {
  appendFileSync(
    sideEffectLog,
    `${JSON.stringify({
      runId: process.env.DeFlow_FAKE_RUN_ID ?? '',
      nodeId: process.env.DeFlow_FAKE_NODE_ID ?? '',
      attempt: Number.parseInt(process.env.DeFlow_FAKE_ATTEMPT ?? '0', 10),
      idempotencyKey: process.env.DeFlow_FAKE_IKEY ?? '',
    })}\n`,
  );
}

const log = process.env.DeFlow_FAKE_LOG;
if (log !== undefined && log !== '') appendFileSync(log, `${JSON.stringify(invocation)}\n`);

const stderr = process.env.DeFlow_FAKE_STDERR;
if (stderr !== undefined && stderr !== '') process.stderr.write(stderr);

process.stdout.write(`${JSON.stringify(invocation)}\n`);

const exitCode = Number.parseInt(process.env.DeFlow_FAKE_EXIT_CODE ?? '0', 10);
process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
