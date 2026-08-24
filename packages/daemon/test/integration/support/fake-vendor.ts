/**
 * A machine whose vendor CLI is the testkit's fake exec-shim agent.
 *
 * `linkFakeAgent` symlinks the fake under a vendor name and hands the child its
 * `DeFlow_FAKE_*` variables through `request.env` — which every adapters spec
 * does, because it builds the child environment itself. A **daemon** spec
 * cannot: production builds the child's environment in exactly one place
 * (`buildChildEnv`, KAR-08.4) and that allowlist scrubs every variable the fake
 * reads. A fixture that reached around it would be testing a code path DeFlowd
 * does not have.
 *
 * So the fake is installed as a *wrapper script* instead: the scenario and the
 * dialect live inside the file, and what is on `PATH` is an ordinary executable
 * that behaves like the vendor's own CLI when spawned with nothing but `PATH`,
 * `HOME` and `TMPDIR`. That is precisely the machine the 2026-08-24 incident
 * was run on — a real `claude` on `/opt/homebrew/bin`, no ACP bridge beside it
 * — and reproducing it needs no exception to the one environment builder.
 *
 * Both binaries can be installed under **different** names in one root, which
 * is what makes "the ACP route spawns the adapter and not the vendor" an
 * assertion about a path rather than about a symlink pointing at one file.
 */

import { FAKE_AGENT_BIN } from '@DeFlow/testkit';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

export interface FakeVendorOptions {
  /** The PATH root the executable is written into. Created if absent. */
  readonly binDir: string;
  /** The name a vendor CLI would have. */
  readonly name?: string;
  /** A scenario name, a path, or an inline JSON document — `DeFlow_FAKE_SCENARIO`. */
  readonly scenario: string;
  /** Which vendor's stream dialect the fake speaks. */
  readonly dialect?: 'claude-stream-json' | 'codex-jsonl' | 'copilot-json';
  /** Seeds every uuid the fake mints, so a transcript replays byte for byte. */
  readonly seed?: string;
  /** A fixed clock reading, in epoch milliseconds. */
  readonly nowMs?: number;
  /** Where the fake appends one line per invocation, if a spec wants to read
   * what it was actually asked to do. */
  readonly sideEffectLog?: string;
  /**
   * The script the wrapper `exec`s, absolute. Defaults to the exec-shim fake.
   *
   * A machine whose ACP route is open has **two** executables under two names,
   * and only one of them speaks ACP — so a fixture that could install one file
   * under two names could not tell "DeFlow spawned the adapter" apart from
   * "DeFlow spawned the vendor and got lucky", which is the exact confusion
   * this story exists to remove.
   */
  readonly execTarget?: string;
}

/**
 * Writes `<binDir>/<name>` and returns its absolute path.
 *
 * `/bin/sh` rather than `node` as the interpreter, and every path inside it
 * absolute: the wrapper is spawned with DeFlowd's own `PATH` replacement, so a
 * bare `node` in it would resolve against the fixture's one-entry root and find
 * nothing.
 */
export async function installFakeVendorCli(options: FakeVendorOptions): Promise<string> {
  const name = options.name ?? 'claude';
  await mkdir(options.binDir, { recursive: true });
  const path = join(options.binDir, name);

  const exports = [
    `DeFlow_FAKE_DIALECT=${shellQuote(options.dialect ?? 'claude-stream-json')}`,
    `DeFlow_FAKE_SCENARIO=${shellQuote(options.scenario)}`,
    `DeFlow_FAKE_SEED=${shellQuote(options.seed ?? '42')}`,
    ...(options.nowMs === undefined
      ? []
      : [`DeFlow_FAKE_NOW=${shellQuote(String(options.nowMs))}`]),
    ...(options.sideEffectLog === undefined
      ? []
      : [`DeFlow_SIDE_EFFECT_LOG=${shellQuote(options.sideEffectLog)}`]),
  ].map((assignment) => `export ${assignment}`);

  await writeFile(
    path,
    [
      '#!/bin/sh',
      '# Written by packages/daemon/test/integration/support/fake-vendor.ts.',
      ...exports,
      `exec ${shellQuote(process.execPath)} ${shellQuote(options.execTarget ?? FAKE_AGENT_BIN)} "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

/** Single-quoted for `/bin/sh`, with embedded quotes closed and reopened. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}
