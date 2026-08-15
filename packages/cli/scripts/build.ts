#!/usr/bin/env node
/**
 * `pnpm build` — the whole release build, in the one order that works.
 *
 *   1. `vite build` in `packages/web`      -> packages/web/dist
 *   2. copy that                            -> packages/cli/dist/ui/
 *   3. `tsdown` in `packages/cli`           -> packages/cli/dist/*.mjs
 *
 * The order is load-bearing and every wrong version of it is silent. Copy
 * before the web build and `dist/ui/` holds the *previous* build, or nothing.
 * Let the bundler clean the whole of `dist/` and it deletes the UI that step 2
 * just wrote. In both cases the tarball installs, the daemon starts, `/api/*`
 * answers, and the page is blank — and no test inside the monorepo notices,
 * because `pnpm dev` serves the UI through Vite middleware and never reads
 * `dist/ui/` at all (docs/03-local-development.md §10).
 *
 * It is a script rather than three `&&`-joined commands in package.json so that
 * the order has one home and `packages/cli/test/integration/build.test.ts` can
 * run the real thing. `--out-dir` exists for that test's sake and defaults to
 * the `packages/cli/dist` the `bin` map and `files` both name.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const cliDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(cliDir, '..', '..');
const webDir = join(repoRoot, 'packages/web');

/** The three files that must end up executable (AC6). */
const BINS = ['bin.mjs', 'mcp.mjs', 'mock-agent.mjs'];

function outDirFrom(argv: readonly string[]): string {
  const flag = argv.indexOf('--out-dir');
  if (flag === -1) return join(cliDir, 'dist');
  const value = argv.at(flag + 1);
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--out-dir needs a directory');
  }
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function step(label: string, command: string, args: readonly string[], cwd: string): void {
  process.stdout.write(`\n> ${label}\n`);
  const child = spawnSync(command, [...args], { cwd, stdio: 'inherit', env: process.env });
  if (child.status !== 0) {
    throw new Error(`${label} failed with exit code ${String(child.status)}`);
  }
}

const outDir = outDirFrom(process.argv.slice(2));
const webDist = join(webDir, 'dist');

// 1. The SPA. `--emptyOutDir` because a stale asset from a previous build is
//    dead weight in the tarball with a name nothing references.
step('vite build (@DeFlow/web)', 'pnpm', ['exec', 'vite', 'build', '--emptyOutDir'], webDir);

// 2. The copy, and it must be a copy of *this* build: refuse rather than ship
//    an empty ui/, which is the failure that reads as "the daemon serves a
//    blank page" three steps later.
if (!statSync(webDist).isDirectory()) {
  throw new Error(`${webDist} is not a directory; the web build did not produce one`);
}
const uiDir = join(outDir, 'ui');
rmSync(uiDir, { recursive: true, force: true });
mkdirSync(dirname(uiDir), { recursive: true });
cpSync(webDist, uiDir, { recursive: true });
process.stdout.write(`\n> copied ${webDist} -> ${uiDir}\n`);

// 3. The JavaScript of the previous build, and only it. `tsdown.config.ts`
//    declares `clean: ['*.mjs', '*.d.mts', '*.map']` for this and the globs
//    match nothing: they are resolved against the project root rather than
//    against `--out-dir`, so `dist/` accumulated every content-hashed chunk of
//    every build ever run — sixty files and 109 MB of them by the time anyone
//    looked, with `files: ["dist"]` ready to publish the lot. The config keeps
//    saying it because it is the statement of intent; this is where the intent
//    is carried out, beside the `rmSync` above and for the same reason. `ui/`
//    is a directory and survives, which is the whole point of not saying
//    `clean: true`.
for (const stale of readdirSync(outDir, { withFileTypes: true })) {
  if (!stale.isFile()) continue;
  if (/\.(?:mjs|d\.mts|map)$/.test(stale.name)) rmSync(join(outDir, stale.name));
}

// 4. The bundle, on top of the UI rather than instead of it. `--out-dir` is
//    forwarded so everything lands in the directory the copy just wrote into.
step('tsdown (DeFlow)', 'pnpm', ['exec', 'tsdown', '--out-dir', outDir], cliDir);

// The exec bit. npm sets it on install from the `bin` map, so this is belt and
// braces — but `npx ./deflow-0.1.0.tgz` and a plain `./dist/bin.mjs` both read
// the mode off the file, and a bin that is not executable is a bug report about
// permissions rather than about DeFlow.
for (const bin of BINS) {
  const path = join(outDir, bin);
  chmodSync(path, statSync(path).mode | 0o111);
}

process.stdout.write(`\nbuilt ${outDir}\n`);
