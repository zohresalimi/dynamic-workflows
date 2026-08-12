/**
 * Fixtures for the `DeFlow up` specs: a fake agent binary, a fake browser, and
 * the hermetic environment both are reached through.
 *
 * Real executables on a temp `PATH`, never a mocked module (docs/14 §3.3). The
 * agent here is deliberately *not* `@DeFlow/testkit`'s shared fake: these specs
 * need a binary whose reported version and whose bytes they can change between
 * two boots, which is the whole subject of EPIC-18-S17.
 */

import type { DaemonFile } from '@DeFlow/daemon';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A minimal ACP agent, as a real file with a real mode bit.
 *
 * Written in CommonJS-compatible syntax with no `import` statement, because it
 * is executed as `<binDir>/claude-agent-acp` — a file with no extension, which
 * Node loads by syntax detection. Nothing here is ESM-only, so the detection
 * cannot go wrong on a machine whose Node differs from this one's.
 *
 * `version` is baked into the file, so changing it changes the bytes too: a
 * rebuilt binary at an unchanged version and a version bump are the same event
 * as far as the sha256 is concerned, which is exactly why the probe cache is
 * keyed on the hash rather than on the version string alone.
 */
export async function writeFakeAgent(
  binDir: string,
  options: { readonly version: string; readonly log: string; readonly name?: string },
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, options.name ?? 'claude-agent-acp');
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');

const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.log)}, JSON.stringify(argv) + '\\n');

if (argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`${options.version}\n`)});
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let frame;
  try { frame = JSON.parse(line); } catch { return; }
  if (frame.method !== 'initialize') return;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id: frame.id,
    result: {
      protocolVersion: frame.params && frame.params.protocolVersion,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      agentInfo: { name: 'fake-acp-agent', version: ${JSON.stringify(options.version)} },
      authMethods: [],
    },
  }) + '\\n');
});
lines.on('close', () => process.exit(0));
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fake browser: appends whatever URL it is handed to `log` and exits.
 *
 * `$BROWSER` is the seam, so nothing has to mock `child_process` to find out
 * whether step 8 of the runbook actually happened.
 */
export async function writeFakeBrowser(binDir: string, log: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'fake-browser');
  writeFileSync(
    path,
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

export interface UpEnvOptions {
  readonly dataDir: string;
  /** Directories prepended to `PATH`, in order. */
  readonly binDirs?: readonly string[];
  readonly browser?: string;
}

/**
 * A directory holding a `node` and nothing else, one per test process.
 *
 * The shebang problem, solved without the side effect. Every fake here is a
 * `#!/usr/bin/env node` script, so `node` has to be findable — but putting
 * *its own directory* on `PATH` puts the npm global bin directory there with it
 * on every normal installation, which is where a developer's real
 * `claude-agent-acp` lives. A spec asserting "zero providers" then finds the
 * author's own, the boot probe succeeds, and the probe's synthetic run turns up
 * in a `DeFlow status` listing that expected two.
 *
 * Corrected 2026-08-12 while implementing KAR-19.2 — same correction as
 * `doctor-fixture.ts`'s `doctorEnv`, for the same reason, found the same way.
 */
function nodeOnlyDir(): string {
  const dir = join(tmpdir(), `DeFlow-node-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'node');
  if (!existsSync(link)) symlinkSync(process.execPath, link);
  return dir;
}

/**
 * The environment a `DeFlow up` spec runs the command under.
 *
 * `PATH` holds only what is passed in, plus a directory holding nothing but a
 * `node` — never the developer's own `PATH`, or a spec asserting "no agent CLI
 * is installed" would find a real one and pass for the wrong reason.
 */
export function upEnv(options: UpEnvOptions): NodeJS.ProcessEnv {
  const path = [...(options.binDirs ?? []), nodeOnlyDir()].join(':');
  return {
    PATH: path,
    HOME: options.dataDir,
    DeFlow_DATA_DIR: options.dataDir,
    DeFlow_LOG_LEVEL: 'silent',
    ...(options.browser === undefined ? { BROWSER: 'none' } : { BROWSER: options.browser }),
  };
}

/** `<dataDir>/daemon.json`, parsed. */
export function readDaemonFile(dataDir: string): DaemonFile {
  return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as DaemonFile;
}
