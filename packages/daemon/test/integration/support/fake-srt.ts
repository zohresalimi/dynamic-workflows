/**
 * A stub `@anthropic-ai/sandbox-runtime` on a fixture's `PATH`.
 *
 * The wrapper is where a plan script's confinement lives (KAR-23.9), so a spec
 * about the *tool performer* has to be able to assert how DeFlow invokes it —
 * the flag order, the settings document, and the fact that the run line arrives
 * as **one** argv element rather than interpolated into a second command line.
 * This stub validates all three from inside the child, in the
 * `installFakeVendorCli` discipline: the fake refuses an argv it was not
 * promised, so a wrongly-shaped invocation exits non-zero before the wrapped
 * command runs at all.
 *
 * **Stated plainly, because it would otherwise be over-read:** this proves
 * DeFlow *invokes* the wrapper correctly. It proves nothing about whether the
 * operating system confines anything — the stub `exec`s its payload with no
 * sandbox whatsoever. Real confinement is `../tool-node-sandbox.test.ts`,
 * against the pinned wrapper, and it is skipped loudly where that wrapper is
 * not resolvable.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

export interface FakeSrtOptions {
  /** The PATH root the executable is written into. Created if absent. */
  readonly binDir: string;
  /** Where the stub appends one JSON line per invocation. */
  readonly log: string;
}

/** The stub's own exit code for an argv it refuses. Distinct from anything a
 * wrapped script would plausibly return, so a refusal is never mistaken for
 * the payload's own failure. */
export const SRT_STUB_ARGV_REFUSED = 64;

/**
 * Writes `<binDir>/srt` and returns its absolute path.
 *
 * The two-file shape is `fake-vendor.ts`'s and for the same reason: what the
 * daemon spawns is an ordinary executable found on a one-entry `PATH`, and the
 * interpreter is named by absolute path because the child's `PATH` is
 * DeFlow's replacement rather than the fixture author's.
 */
export async function installStubSandboxRuntime(options: FakeSrtOptions): Promise<string> {
  await mkdir(options.binDir, { recursive: true });
  const runner = join(options.binDir, 'srt-stub.mjs');
  await writeFile(runner, RUNNER, 'utf8');

  const path = join(options.binDir, 'srt');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      '# Written by packages/daemon/test/integration/support/fake-srt.ts.',
      `export DeFlow_SRT_STUB_LOG=${shellQuote(options.log)}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(runner)} "$@"`,
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

/** One recorded invocation of the stub. */
export interface SrtInvocation {
  readonly settingsPath: string;
  readonly settings: {
    readonly network: { readonly allowedDomains: string[]; readonly deniedDomains: string[] };
    readonly filesystem: {
      readonly denyRead: string[];
      readonly allowWrite: string[];
      readonly denyWrite: string[];
    };
  };
  /** Everything after `--settings <path>` — the wrapped command line. */
  readonly wrapped: readonly string[];
  readonly cwd: string;
  /** The names present in the child's environment, never their values. */
  readonly envNames: readonly string[];
}

const RUNNER = `/**
 * Written by packages/daemon/test/integration/support/fake-srt.ts — see that
 * file's note. Validates the argv DeFlow promised, records it, and execs.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const REFUSED = ${String(SRT_STUB_ARGV_REFUSED)};
const argv = process.argv.slice(2);

const refuse = (why) => {
  process.stderr.write('srt stub refused its argv: ' + why + '\\n');
  process.exit(REFUSED);
};

if (argv[0] !== '--settings') refuse('expected --settings first, got ' + JSON.stringify(argv[0]));
const settingsPath = argv[1];
if (typeof settingsPath !== 'string') refuse('--settings carried no path');

let settings;
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (error) {
  refuse('the settings document at ' + settingsPath + ' is unreadable: ' + String(error));
}
if (settings === null || typeof settings !== 'object') refuse('the settings document is not an object');
if (settings.filesystem === undefined || settings.network === undefined) {
  refuse('the settings document carries neither filesystem nor network rows');
}

const wrapped = argv.slice(2);
if (wrapped.length === 0) refuse('nothing was wrapped');

appendFileSync(
  process.env.DeFlow_SRT_STUB_LOG,
  JSON.stringify({
    settingsPath,
    settings,
    wrapped,
    cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(),
  }) + '\\n',
);

const [command, ...rest] = wrapped;
const result = spawnSync(command, rest, { stdio: 'inherit' });
if (result.error !== undefined && result.error !== null) {
  process.stderr.write('srt stub could not spawn ' + command + ': ' + String(result.error) + '\\n');
  process.exit(127);
}
process.exit(result.status === null ? 1 : result.status);
`;

/** Single-quoted for `/bin/sh`, with embedded quotes closed and reopened. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}
