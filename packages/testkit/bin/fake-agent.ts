#!/usr/bin/env node
/**
 * The fake exec-shim agent (docs/14-testing-strategy.md §3.2).
 *
 * A **real executable**, symlinked onto a temp PATH under whatever vendor name
 * a fixture wants — never a mocked `child_process`. Mocking the process
 * boundary would test the mock: the spawn logic, the argv construction, the
 * stream parser, the backpressure handling, the timeout and the kill path are
 * all on the other side of it.
 *
 * It has two modes, and which one runs depends on a single variable.
 *
 * **Echo mode**, when `$DeFlow_FAKE_DIALECT` is absent. The binary prints what
 * it was invoked with and exits. KAR-01.4 built it, KAR-03.8 gave it `--seed`,
 * and EPIC-01/EPIC-03 fixtures read the echo — so it stays exactly as it was.
 *
 * **Exec-shim mode**, when `$DeFlow_FAKE_DIALECT` names a dialect. The binary
 * reproduces a scripted invocation of a real vendor CLI: Claude-Code-shaped
 * `stream-json`, Codex-shaped JSONL or Copilot's JSON, with the scenario read
 * from `$DeFlow_FAKE_SCENARIO` (KAR-04.6). The scenario vocabulary is the F3.4
 * conformance battery — scripted chunks with delays, a `result` envelope,
 * malformed JSON, a non-zero exit, **exit without any output at all**, hang
 * forever, **ignore SIGTERM** so the SIGKILL escalation is genuinely exercised,
 * files written outside the worktree, a permission refusal, and a single 10 MB
 * line.
 *
 * Environment, in both modes:
 *   DeFlow_SIDE_EFFECT_LOG   append one {runId,nodeId,attempt,idempotencyKey}
 *                            per invocation (KAR-04.2's contract; the four
 *                            values come from --run-id/--node-id/--attempt/
 *                            --ikey, or from DeFlow_RUN_ID and friends)
 *   DeFlow_FAKE_EXIT_CODE    exit with this code instead of the scripted one
 *
 * Exec-shim mode only:
 *   DeFlow_FAKE_DIALECT      claude-stream-json | codex-jsonl | copilot-json
 *   DeFlow_FAKE_SCENARIO     a scenario name, a path, or an inline JSON document
 *   DeFlow_FAKE_SEED         seeds every uuid, so a run replays byte for byte
 *   DeFlow_FAKE_NOW          a fixed clock reading, in epoch milliseconds
 *
 * Echo mode only (all pre-KAR-04.6, all still honoured):
 *   DeFlow_FAKE_LOG / DeFlow_FAKE_SIDE_EFFECT_LOG / DeFlow_FAKE_RUN_ID /
 *   DeFlow_FAKE_NODE_ID / DeFlow_FAKE_ATTEMPT / DeFlow_FAKE_IKEY /
 *   DeFlow_FAKE_STDERR
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { DIALECT_ENV } from '../src/exec-shim/dialects.ts';
import { createProcessPorts } from '../src/exec-shim/ports.ts';
import { runExecShim, seedFrom } from '../src/exec-shim/run.ts';
import { mulberry32 } from '../src/random.ts';
import { recordInvocation } from '../src/side-effect-log.ts';

const argv = process.argv.slice(2);

/**
 * The side-effect log, written **first** and synchronously.
 *
 * First, because this is the record that the invocation happened, and one whose
 * record is written after the work is one that can be performed without leaving
 * a trace. It is written before the dialect is even read, so an invocation the
 * fake goes on to refuse is still in the log — that is the one whose absence
 * would be hardest to explain later.
 */
recordInvocation(argv, process.env);

/** Echo mode: unchanged since KAR-03.8, and read by EPIC-01/EPIC-03 fixtures. */
function echo(): never {
  const seed = seedFrom(argv, {});
  const invocation = {
    argv,
    invokedAs: process.argv[1],
    cwd: process.cwd(),
    pid: process.pid,
    seed,
    // Derived from the seed and from nothing else. Without one it is null
    // rather than a fresh random number: an unseeded fake that is quietly
    // nondeterministic is worse than one with no randomness at all.
    nonce: seed === null ? null : mulberry32(seed)(),
  };

  const log = process.env.DeFlow_FAKE_LOG;
  if (log !== undefined && log !== '') appendFileSync(log, `${JSON.stringify(invocation)}\n`);

  const stderr = process.env.DeFlow_FAKE_STDERR;
  if (stderr !== undefined && stderr !== '') process.stderr.write(stderr);

  process.stdout.write(`${JSON.stringify(invocation)}\n`);

  const exitCode = Number.parseInt(process.env.DeFlow_FAKE_EXIT_CODE ?? '0', 10);
  process.exit(Number.isNaN(exitCode) ? 0 : exitCode);
}

if (process.env[DIALECT_ENV] === undefined) echo();

const code = await runExecShim(argv, process.env, createProcessPorts());
// Set rather than forced with `process.exit`, so the process ends only once
// stdout has drained — a 10 MB line still in the pipe would otherwise be
// truncated, which is a different failure from the one being scripted. `null`
// is the scenario that hangs: no exit code, because there is no exit.
if (code !== null) process.exitCode = code;
