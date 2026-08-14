/**
 * KAR-04.1 AC1 — `deflow-mock-agent` is a shipped bin, not a test helper.
 *
 * The classic "works locally, broken on npm" failure is a `files` array that
 * omits the executable, or a `bin` entry pointing at a path that only exists in
 * the workspace. Neither is visible from inside the repository, so this spec
 * packs the package for real and runs the bin out of the extracted tarball,
 * from a directory that is not the workspace.
 *
 * Two deliberate limits.
 *
 * The registry fetch of `@agentclientprotocol/sdk` is replaced by a symlink to
 * the same version already on this machine, because the epic's whole suite must
 * run offline with no credential and no network
 * (docs/delivery/epics/EPIC-04-mock-agent.md, Definition of Done). What is
 * under test is the tarball's contents and the bin's ability to run with no
 * build step, not npm's ability to download.
 *
 * The **aggregate** `deflow` tarball — the one that carries this bin as its
 * second bin alongside the bundled daemon — is KAR-18.6's clean-room job. It
 * cannot be packed here: `packages/cli` depends on `@DeFlow/daemon` through the
 * `workspace:` protocol, which resolves to nothing until those packages are
 * built and published.
 *
 * Verifies: AC1
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { spawnMockAgent } from '../support/harness.ts';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

let tmp = '';
let packageDir = '';
let entries: string[] = [];
let installedBin = '';

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'DeFlow-'));

  execFileSync('pnpm', ['--filter', '@DeFlow/mock-agent', 'pack', '--pack-destination', tmp], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  const tarball = join(tmp, readdirSync(tmp).find((name) => name.endsWith('.tgz')) ?? '');

  entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.trim() !== '');
  execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
  packageDir = join(tmp, 'package');

  // What `npm install <tgz>` would leave behind: the declared dependency
  // resolvable from a node_modules above the package, and the bin linked into
  // node_modules/.bin under its declared name.
  const sdk = dirname(dirname(fileURLToPath(import.meta.resolve('@agentclientprotocol/sdk'))));
  await mkdir(join(tmp, 'node_modules', '@agentclientprotocol'), { recursive: true });
  await symlink(sdk, join(tmp, 'node_modules', '@agentclientprotocol', 'sdk'));

  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };
  const declared = manifest.bin?.['deflow-mock-agent'];
  expect(declared, 'package.json must declare a deflow-mock-agent bin').toBeTypeOf('string');

  await mkdir(join(tmp, 'node_modules', '.bin'), { recursive: true });
  installedBin = join(tmp, 'node_modules', '.bin', 'deflow-mock-agent');
  await symlink(join(packageDir, declared ?? ''), installedBin);
}, 120_000);

afterAll(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(tmp, { recursive: true, force: true });
});

suite('AC1 — the bin survives a pnpm pack', () => {
  it('ships the executable and its sources, and nothing built', () => {
    expect(entries).toContain('package/bin/mock-agent.ts');
    expect(entries.some((entry) => entry.startsWith('package/src/'))).toBe(true);
    // "No build step" is not a preference here: nothing in this repository
    // compiles before a test runs, so a tarball that needed dist/ would be a
    // tarball nobody could run.
    expect(entries.filter((entry) => entry.startsWith('package/dist/'))).toEqual([]);
  });

  it('keeps the shebang and the executable mode bit', async () => {
    const source = await readFile(join(packageDir, 'bin', 'mock-agent.ts'), 'utf8');
    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
    // Losing the bit is not a loud failure: the shell skips the file during a
    // PATH lookup and finds something else further along.
    expect(statSync(join(packageDir, 'bin', 'mock-agent.ts')).mode & 0o111).not.toBe(0);
  });

  it('runs --help from the installed bin with exit 0', async () => {
    const agent = spawnMockAgent(['--help'], { bin: installedBin });
    const exit = await agent.exited();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(agent.stdout().toString('utf8')).toContain('deflow-mock-agent');
    expect(agent.stderr()).toBe('');
  });
});
