/**
 * KAR-20.2 AC1 — installed from nothing, and then found by a shell that was
 * opened afterwards.
 *
 * This is the scenario the epic exists for, and the second `When` is the whole
 * of it: **a new shell**. Asserting that `deflow` resolves inside the process
 * that just edited a profile proves only that a process can see its own
 * environment — which is exactly what a passing check would have said on
 * 2026-08-12, while the operator's next terminal said `command not found`.
 *
 * So the shell here is a real one, started interactively so that it reads the
 * file `setup` wrote (`~/.zshrc` for zsh, `~/.bashrc` for bash — the files
 * those shells actually read when a terminal window opens), with a `PATH` that
 * does **not** contain the install prefix. If the profile line is wrong, absent
 * or in the wrong file, this spec fails, and nothing else in the repository
 * can tell.
 *
 * Both entry points are here because they fail in different places: `npx deflowai
 * setup` needs a Node already, and the macOS script is what a machine without
 * one reaches for. The second scenario of EPIC-20-S12 — that the script is a
 * bootstrap rather than a second, more powerful installer — is asserted over
 * its source in `test/install-script.test.ts`; what is asserted here is that
 * the two paths leave the same machine behind.
 *
 * Verifies: EPIC-20-S11, EPIC-20-S12 · AC1, AC2, AC3, AC5 · test plan #1
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  cleanupPackedTarball,
  cleanupSystemToolsDir,
  cliDir,
  gitDir,
  type PackedTarball,
  packGoodTarball,
  repoRoot,
  systemToolsDir,
} from '../packages/cli/scripts/verify-install/lib.ts';

let good: PackedTarball;
/** One npm cache for both rooms: the second install is then a cache hit rather
 * than a second trip to the registry, which is minutes rather than seconds. */
let cache = '';
const rooms: string[] = [];

beforeAll(async () => {
  good = packGoodTarball();
  cache = await mkdtemp(join(tmpdir(), 'DeFlow-setup-cache-'));
}, 600_000);

afterAll(async () => {
  cleanupPackedTarball(good);
  cleanupSystemToolsDir();
  if (process.env.DeFlow_KEEP_TMP !== undefined) return;
  for (const room of rooms) await rm(room, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
});

const manifest = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8')) as {
  readonly version: string;
};

/** The first `name` on this machine's own `PATH`, or `null`. */
function onHostPath(name: string): string | null {
  const found = spawnSync('/usr/bin/env', ['sh', '-c', `command -v ${name}`], {
    encoding: 'utf8',
  });
  const path = found.stdout.trim();
  return found.status === 0 && path !== '' ? path : null;
}

/**
 * The shell whose profile this machine's `setup` will edit, and the file it
 * reads when a terminal window opens.
 *
 * zsh where there is one — macOS's default, and the owner's — and bash
 * otherwise. Both are started with `-i` below rather than `-l`, because that is
 * what a terminal emulator does and what makes `~/.zshrc` and `~/.bashrc` the
 * files that matter; a non-interactive `sh -c` reads neither, and would pass
 * this spec by reading nothing at all.
 */
function terminalShell(): { readonly path: string; readonly profile: string } {
  const zsh = onHostPath('zsh');
  if (zsh !== null) return { path: zsh, profile: '.zshrc' };
  const bash = onHostPath('bash');
  if (bash === null) throw new Error('no zsh and no bash on this machine');
  return { path: bash, profile: process.platform === 'darwin' ? '.bash_profile' : '.bashrc' };
}

interface Room {
  readonly dir: string;
  readonly home: string;
  readonly prefix: string;
  readonly binDir: string;
  readonly tools: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: { readonly path: string; readonly profile: string };
}

/**
 * A clean room: a fake `HOME`, an npm global prefix nothing else knows about,
 * and a `PATH` holding `node`, `npm`, `npx`, `git` and `sh` — and nothing else.
 *
 * Node's *own* directory is deliberately not on it. On a normal installation
 * that directory is the npm global bin directory, so putting it on `PATH`
 * would hand the room the developer's own global installs — including, on this
 * machine, a `deflow` — and every assertion below would be about the wrong
 * binary.
 */
async function makeRoom(name: string): Promise<Room> {
  const dir = await mkdtemp(join(tmpdir(), `DeFlow-${name}-`));
  rooms.push(dir);
  const home = join(dir, 'home');
  const prefix = join(dir, 'prefix');
  const tools = join(dir, 'tools');
  for (const path of [home, prefix, tools]) mkdirSync(path, { recursive: true });

  for (const binary of ['node', 'npm', 'npx']) {
    const resolved = binary === 'node' ? process.execPath : onHostPath(binary);
    if (resolved === null) throw new Error(`no ${binary} on this machine`);
    symlinkSync(resolved, join(tools, binary));
  }

  const shell = terminalShell();
  return {
    dir,
    home,
    prefix,
    binDir: join(prefix, 'bin'),
    tools,
    shell,
    env: {
      PATH: [tools, gitDir(), systemToolsDir()].join(delimiter),
      HOME: home,
      SHELL: shell.path,
      DeFlow_DATA_DIR: join(dir, 'data'),
      DeFlow_LOG_LEVEL: 'silent',
      npm_config_prefix: prefix,
      npm_config_cache: cache,
      // A locale that establishes UTF-8, so the report is the one an ordinary
      // terminal gets rather than the ASCII fallback.
      LANG: 'en_US.UTF-8',
    },
  };
}

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], room: Room, extra = {}): Ran {
  const child = spawnSync(command, [...args], {
    cwd: room.dir,
    encoding: 'utf8',
    env: { ...room.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 480_000,
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

interface SetupDocument {
  readonly exitCode: number;
  readonly steps: readonly {
    readonly id: string;
    readonly state: string;
    readonly detail: string;
  }[];
}

function parseDocument(ran: Ran): SetupDocument {
  try {
    return JSON.parse(ran.stdout) as SetupDocument;
  } catch {
    throw new Error(
      `setup --json printed no document (exit ${String(ran.status)}):\n${ran.stdout}\n${ran.stderr}`,
    );
  }
}

/**
 * `deflow --version` in a **new** interactive shell, resolving `PATH` from the
 * profile files and from nothing else.
 *
 * The prefix's `bin` directory is not on the `PATH` this shell is given — if
 * the command resolves, it is because the line `setup` wrote is being read.
 */
function inANewShell(room: Room, script: string): Ran {
  const child = spawnSync(room.shell.path, ['-i', '-c', script], {
    cwd: room.dir,
    encoding: 'utf8',
    env: { ...room.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  return { status: child.status, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
}

/**
 * What a room looks like once an installer has finished with it — with the
 * room's own directory names replaced, so that two rooms are comparable.
 *
 * The three things EPIC-20-S12 names: where the binary is, what the profile
 * line says, and what doctor made of the machine.
 */
function endState(
  room: Room,
  document: SetupDocument,
): {
  readonly binary: string;
  readonly profileLine: string;
  readonly doctor: string;
} {
  const profile = join(room.home, room.shell.profile);
  const line =
    (existsSync(profile) ? readFileSync(profile, 'utf8') : '')
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.includes(room.binDir)) ?? '';
  return {
    binary: join(room.binDir, 'deflow').replaceAll(room.prefix, '<prefix>'),
    profileLine: line.replaceAll(room.prefix, '<prefix>'),
    doctor: document.steps.find((step) => step.id === 'doctor')?.state ?? 'absent',
  };
}

suite('EPIC-20-S11 — one command, and deflow works in a shell opened afterwards', () => {
  it('installs from nothing and is found by a new interactive shell', async () => {
    const room = await makeRoom('setup-npx');

    // Given no "deflow" anywhere on this room's PATH — measured, not assumed.
    // Without this, every assertion below is compatible with "the author had
    // one installed globally and the room found that".
    expect(inANewShell(room, 'command -v deflow').stdout.trim()).toBe('');

    // When the new user runs the one command. `--from` points at the packed
    // tarball rather than at the registry, which is the same code path with a
    // different specifier — the release gate cannot verify bytes npm has not
    // published yet.
    const setup = run(
      join(dirname(process.execPath), 'npx'),
      [
        '--yes',
        `--package=${good.tgz}`,
        '--',
        'deflow',
        'setup',
        '--yes',
        '--json',
        '--from',
        good.tgz,
      ],
      room,
    );

    const document = parseDocument(setup);
    expect(document.steps.map((step) => step.id)).toEqual([
      'install',
      'link',
      'verify',
      'doctor',
      'adapters',
    ]);
    // Every step ok — on a clean machine with no vendor CLI, which is what a
    // new user has.
    expect(
      document.steps.filter((step) => step.state !== 'ok').map((step) => [step.id, step.detail]),
    ).toEqual([]);
    expect(setup.status, setup.stderr).toBe(0);

    // Then a shell opened afterwards resolves it and prints the version.
    const fresh = inANewShell(room, 'command -v deflow && deflow --version');
    expect(fresh.status, fresh.stderr).toBe(0);
    const lines = fresh.stdout.trim().split('\n');
    expect(lines.at(-1)?.trim()).toBe(manifest.version);
    // …and the binary it found is inside this room's own prefix, not the
    // machine's. Through realpath on both sides: macOS's tmpdir is a symlink.
    expect(realpathSync(lines[0]?.trim() as string).startsWith(realpathSync(room.prefix))).toBe(
      true,
    );

    // And `deflow doctor` works in that same new shell — the second half of
    // AC15's performed acceptance, automated.
    const doctor = inANewShell(room, 'deflow doctor --json --skip-conformance');
    expect(doctor.stdout).toContain('"sections"');
  }, 900_000);
});

suite('EPIC-20-S12 — the install script reaches the same end state', () => {
  it('bootstraps through sh and leaves the machine the npx path leaves', async () => {
    const viaNpx = await makeRoom('setup-npx-b');
    const viaScript = await makeRoom('setup-script');

    const npx = run(
      join(dirname(process.execPath), 'npx'),
      [
        '--yes',
        `--package=${good.tgz}`,
        '--',
        'deflow',
        'setup',
        '--yes',
        '--json',
        '--from',
        good.tgz,
      ],
      viaNpx,
    );
    expect(npx.status, npx.stderr).toBe(0);

    // The script, run the way the README's safe form runs it: fetched to a
    // file, readable, then executed with `sh`.
    const script = run('sh', [join(repoRoot, 'scripts/install.sh'), '--yes', '--json'], viaScript, {
      DEFLOW_PACKAGE: good.tgz,
    });
    expect(script.status, script.stderr).toBe(0);

    // The same five steps, in the same order, through the same layer.
    const fromScript = parseDocument(script);
    expect(fromScript.steps.map((step) => step.id)).toEqual(
      parseDocument(npx).steps.map((step) => step.id),
    );
    expect(fromScript.steps.map((step) => step.state)).toEqual(
      parseDocument(npx).steps.map((step) => step.state),
    );

    // And a shell opened afterwards resolves the command.
    const fresh = inANewShell(viaScript, 'command -v deflow && deflow --version');
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout.trim().split('\n').at(-1)?.trim()).toBe(manifest.version);

    // The end state — where the binary is, what the profile line says — is the
    // same modulo the room each of them was given.
    expect(endState(viaScript, fromScript)).toEqual(endState(viaNpx, parseDocument(npx)));
    // …and the script wrote no file of its own: the only thing in the home
    // directory is the profile the *setup* command edited.
    expect(existsSync(join(viaScript.home, viaScript.shell.profile))).toBe(true);
  }, 900_000);
});

/** Kept honest: the tarball this suite installs is the one `pnpm pack` made. */
it('installs the packed tarball rather than anything in the working tree', () => {
  expect(good.tgz.endsWith('.tgz')).toBe(true);
  expect(execFileSync('tar', ['tzf', good.tgz], { encoding: 'utf8' })).toContain(
    'package/dist/bin.mjs',
  );
});
