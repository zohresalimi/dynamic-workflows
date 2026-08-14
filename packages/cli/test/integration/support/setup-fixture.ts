/**
 * Fixtures for `deflow setup` (KAR-20.2).
 *
 * Everything here is a **real executable on a real temp `PATH`**, never a
 * mocked module, and that is not a stylistic preference: every claim this
 * story makes is a claim about a machine. "The link command exited 0 and put
 * nothing on `PATH`" is not expressible against a stubbed function — it is
 * exactly the shape of a stub that returns success — and the 2026-08-12 defect
 * this story exists for is precisely a success returned by something that did
 * nothing.
 *
 * Three fakes:
 *
 *  - **`writeFakeDeflow`** is the *installed* CLI: it answers `--version` and
 *    `doctor --json` and records the argv it was called with. Its `doctor`
 *    verdict is a parameter, because "a machine that installed correctly and
 *    has a degraded sandbox" (AC9) cannot be staged any other way.
 *  - **`writeFakeNpmForSetup`** is an `npm` that both records its argv *and*
 *    answers `prefix -g`, which is what turns "the global bin directory is not
 *    on PATH" from a thing that happens on somebody else's laptop into a
 *    staged fact.
 *  - **`writeFakePnpm`** answers `bin -g` with a second directory, for
 *    EPIC-20-S15's second scenario.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function writeExecutable(path: string, source: string): string {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** Every argv a recording fake was invoked with, in order. */
export async function invocations(log: string): Promise<readonly (readonly string[])[]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

export interface FakeDeflowOptions {
  readonly version: string;
  /** Appended one JSON argv array per invocation. */
  readonly log: string;
  /**
   * What `doctor --json` does:
   *  - `healthy` — a document with every check ok, exit 0;
   *  - `degraded` — one failing check and exit 5, KAR-18.4 AC11's "DeFlow
   *    cannot run here" code, which AC9 says must not become setup's;
   *  - `crash` — a stack trace on stderr and a non-JSON stdout.
   */
  readonly doctor?: 'healthy' | 'degraded' | 'crash';
  /** Print this instead of the version — EPIC-20-S14's second scenario. */
  readonly unparseableVersion?: string;
}

/**
 * The installed `deflow`, as a `PATH` entry.
 *
 * `--version` and `doctor --json` are the only two things `setup` ever asks the
 * installed binary, and both are asked *through a shell resolving the fresh
 * PATH* — so this file existing in a directory is not enough for a spec to
 * pass, which is the whole point.
 */
export async function writeFakeDeflow(binDir: string, options: FakeDeflowOptions): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const degraded = {
    sections: [
      {
        id: 'runtime',
        title: 'Runtime',
        status: 'fail',
        checks: [
          {
            id: 'runtime.state-dir',
            status: 'fail',
            detail: 'the state directory is not writable',
          },
        ],
      },
    ],
    status: 'fail',
    exitCode: 5,
  };
  const healthy = {
    sections: [
      {
        id: 'runtime',
        title: 'Runtime',
        status: 'ok',
        checks: [{ id: 'runtime.node', status: 'ok', detail: 'node 24 is new enough' }],
      },
    ],
    status: 'ok',
    exitCode: 0,
  };

  return writeExecutable(
    join(binDir, 'deflow'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.log)}, JSON.stringify(argv) + '\\n');

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(${JSON.stringify(`${options.unparseableVersion ?? options.version}\n`)});
  process.exit(0);
}

if (argv[0] === 'doctor') {
  const mode = ${JSON.stringify(options.doctor ?? 'healthy')};
  if (mode === 'crash') {
    process.stderr.write('TypeError: cannot read properties of undefined\\n    at probe (/x.js:1:1)\\n');
    process.exit(1);
  }
  const document = mode === 'degraded' ? ${JSON.stringify(degraded)} : ${JSON.stringify(healthy)};
  process.stdout.write(JSON.stringify(document) + '\\n');
  process.exit(document.exitCode);
}

process.stderr.write('unknown command\\n');
process.exit(64);
`,
  );
}

export interface FakeNpmForSetupOptions {
  /** Appended one JSON argv array per invocation. */
  readonly log: string;
  /** What `npm prefix -g` prints. `<prefix>/bin` is the global bin directory. */
  readonly prefix: string;
  /** Destination ← source, copied and chmod 0755 on a successful install. */
  readonly installs?: Readonly<Record<string, string>>;
  /** Fail every install with this instead — EPIC-20-S24's no-egress case. */
  readonly failure?: { readonly exitCode: number; readonly stderr: string };
}

/**
 * An `npm` that answers `prefix -g` and records every install.
 *
 * The recording is what AC11's spawn guard reads: "exactly one child process
 * mutated global state, and it installed this package" is a claim best made
 * from the callee's side, because a claim made from the caller's side is a
 * claim about the code that was read rather than about the code that ran.
 */
export async function writeFakeNpmForSetup(
  binDir: string,
  options: FakeNpmForSetupOptions,
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  return writeExecutable(
    join(binDir, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.log)}, JSON.stringify(argv) + '\\n');

if (argv[0] === 'prefix' && argv[1] === '-g') {
  process.stdout.write(${JSON.stringify(`${options.prefix}\n`)});
  process.exit(0);
}

if (argv[0] === 'install') {
  const failure = ${JSON.stringify(options.failure ?? null)};
  if (failure !== null) {
    process.stderr.write(failure.stderr);
    process.exit(failure.exitCode);
  }
  for (const [dest, src] of Object.entries(${JSON.stringify(options.installs ?? {})})) {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  }
  process.exit(0);
}

process.exit(0);
`,
  );
}

/** A `pnpm` that answers `bin -g` with a directory of its own (EPIC-20-S15). */
export async function writeFakePnpm(
  binDir: string,
  options: { readonly log: string; readonly globalBin: string },
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  return writeExecutable(
    join(binDir, 'pnpm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(options.log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'bin' && process.argv[3] === '-g') {
  process.stdout.write(${JSON.stringify(`${options.globalBin}\n`)});
  process.exit(0);
}
process.exit(0);
`,
  );
}
