/**
 * Fixtures for the `DeFlow doctor` specs (KAR-18.4).
 *
 * Real executables on a temp `PATH`, never a mocked module (docs/14 §3.3).
 * Three of them, and each exists because the check it drives must not be
 * satisfiable by reading a string:
 *
 *  - **the git shim** answers `--version` with whatever a `Scenario Outline`
 *    row asks for and `exec`s the real git for everything else. That is what
 *    lets EPIC-18-S28 assert both halves at once: the version gate reads a
 *    2.44.1 that is not on this machine, while `merge-tree --write-tree` is
 *    still genuinely executed against a real repository. A shim that answered
 *    every subcommand would let the "the version string is not trusted on its
 *    own" scenario pass without any git running at all.
 *  - **the mock-agent shim** wears one vendor's capability profile and
 *    swallows that vendor's own ACP argv, so a `gemini`-shaped adapter can be
 *    probed on a machine with no Gemini CLI (EPIC-18-S31). Its version string
 *    and its bytes are both parameters, because a drift warning has to be
 *    stageable in each direction separately (EPIC-18-S32).
 *  - **`fakeBin`** is a binary that exists and does nothing, for the sandbox
 *    prerequisites: `bwrap` and `socat` are checked for *presence on PATH*,
 *    and presence is the whole assertion.
 */
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The bundled mock agent's source entry — a real ACP agent as a subprocess. */
export const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

/**
 * The first `name` on the *outer* `PATH`, or `null`.
 *
 * Used to find the real git, and only that: a spec that needs a real git has
 * to say so, and one that asserts "no agent CLI is installed" builds its own
 * `PATH` from nothing but the directories it created.
 */
export function resolveOnHostPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function writeExecutable(path: string, source: string): string {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * A `git` that lies about its version and tells the truth about everything
 * else.
 *
 * `execFileSync` with the real git and inherited stdio rather than a re-exec,
 * so exit codes and both streams pass straight through — `merge-tree
 * --write-tree` reports a conflict as exit 1 and the check reads it.
 */
export async function writeGitShim(
  binDir: string,
  options: { readonly version: string; readonly realGit: string },
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  return writeExecutable(
    join(binDir, 'git'),
    // `--version` is matched anywhere on the line rather than as the whole of
    // it: every caller in DeFlow goes through `runGit`, which always prefixes
    // `-C <cwd>`, so a shim that only answered a bare `--version` would silently
    // delegate to the real git and the whole Scenario Outline would pass for
    // the wrong reason.
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`git version ${options.version}\n`)});
  process.exit(0);
}
const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(options.realGit)}, argv, { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
`,
  );
}

export interface MockAgentShimOptions {
  /** The vendor binary name this shim is installed as, e.g. `gemini`. */
  readonly name: string;
  /** A `CAPABILITY_PROFILE_NAMES` member, or absent for the built-in default. */
  readonly profile?: string;
  /** What `--version` prints. Also changes the file's bytes, hence its sha256. */
  readonly version: string;
}

/**
 * The bundled mock agent, wearing one vendor's capability profile.
 *
 * The vendor's own ACP argv (`--acp`, `acp --cwd …`) is deliberately dropped:
 * the mock agent refuses an argument it does not know, and the subject of
 * EPIC-18-S31 is the `initialize` response, not the flag dialect that reached
 * it. `--version` is answered here rather than delegated, because the probe
 * asks the *installed* binary its version and that is the string the manifest
 * is keyed on.
 */
export async function writeMockAgentShim(
  binDir: string,
  options: MockAgentShimOptions,
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const args =
    options.profile === undefined ? [] : ['--capabilities', options.profile as unknown as string];
  return writeExecutable(
    join(binDir, options.name),
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`${options.version}\n`)});
  process.exit(0);
}
const { spawn } = require('node:child_process');
const child = spawn(
  process.execPath,
  [${JSON.stringify(MOCK_AGENT_BIN)}, ...${JSON.stringify(args)}],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code === null ? 0 : code);
});
`,
  );
}

/**
 * An ACP agent that answers `initialize` with an unfinished login, the way
 * Copilot CLI 1.0.77 does: an `authMethods` entry carrying a literal
 * `_meta["terminal-auth"]` block of `{command, args}`, ready to execute.
 *
 * That readiness is the point. Running it would be one plausible, helpful
 * line, and it would put DeFlow inside the credential path AR-1 exists to keep
 * it out of. The mock agent cannot stage this — it answers `authMethods: []`,
 * the already-authenticated case — so this fixture exists to make "doctor
 * printed the command and did not run it" an assertion rather than a claim.
 */
export async function writeAuthPromptingAgent(
  binDir: string,
  options: { readonly name: string; readonly version: string; readonly log: string },
): Promise<string> {
  await mkdir(binDir, { recursive: true });
  return writeExecutable(
    join(binDir, options.name),
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
      agentCapabilities: { loadSession: false },
      agentInfo: { name: ${JSON.stringify(options.name)}, version: ${JSON.stringify(options.version)} },
      authMethods: [
        {
          id: 'device-code',
          name: 'Sign in with a device code',
          description: 'Opens a browser and pairs this machine',
          _meta: { 'terminal-auth': { command: ${JSON.stringify(options.name)}, args: ['auth', 'login'] } },
        },
      ],
    },
  }) + '\\n');
});
lines.on('close', () => process.exit(0));
`,
  );
}

/** A binary that exists and does nothing — presence on `PATH` is the assertion. */
export async function fakeBin(binDir: string, name: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  return writeExecutable(join(binDir, name), '#!/usr/bin/env node\nprocess.exit(0);\n');
}

export interface DoctorEnvOptions {
  readonly dataDir: string;
  /** Directories prepended to `PATH`, in order. */
  readonly binDirs?: readonly string[];
  /** Put the real git's directory on `PATH` too. */
  readonly realGit?: boolean;
  /** Extra variables — `ANTHROPIC_API_KEY` and friends. */
  readonly extra?: NodeJS.ProcessEnv;
}

/**
 * The environment a `doctor` spec runs under.
 *
 * `PATH` holds only what the spec asked for plus the directory `node` itself
 * lives in — never the developer's own, or a spec asserting "no agent CLI is
 * installed" finds a real one and passes for the wrong reason. The `node`
 * directory has to be there: every fake here is a `#!/usr/bin/env node`
 * script, and a shebang that cannot resolve is an ENOENT with no explanation.
 */
export function doctorEnv(options: DoctorEnvOptions): NodeJS.ProcessEnv {
  const git = options.realGit === true ? resolveOnHostPath('git') : null;
  const path = [
    ...(options.binDirs ?? []),
    dirname(process.execPath),
    ...(git === null ? [] : [dirname(git)]),
  ].join(delimiter);

  return {
    PATH: path,
    HOME: options.dataDir,
    DeFlow_DATA_DIR: options.dataDir,
    DeFlow_LOG_LEVEL: 'silent',
    ...options.extra,
  };
}
