/**
 * KAR-20.1 AC4–AC7 — `DeFlow` keeps working for one release, and says so once.
 *
 * The design this file pins is the one AC7 states rather than works around:
 * **there is one entry script**, and the notice is decided at runtime from
 * `basename(process.argv[1])`. On a case-sensitive filesystem `deflow` and
 * `DeFlow` are two directory entries pointing at that one script; on APFS they
 * are one entry, and the spelling the operator typed still arrives in `argv[1]`
 * because the shell passes what it was given. So the *same* code path serves
 * both platforms, and the only thing that is allowed to differ is how many
 * files `readdir` reports.
 *
 * Every link here is a symlink to `src/bin.ts` rather than to a built
 * `dist/bin.mjs`: this is an integration spec, not a release gate, and what it
 * is about — argv, streams and exit codes — is identical either way. The
 * tarball's own bin names are KAR-18.6's clean room — EPIC-20-S2, automated in
 * `e2e/install-verification.test.ts`, which spawns all three of them from the
 * packed bytes.
 *
 * Verifies: EPIC-20-S3 · EPIC-20-S4 · EPIC-20-S5 · AC4, AC5, AC7
 */
import { makeRepo, makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  ALIAS_REMOVED_IN,
  COMMAND,
  DEPRECATED_COMMAND,
  deprecationNotice,
} from '../../src/command-name.ts';
import { doctorEnv } from './support/doctor-fixture.ts';

/** The exact line the old name prints — the thing no stdout may carry. */
const NOTICE = (deprecationNotice(`/bin/${DEPRECATED_COMMAND}`) ?? '').trim();

const CLI_BIN = fileURLToPath(new URL('../../src/bin.ts', import.meta.url));

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Spawns the entry script **through a named link**, so `process.argv[1]`
 * carries the spelling the caller used — which is the whole mechanism under
 * test. `stdout` is a pipe, never a TTY, which is also the condition AC5 cares
 * about.
 */
function runAs(entry: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<Ran>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: out.join(''), stderr: err.join('') }));
  });
}

interface Linked {
  readonly dir: string;
  readonly newName: string;
  readonly oldName: string;
  /** Two directory entries on ext4, one on APFS — the property, not a guess. */
  readonly caseSensitive: boolean;
}

/**
 * A "global bin directory" holding both names.
 *
 * The second `symlink` is *attempted* rather than assumed: on a
 * case-insensitive volume it fails with EEXIST, and that failure is the
 * observation EPIC-20-S5's second scenario is made of. Nothing here special-cases
 * `process.platform` — the filesystem is asked.
 */
async function linkBothNames(name: string): Promise<Linked> {
  const dir = join(tmp, name);
  await mkdir(dir, { recursive: true });
  const newName = join(dir, COMMAND);
  const oldName = join(dir, DEPRECATED_COMMAND);
  await symlink(CLI_BIN, newName);
  let caseSensitive = true;
  try {
    await symlink(CLI_BIN, oldName);
  } catch {
    caseSensitive = false;
  }
  return { dir, newName, oldName, caseSensitive };
}

async function workspace(name: string): Promise<string> {
  const repo = await makeRepo({ dir: join(tmp, name) });
  await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
  return repo.dir;
}

suite('the old name runs the same program (AC4, EPIC-20-S3)', () => {
  it('produces identical stdout and identical exit codes, with one extra stderr line', async () => {
    const links = await linkBothNames('same-program');
    const cwd = await workspace('same-program-repo');
    const env = doctorEnv({ dataDir: join(tmp, 'same-program-data'), realGit: true });

    for (const args of [['--help'], ['--version'], ['status', '--json']]) {
      const modern = await runAs(links.newName, args, env, cwd);
      const legacy = await runAs(links.oldName, args, env, cwd);

      expect({ args, stdout: legacy.stdout }).toEqual({ args, stdout: modern.stdout });
      expect({ args, code: legacy.code }).toEqual({ args, code: modern.code });
    }
  });

  it('writes exactly one notice line, naming both names and the release it goes in', async () => {
    const links = await linkBothNames('one-line');
    const cwd = await workspace('one-line-repo');
    const env = doctorEnv({ dataDir: join(tmp, 'one-line-data'), realGit: true });

    const legacy = await runAs(links.oldName, ['--version'], env, cwd);
    const lines = legacy.stderr.split('\n').filter((line) => line !== '');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(DEPRECATED_COMMAND);
    expect(lines[0]).toContain(COMMAND);
    expect(lines[0]).toContain(ALIAS_REMOVED_IN);
  });

  it('says nothing on stderr when the new name was used', async () => {
    const links = await linkBothNames('quiet');
    const cwd = await workspace('quiet-repo');
    const env = doctorEnv({ dataDir: join(tmp, 'quiet-data'), realGit: true });

    const modern = await runAs(links.newName, ['--version'], env, cwd);
    expect(modern.stderr).toBe('');
  });
});

suite('the notice never contaminates a machine-readable stream (AC5, EPIC-20-S4)', () => {
  it('keeps --json documents parseable with the streams interleaved on disk', async () => {
    const links = await linkBothNames('json');
    const cwd = await workspace('json-repo');
    const env = doctorEnv({ dataDir: join(tmp, 'json-data'), realGit: true });

    for (const args of [
      ['doctor', '--json', '--skip-conformance'],
      ['status', '--json'],
    ]) {
      const legacy = await runAs(links.oldName, args, env, cwd);

      // The `2>&1 > file` case, the one a shell actually produces: stdout goes
      // to the file, stderr goes somewhere else, and the file has to be a
      // document on its own.
      const document: unknown = JSON.parse(legacy.stdout);
      expect({ args, parsed: typeof document }).toEqual({ args, parsed: 'object' });
      // The **notice**, not the word: `doctor --json` legitimately reports the
      // `$XDG_DATA_HOME/DeFlow` state directory and the `DeFlow_*` variables,
      // both of which AC8 keeps exactly as they are.
      expect({ args, contaminated: legacy.stdout.includes(NOTICE) }).toEqual({
        args,
        contaminated: false,
      });
      expect({ args, noticed: legacy.stderr.includes(ALIAS_REMOVED_IN) }).toEqual({
        args,
        noticed: true,
      });
    }
  });

  it('survives both streams being redirected to the same file and filtered on stdout', async () => {
    const links = await linkBothNames('same-file');
    const cwd = await workspace('same-file-repo');
    const env = doctorEnv({ dataDir: join(tmp, 'same-file-data'), realGit: true });

    const legacy = await runAs(links.oldName, ['status', '--json'], env, cwd);
    const merged = join(tmp, 'merged.txt');
    await writeFile(merged, legacy.stdout + legacy.stderr, 'utf8');

    // Filtering the merged file on "what stdout wrote" has to leave a document.
    const text = await readFile(merged, 'utf8');
    const withoutNotice = text
      .split('\n')
      .filter((line) => !line.includes(NOTICE))
      .join('\n');
    expect(() => JSON.parse(withoutNotice) as unknown).not.toThrow();
  });
});

suite('one entry on APFS, two on ext4 (AC7, EPIC-20-S5)', () => {
  it('runs the program under either spelling, and only the old one is noticed', async () => {
    const links = await linkBothNames('entries');
    const cwd = await workspace('entries-repo');
    const env = doctorEnv({ dataDir: join(tmp, 'entries-data'), realGit: true });

    const entries = (await readdir(links.dir)).sort();
    expect(entries).toEqual(links.caseSensitive ? [DEPRECATED_COMMAND, COMMAND].sort() : [COMMAND]);

    // The behaviour that is never allowed to differ: the program runs, under
    // both spellings, on both filesystems.
    const modern = await runAs(links.newName, ['--version'], env, cwd);
    const legacy = await runAs(links.oldName, ['--version'], env, cwd);
    expect([modern.code, legacy.code]).toEqual([0, 0]);
    expect(legacy.stdout).toBe(modern.stdout);

    // And the notice follows the *spelling*, not the file.
    expect(modern.stderr).toBe('');
    expect(legacy.stderr).toContain(ALIAS_REMOVED_IN);
  });
});

suite('a repository initialised before the rename keeps working (EPIC-20-S9)', () => {
  it('reads .DeFlow/ as it stands and migrates nothing', async () => {
    const links = await linkBothNames('legacy-state');
    const repo = await makeRepo({ dir: join(tmp, 'legacy-repo') });
    const deflowDir = join(repo.dir, '.DeFlow');
    await mkdir(join(deflowDir, 'gates'), { recursive: true });
    await mkdir(join(deflowDir, 'memory'), { recursive: true });
    await writeFile(join(deflowDir, 'config.yaml'), 'budget:\n  usd: 12\n', 'utf8');
    await writeFile(join(deflowDir, 'gates', 'house-style.md'), '# house style\n', 'utf8');
    await writeFile(join(deflowDir, 'memory', 'notes.md'), '# what we learned\n', 'utf8');

    const before = await snapshotOf(deflowDir);
    const env = doctorEnv({ dataDir: join(tmp, 'legacy-data'), realGit: true });

    const doctor = await runAs(
      links.newName,
      ['doctor', '--json', '--skip-conformance'],
      env,
      repo.dir,
    );
    const status = await runAs(links.newName, ['status', '--json'], env, repo.dir);

    expect(typeof (JSON.parse(doctor.stdout) as unknown)).toBe('object');
    expect(status.code).toBe(0);
    expect(await snapshotOf(deflowDir)).toEqual(before);
  });
});

/** Every file under a directory, with its bytes — "nothing was rewritten", read. */
async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      out[full.slice(dir.length)] = await readFile(full, 'utf8');
    }
  }
  return out;
}
