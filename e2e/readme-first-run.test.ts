/**
 * KAR-20.3 AC4 — the README, executed.
 *
 * On 2026-08-12 somebody followed the install section of this repository's
 * README and reached `command not found`. Every sentence in it was true. The
 * document had never been run, so nothing in the repository could tell — a
 * README is the one artefact a project ships that is routinely asserted only by
 * being read by the person who wrote it.
 *
 * So this spec runs it. `test/support/readme.ts` extracts every fenced shell
 * line; `test/readme-commands.test.ts` asserts that each one is either here or
 * on a named skip list; and this file takes the ones that are here, in the
 * order the README presents them, in a clean room with a fake `HOME`, an npm
 * prefix nothing else knows about and a `PATH` holding node, npm, git and
 * nothing else. The first command is the install, and every command after it is
 * the binary that install left behind.
 *
 * The one substitution is the specifier: `npx deflowai setup` is run against a
 * packed tarball rather than against the registry, because the package is not
 * published yet and a release gate cannot verify bytes npm has not seen. It is
 * the same code path — `e2e/setup-install.test.ts` makes the same substitution
 * for the same reason — and `test/command-name.test.ts` is what keeps the name
 * in the README itself honest.
 *
 * Verifies: EPIC-20-S27 · EPIC-20-S32 · AC1, AC4, AC7
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS } from '../packages/adapters/src/provider-registry.ts';
import {
  cleanupPackedTarball,
  cleanupSystemToolsDir,
  cliDir,
  gitDir,
  type PackedTarball,
  packGoodTarball,
  systemToolsDir,
} from '../packages/cli/scripts/verify-install/lib.ts';
import { RUN_EXIT_CODES } from '../packages/cli/src/run/exit-codes.ts';
import {
  agentPackageMismatches,
  EXECUTED_COMMANDS,
  exitCodeMismatches,
  flagsMissingFromHelp,
  parseAgentPackages,
  parseCommands,
  parseExitCodes,
  parseFlags,
  readmeText,
  unclassifiedCommands,
} from '../test/support/readme.ts';

const README = readmeText();

interface Room {
  readonly dir: string;
  readonly repoDir: string;
  readonly home: string;
  readonly binDir: string;
  readonly env: NodeJS.ProcessEnv;
}

let tarball: PackedTarball;
let room: Room;
/** What each executed command actually did, keyed by the README's own text. */
const outcomes = new Map<string, { readonly status: number | null; readonly stdout: string }>();

/** The first `name` on this machine's own PATH, or null. */
function onHostPath(name: string): string | null {
  const found = spawnSync('/usr/bin/env', ['sh', '-c', `command -v ${name}`], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path !== '' ? path : null;
}

/**
 * The shell the room claims to be running under.
 *
 * A real zsh or bash, and not `/bin/sh`: `setup` refuses to guess which file an
 * unrecognised shell reads (KAR-20.2 AC7) and warns instead of writing, so a
 * room that said `SHELL=/bin/sh` would fail its verify step for a reason that
 * is about the room rather than about the README. Found the hard way, on the
 * second run of this spec.
 */
function terminalShell(): string {
  const shell = onHostPath('zsh') ?? onHostPath('bash');
  if (shell === null) throw new Error('no zsh and no bash on this machine');
  return shell;
}

/**
 * A clean room: a fake `HOME`, an npm global prefix nothing else knows about,
 * a git repository to run `init` in, and a `PATH` with node, npm, npx and git
 * on it and nothing else.
 *
 * Node's *own* directory is deliberately not on that `PATH`. On a normal
 * installation it is also the npm global bin directory, so putting it there
 * would hand the room the developer's own global installs — including, on this
 * machine, a `deflow` — and every assertion below would be about the wrong
 * binary.
 */
async function makeRoom(): Promise<Room> {
  const dir = await mkdtemp(join(tmpdir(), 'DeFlow-readme-'));
  const home = join(dir, 'home');
  const prefix = join(dir, 'prefix');
  const tools = join(dir, 'tools');
  const repoDir = join(dir, 'demo');
  for (const path of [home, prefix, tools, repoDir]) mkdirSync(path, { recursive: true });

  for (const binary of ['node', 'npm', 'npx']) {
    const resolved = binary === 'node' ? process.execPath : onHostPath(binary);
    if (resolved === null) throw new Error(`no ${binary} on this machine`);
    symlinkSync(resolved, join(tools, binary));
  }

  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const init = spawnSync('git', ['init', '-b', 'main', repoDir], { encoding: 'utf8', env: gitEnv });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);

  return {
    dir,
    repoDir,
    home,
    binDir: join(prefix, 'bin'),
    env: {
      PATH: [tools, gitDir(), systemToolsDir()].join(delimiter),
      HOME: home,
      SHELL: terminalShell(),
      DeFlow_DATA_DIR: join(dir, 'data'),
      DeFlow_LOG_LEVEL: 'silent',
      DeFlow_DEV: '0',
      BROWSER: 'none',
      npm_config_prefix: prefix,
      npm_config_cache: join(dir, 'npm-cache'),
      LANG: 'en_US.UTF-8',
    },
  };
}

/** The `PATH` a reader's next shell has: the install prefix, then the room's. */
function installedPath(): string {
  return [room.binDir, room.env.PATH ?? ''].join(delimiter);
}

beforeAll(async () => {
  tarball = packGoodTarball();
  room = await makeRoom();
}, 600_000);

afterAll(async () => {
  cleanupPackedTarball(tarball);
  cleanupSystemToolsDir();
  if (process.env.DeFlow_KEEP_TMP !== undefined) return;
  await rm(room.dir, { recursive: true, force: true });
});

/** One README command, run in the room, from the installed prefix. */
function runInstalled(command: string, argv: readonly string[]): number | null {
  const child = spawnSync(join(room.binDir, command), [...argv], {
    cwd: room.repoDir,
    encoding: 'utf8',
    env: { ...room.env, PATH: installedPath() },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });
  return child.status;
}

/** Records what a README line did, so the last spec can check none was missed. */
function record(readmeLine: string, status: number | null, stdout: string): void {
  outcomes.set(readmeLine, { status, stdout });
}

/** The exit codes the README claims for one of its own lines. */
function claimedExits(readmeLine: string): readonly number[] {
  const entry = EXECUTED_COMMANDS.find((candidate) => candidate.command === readmeLine);
  if (entry === undefined) throw new Error(`"${readmeLine}" is not in EXECUTED_COMMANDS`);
  return entry.exits;
}

suite('EPIC-20-S27 — a reader follows the README in a clean room', () => {
  it('starts from a machine with no deflow on PATH at all', () => {
    const found = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v deflow'], {
      encoding: 'utf8',
      env: room.env,
    });
    // Without this, every assertion below is compatible with "the author had
    // one installed globally and the room found that".
    expect(found.stdout.trim()).toBe('');
  });

  it('installs with the one command the install section shows', () => {
    const line = `npx deflowai setup`;
    const child = spawnSync(
      join(dirname(process.execPath), 'npx'),
      [
        '--yes',
        `--package=${tarball.tgz}`,
        '--',
        'deflow',
        'setup',
        '--yes',
        '--json',
        '--from',
        tarball.tgz,
      ],
      {
        cwd: room.dir,
        encoding: 'utf8',
        env: room.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600_000,
      },
    );
    record(line, child.status, child.stdout);

    // The failed steps rather than the bare exit code: `setup` reports five of
    // them and "exit 1" on its own sends the reader of a red build to run the
    // whole thing again by hand to find out which.
    let failed: readonly string[] = [`setup printed no document: ${child.stderr}`];
    try {
      const document = JSON.parse(child.stdout) as {
        readonly steps: readonly { readonly id: string; readonly state: string }[];
      };
      failed = document.steps
        .filter((step) => step.state === 'fail')
        .map((step) => `${step.id}: ${step.state}`);
    } catch {
      // Left as the sentence above, which is the more useful failure.
    }
    expect([line, child.status, failed]).toEqual([line, claimedExits(line)[0], []]);

    // And it left a binary behind, which is the claim the section makes and the
    // one that was false.
    expect(existsSync(join(room.binDir, 'deflow'))).toBe(true);
  }, 600_000);

  it('answers "deflow --version" the way the install section says it will', () => {
    const line = 'deflow --version';
    const child = spawnSync(join(room.binDir, 'deflow'), ['--version'], {
      cwd: room.repoDir,
      encoding: 'utf8',
      env: { ...room.env, PATH: installedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    record(line, child.status, child.stdout);
    const manifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
      readonly version: string;
    };
    expect([child.status, child.stdout.trim()]).toEqual([0, manifest.version]);
  });

  it('runs "deflow doctor", and exits 0 or 5 as the README documents', () => {
    const line = 'deflow doctor';
    const child = spawnSync(join(room.binDir, 'deflow'), ['doctor'], {
      cwd: room.repoDir,
      encoding: 'utf8',
      env: { ...room.env, PATH: installedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    record(line, child.status, child.stdout);
    expect([line, claimedExits(line).includes(child.status ?? -1)]).toEqual([line, true]);
    // A report rather than a stack trace, which is the other half of the claim.
    expect(child.stdout).toMatch(/runtime/);
  }, 300_000);

  it('runs "deflow doctor --fix", which installs nothing on a machine with no vendor CLI', () => {
    const line = 'deflow doctor --fix';
    const child = spawnSync(join(room.binDir, 'deflow'), ['doctor', '--fix'], {
      cwd: room.repoDir,
      encoding: 'utf8',
      env: { ...room.env, PATH: installedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    record(line, child.status, child.stdout);
    expect([line, claimedExits(line).includes(child.status ?? -1)]).toEqual([line, true]);
  }, 300_000);

  it('runs "deflow init" in a git repository, and exits 0', () => {
    const line = 'deflow init';
    const status = runInstalled('deflow', ['init']);
    record(line, status, '');
    expect([line, status]).toEqual([line, 0]);
    expect(existsSync(join(room.repoDir, '.DeFlow'))).toBe(true);
  });

  it('starts "deflow up" and prints the URL the README quotes', async () => {
    const line = 'deflow up';
    const child = spawn(join(room.binDir, 'deflow'), ['up'], {
      cwd: room.repoDir,
      env: { ...room.env, PATH: installedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });

    try {
      const deadline = Date.now() + 120_000;
      while (!/http:\/\/127\.0\.0\.1:\d+\/#token=/.test(out) && Date.now() < deadline) {
        if (child.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // AC7 — the section describes the URL and the token behaviour the daemon
      // actually prints, and this is the print. The token is 32 random bytes in
      // base64url (`packages/daemon/src/daemon-file.ts`), so the character
      // class is `[\w-]` and not hex: a narrower one passes on a token that
      // happens to contain no `-` and fails on the next daemon boot.
      expect(`${out}${err}`).toMatch(/http:\/\/127\.0\.0\.1:7777\/#token=[\w-]+/);
      record(line, 0, out);
    } finally {
      // In a `finally` because a failed assertion above must not leave a daemon
      // listening on 7777: the next run of this spec would then be measuring a
      // port that is already taken, and would fail for a reason that is not
      // about the README at all. Learned here, on the second run.
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }, 180_000);

  it('runs "deflow status", which always exits 0', () => {
    const line = 'deflow status';
    const status = runInstalled('deflow', ['status']);
    record(line, status, '');
    expect([line, status]).toEqual([line, 0]);
  });

  it('runs "deflow --help", which lists the commands the README names', () => {
    const line = 'deflow --help';
    const child = spawnSync(join(room.binDir, 'deflow'), ['--help'], {
      cwd: room.repoDir,
      encoding: 'utf8',
      env: { ...room.env, PATH: installedPath() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    record(line, child.status, child.stdout);
    expect(child.status).toBe(0);
    // The flag cross-check, against the help of the **installed** binary rather
    // than of the source tree — a flag lost in packaging is invisible to the
    // integration spec next door.
    expect(flagsMissingFromHelp(parseFlags(README), child.stdout)).toEqual([]);
  });

  it('ran every command the classification says it runs, and no other', () => {
    // The assertion that stops this file quietly shrinking: a command dropped
    // from a spec above is red here rather than merely absent.
    expect([...outcomes.keys()].toSorted()).toEqual(
      EXECUTED_COMMANDS.map((entry) => entry.command).toSorted(),
    );
  });
});

/**
 * EPIC-20-S32 — the sabotage table.
 *
 * A README test can pass by asserting that commands merely run, and would then
 * never notice a wrong *claim* — which is the exact failure this story is
 * fixing in prose. Each row below mutates one input and asserts that the check
 * which reads it goes red. They drive the same functions the specs above and
 * `test/integration/readme-contract.test.ts` use, not copies: a sabotage suite
 * with its own implementation proves nothing about what ships.
 */
suite('EPIC-20-S32 — a claim that stops being true turns a test red', () => {
  it('a documented exit code changed in the program', () => {
    const documented = parseExitCodes(README);
    expect(exitCodeMismatches(documented, Object.values(RUN_EXIT_CODES))).toEqual([]);
    const moved = Object.values(RUN_EXIT_CODES).map((code) => (code === 130 ? 129 : code));
    expect(exitCodeMismatches(documented, moved).length).toBeGreaterThan(0);
  });

  it('a documented flag removed from the parser', () => {
    const flags = parseFlags(README);
    expect(flagsMissingFromHelp(flags, outcomes.get('deflow --help')?.stdout ?? '')).toEqual([]);
    expect(flagsMissingFromHelp(flags, '')).toEqual(flags);
  });

  it("a provider's package name changed in the registry", () => {
    const rows = parseAgentPackages(README);
    const facts = new Map(
      Object.entries(PROVIDER_SPECS).map(([id, spec]) => [
        id,
        {
          kind: spec.kind,
          bundled: spec.bundled === true,
          npmPackage: spec.package,
          bin: spec.bin,
          vendorBin: spec.shim.bin,
        },
      ]),
    );
    expect(agentPackageMismatches(rows, facts)).toEqual([]);

    const gemini = facts.get('gemini');
    if (gemini === undefined) throw new Error('no gemini in the registry');
    facts.set('gemini', { ...gemini, npmPackage: '@google/gemini-cli-next' });
    expect(agentPackageMismatches(rows, facts).length).toBeGreaterThan(0);
  });

  it('the install command renamed', () => {
    // The extractor's own red: a README whose first command changed is
    // unclassified, and unclassified is a failure rather than a silent skip.
    const renamed = README.replace('npx deflowai setup', 'npx deflowai install');
    expect(unclassifiedCommands(parseCommands(renamed))).toEqual(['npx deflowai install']);
  });
});
