/**
 * KAR-18.6 — the mechanics behind `pnpm verify:install`, factored out of the
 * script (`./run.ts`) so the same functions drive both the real release gate
 * and its own test suite (`e2e/install-verification*.test.ts`,
 * `packages/cli/test/integration/verify-install-bin.test.ts`).
 *
 * `pnpm build` producing a green local run proves nothing about the tarball
 * (docs/03-local-development.md §10) — every function here works against
 * bytes that actually went through `pnpm pack`, never against
 * `packages/cli/src` directly. The one exception is `checkBinExecutable`,
 * which reads a built file off disk rather than a packed one; a file's mode
 * and first byte survive packing and unpacking unchanged; `npm`'s bin-shim
 * layer is exercised in the e2e specs, not here.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const cliDir = join(repoRoot, 'packages/cli');

/** git's own directory — one of the few PATH entries a clean room needs besides node's. */
export function gitDir(): string {
  return dirname(
    execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim(),
  );
}

let toolsDirCache: string | undefined;

/**
 * A directory holding nothing but a `sh` symlink — real npm shells out to it
 * internally even for a bare `npm exec`, ENOENT otherwise. A single-purpose
 * symlink farm rather than handing over the system's own `/bin` or
 * `/usr/bin`: on a merged-`/usr` Linux with a compiler installed, `sh` and
 * `gcc` can be the same directory, and AC4 / EPIC-18-S45 exist specifically
 * to prove no compiler is reachable. Resolving and re-linking one named
 * binary is the only way to hand `sh` over without handing over its
 * neighbours too.
 */
export function systemToolsDir(): string {
  if (toolsDirCache !== undefined) return toolsDirCache;
  const dir = mkdtempSync(join(tmpdir(), 'DeFlow-systools-'));
  const sh = execFileSync('/usr/bin/env', ['sh', '-c', 'command -v sh'], {
    encoding: 'utf8',
  }).trim();
  symlinkSync(sh, join(dir, 'sh'));
  toolsDirCache = dir;
  return dir;
}

/** Removes the cached `systemToolsDir()`, unless `DeFlow_KEEP_TMP` is set. Idempotent. */
export function cleanupSystemToolsDir(): void {
  if (toolsDirCache === undefined || process.env.DeFlow_KEEP_TMP !== undefined) return;
  rmSync(toolsDirCache, { recursive: true, force: true });
  toolsDirCache = undefined;
}

export interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Ran {
  const child = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    env: env ?? process.env,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

/** What a failed child said for itself, folded into a thrown error's message. */
function said(label: string, child: Ran): string {
  return `${label} exited ${String(child.status)}\n--- stdout\n${child.stdout.trim()}\n--- stderr\n${child.stderr.trim()}`;
}

function must(label: string, child: Ran): Ran {
  if (child.status !== 0) throw new Error(said(label, child));
  return child;
}

export interface PackOptions {
  /** Skip `pnpm build`, reusing whatever is already at `packages/cli/dist`. */
  readonly skipBuild?: boolean;
  /** Skip `pnpm pack:check` (publint + attw). Off by default: AC1's own order. */
  readonly skipPackCheck?: boolean;
  /** Where `pnpm pack` writes the tarball. Defaults to a fresh temp directory. */
  readonly destDir?: string;
}

export interface PackedTarball {
  readonly tgz: string;
  readonly distDir: string;
  /** The scratch directory `tgz` lives under — what `cleanupPackedTarball` removes. */
  readonly scratchRoot: string;
}

/** Removes a tarball's scratch directory, unless `DeFlow_KEEP_TMP` is set. */
export function cleanupPackedTarball(pack: PackedTarball): void {
  if (process.env.DeFlow_KEEP_TMP !== undefined) return;
  rmSync(pack.scratchRoot, { recursive: true, force: true });
}

/**
 * AC1's first three steps: `pnpm build`, `pnpm pack:check`, `cd packages/cli
 * && pnpm pack`. The fixed order is load-bearing (docs/03 §10) — packing a
 * stale `dist/` packs the previous release, and `pack:check` after `pack`
 * would lint bytes nobody shipped.
 */
export function packGoodTarball(options: PackOptions = {}): PackedTarball {
  if (options.skipBuild !== true) {
    must('pnpm build', run('node', ['packages/cli/scripts/build.ts'], repoRoot));
  }
  if (options.skipPackCheck !== true) {
    must('pnpm pack:check', run('pnpm', ['--filter', 'DeFlow', 'exec', 'publint'], repoRoot));
    must('attw --pack', run('pnpm', ['--filter', 'DeFlow', 'exec', 'attw', '--pack'], repoRoot));
  }
  const destDir = options.destDir ?? mkdtempSync(join(tmpdir(), 'DeFlow-pack-'));
  const packed = must(
    'pnpm pack',
    run('pnpm', ['pack', '--pack-destination', destDir, '--json'], cliDir),
  );
  // Unlike `npm pack --json` (an array of entries, `filename` a bare
  // basename), `pnpm pack --json` prints a single object whose `filename` is
  // already the full path it was written to.
  const entry = JSON.parse(packed.stdout) as { filename?: string };
  if (typeof entry.filename !== 'string') {
    throw new Error(`pnpm pack --json returned no filename:\n${packed.stdout}`);
  }
  return { tgz: entry.filename, distDir: join(cliDir, 'dist'), scratchRoot: destDir };
}

/**
 * AC5 — a deliberately broken variant, built from the *real* packed tarball
 * so its `dependencies` carry real resolved versions rather than the
 * workspace's `catalog:` protocol, which only pnpm understands. `mutate`
 * edits the extracted `package.json` in place (typically `files`); everything
 * else about the package is untouched.
 *
 * This is the one function in the file that calls plain `npm pack` rather
 * than `pnpm pack`: the extracted directory is a scratch copy outside the
 * pnpm workspace, and `npm pack` is what a person with no pnpm on their
 * machine would run against it too.
 */
export function packBrokenTarball(
  good: PackedTarball,
  mutate: (pkg: Record<string, unknown>) => void,
): PackedTarball {
  const stageRoot = mkdtempSync(join(tmpdir(), 'DeFlow-broken-'));
  const extractedRoot = join(stageRoot, 'extracted');
  const destDir = join(stageRoot, 'out');
  must('tar (extract)', run('tar', ['xzf', good.tgz, '-C', stageRoot], stageRoot));
  const packageDir = join(stageRoot, 'package');
  cpSync(packageDir, extractedRoot, { recursive: true });
  rmSync(packageDir, { recursive: true, force: true });

  const pkgPath = join(extractedRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  mutate(pkg);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  mkdirSync(destDir, { recursive: true });

  const packed = must(
    'npm pack (broken variant)',
    run('npm', ['pack', '--json', '--pack-destination', destDir], extractedRoot),
  );
  const [entry] = JSON.parse(packed.stdout) as { filename: string }[];
  if (entry === undefined) throw new Error(`npm pack --json returned no entry:\n${packed.stdout}`);
  return {
    tgz: join(destDir, entry.filename),
    distDir: join(extractedRoot, 'dist'),
    scratchRoot: stageRoot,
  };
}

/**
 * AC4's other half, checked statically rather than by installing: the two
 * things `npm`'s own bin-shim generation depends on and `pnpm pack` cannot
 * verify for you. Empty when the file is healthy.
 */
export function checkBinExecutable(binPath: string): string[] {
  const defects: string[] = [];
  const bytes = readFileSync(binPath);
  if (bytes.length === 0 || bytes[0] !== '#'.charCodeAt(0)) {
    defects.push(`shebang missing from ${binPath}`);
  }
  const mode = statSync(binPath).mode;
  if ((mode & 0o111) !== 0o111) {
    defects.push(`${binPath} is not executable`);
  }
  return defects;
}

export interface CliInstall {
  readonly room: string;
  readonly repoDir: string;
  readonly dataDir: string;
  readonly npmCacheDir: string;
}

/**
 * `mktemp -d`, `git init -b main demo` — the clean room itself, with no
 * `node_modules` above it, exactly as AC1 and the flow scenario describe.
 * `npm_config_cache` is pinned inside the room so a real install never
 * touches the machine's own `~/.npm`, and so cleanup takes it with the rest.
 *
 * The prefix is exactly `DeFlow-`, matching `@DeFlow/testkit`'s own
 * `TMP_PREFIX`: the normalising snapshot serializer collapses
 * `<tmp>/DeFlow-<random>` to `<tmp>` (docs/14-testing-strategy.md §9), which a
 * longer, hyphenated prefix would not match, leaving the random suffix — and
 * therefore the snapshot — different on every run.
 */
export async function makeCleanRoom(): Promise<CliInstall> {
  const room = await mkdtemp(join(tmpdir(), 'DeFlow-'));
  const repoDir = join(room, 'demo');
  const dataDir = join(room, 'data');
  const npmCacheDir = join(room, 'npm-cache');
  must(
    'git init',
    run('git', ['init', '-b', 'main', repoDir], room, {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    }),
  );
  return { room, repoDir, dataDir, npmCacheDir };
}

/** Removes `room` unless `DeFlow_KEEP_TMP` is set. Returns whether it did. */
export async function removeCleanRoom(room: string): Promise<boolean> {
  if (process.env.DeFlow_KEEP_TMP !== undefined) return false;
  await rm(room, { recursive: true, force: true });
  return true;
}

export interface CliProcess {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stop: () => Promise<void>;
}

export interface SpawnInstalledOptions {
  readonly tgz: string;
  readonly bin: 'DeFlow' | 'DeFlow-mock-agent' | 'DeFlow-mcp';
  readonly argv: readonly string[];
  readonly install: CliInstall;
  /** Directories prepended to PATH, before node's own and git's. */
  readonly binDirs?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The real bytes, run the way a user runs them: `npm exec --package=<tgz> --
 * <bin> <argv>`. This is the fixed-up equivalent of the docs' `npx <tgz>
 * <argv>` — verified by hand against this repository's npm 11: a bare `npx
 * /path/to/x.tgz` treats the path as a literal command to execute rather
 * than as an installable spec, which is the older npx's behaviour and not
 * this one's (see `npm help npx`'s "Compatibility with Older npx Versions").
 * `--package=<tgz>` is what makes npm actually install the tarball's
 * dependencies before resolving the bin.
 */
export function spawnInstalled(options: SpawnInstalledOptions): CliProcess {
  const out: string[] = [];
  const err: string[] = [];
  const path = [
    ...(options.binDirs ?? []),
    dirname(process.execPath),
    gitDir(),
    systemToolsDir(),
  ].join(':');

  const child = spawn(
    join(dirname(process.execPath), 'npx'),
    ['--yes', `--package=${options.tgz}`, '--', options.bin, ...options.argv],
    {
      cwd: options.cwd ?? options.install.repoDir,
      env: {
        PATH: path,
        HOME: options.install.dataDir,
        DeFlow_DATA_DIR: options.install.dataDir,
        DeFlow_LOG_LEVEL: 'silent',
        DeFlow_DEV: '0',
        BROWSER: 'none',
        npm_config_cache: options.install.npmCacheDir,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk.toString()));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([exited, sleep(10_000).then(() => child.kill('SIGKILL'))]);
    await exited;
  };

  return { child, stdout: () => out.join(''), stderr: () => err.join(''), exited, stop };
}

/** Runs a `DeFlow` subcommand to completion and returns its result. */
export async function runInstalled(
  options: Omit<SpawnInstalledOptions, 'argv'> & { readonly argv: readonly string[] },
): Promise<Ran> {
  const cli = spawnInstalled(options);
  const { code } = await cli.exited;
  return { status: code, stdout: cli.stdout(), stderr: cli.stderr() };
}

export async function waitForUrl(cli: CliProcess, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = /^http:\/\/127\.0\.0\.1:\d+\/#token=\S+$/m.exec(cli.stdout());
    if (match !== null) return match[0];
    if (cli.child.exitCode !== null) {
      throw new Error(
        `DeFlow up exited with ${cli.child.exitCode} before printing a URL:\n${cli.stderr()}`,
      );
    }
    await sleep(50);
  }
  throw new Error(`DeFlow up printed no URL within ${timeoutMs} ms:\n${cli.stderr()}`);
}

/**
 * AC1's own assertion, and S43's negative image of it: "GET /api/health
 * answers 200" and "GET /" returning HTML are not enough — only a referenced
 * `/assets/*` request that actually returns JavaScript tells "the UI shipped"
 * from "the blank page shipped" apart, because the SPA fallback answers 200
 * with `index.html`'s bytes for *any* unmatched path, `.js` extension
 * included (docs/03 §10, the daemon's own `app.get('*', …)`).
 */
export async function assertUiShipped(baseUrl: string): Promise<{ assetPath: string }> {
  const health = await fetch(`${baseUrl}/api/health`);
  if (health.status !== 200) throw new Error(`GET /api/health returned ${health.status}`);

  const page = await fetch(`${baseUrl}/`);
  if (page.status !== 200) throw new Error(`GET / returned ${page.status}`);
  const html = await page.text();
  const match = /(?:src|href)="(\/assets\/[^"]+\.(?:js|mjs))"/.exec(html);
  if (match === null) {
    throw new Error(`GET / returned no /assets/*.js reference:\n${html}`);
  }
  const assetPath = match[1] as string;

  const asset = await fetch(`${baseUrl}${assetPath}`);
  const contentType = asset.headers.get('content-type') ?? '';
  if (asset.status !== 200 || !/javascript/.test(contentType)) {
    throw new Error(
      `GET ${assetPath} returned ${asset.status} content-type "${contentType}" — the UI did not ship ` +
        `(index.html served fine, which is the blank-page failure this check exists to catch)`,
    );
  }
  return { assetPath };
}

/** AC4 — nothing in the install transcript may name node-gyp. */
export function assertNoNodeGyp(installLog: string): void {
  if (/node-gyp/i.test(installLog)) {
    throw new Error(`the install log mentions node-gyp:\n${installLog}`);
  }
}

/** A `<binDir>/claude-agent-acp` shim onto the tarball's own installed mock agent. */
export async function shimMockAgent(binDir: string, mockAgentBin: string): Promise<string> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'claude-agent-acp');
  writeFileSync(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentBin)} "$@"\n`,
    {
      mode: 0o755,
    },
  );
  chmodSync(path, 0o755);
  return path;
}

/** The installed tarball's own `DeFlow-mock-agent`, resolved off the npx cache
 * this process just populated by running a `DeFlow` subcommand once. */
export async function findInstalledMockAgent(npmCacheDir: string): Promise<string> {
  const npxRoot = join(npmCacheDir, '_npx');
  const entries = await readdir(npxRoot);
  for (const entry of entries) {
    const candidate = join(npxRoot, entry, 'node_modules/.bin/DeFlow-mock-agent');
    try {
      statSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `no DeFlow-mock-agent found under ${npxRoot} — did a DeFlow subcommand run first?`,
  );
}
