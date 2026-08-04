/**
 * KAR-00.5 — one environment, probed.
 *
 * This file runs unchanged on the author's macOS laptop and inside each of the
 * three Linux containers, because the question it answers — "does this native
 * dependency install and load here, without a compiler?" — is the same question
 * in all five cells and must be asked the same way in all five.
 *
 * It is plain `.mjs`, not TypeScript, for one reason: it has to start on
 * whatever `node` the image happens to carry, including images whose type
 * stripping is not something this spike wants to be a variable.
 *
 * Everything it does is real. The installs are real `npm i` runs into real
 * empty directories, executed with a PATH that has been replaced by a sandbox
 * `bin/` holding symlinks to `node` and `npm` and nothing else, so
 * "no compiler was available" is a fact about the process rather than a hopeful
 * reading of the log. The SQLite work runs against a file on disk. The pty is a
 * real pty, and its device path is read by running `tty` inside it.
 *
 * Output: one JSON object on stdout, after a marker line, so that a container's
 * own noise cannot be mistaken for the report.
 *
 * Usage:  node probe.mjs [--cell <id>] [--keep]
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPORT_MARKER = '---S5-PROBE-JSON---';

const BETTER_SQLITE3_SPEC = 'better-sqlite3@13.0.2';
const LYDELL_PTY_SPEC = '@lydell/node-pty@1.2.0-beta.14';
const UPSTREAM_PTY_SPEC = 'node-pty@1.1.0';

/**
 * The names a native install would reach for. `node-gyp` is on the list twice
 * over: as a binary that must not be reachable, and as a string that must not
 * appear in the log.
 */
const COMPILER_NAMES = ['cc', 'c++', 'clang', 'clang++', 'gcc', 'g++', 'make', 'node-gyp'];

/**
 * Substrings in an npm log that mean a compile happened or was attempted.
 * `node-addon-api` is better-sqlite3's only dependency and is header-only, so
 * its presence is not evidence of anything; `gyp` in any form is.
 */
const COMPILATION_MARKERS = ['gyp', 'prebuild-install', 'cc1plus', 'make: ', 'clang:'];

const FTS5_TOKENIZER = "unicode61 remove_diacritics 2 tokenchars '_-.'";

/** Terms that must survive tokenization whole, and the fragments that must not appear. */
const WHOLE_TERMS = ['snake_case_name', 'kebab-case-name', 'file.ext'];
const FRAGMENTS = ['case', 'name', 'ext'];

const temporaries = [];

function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `s5-${prefix}-`));
  temporaries.push(dir);
  return dir;
}

/** A PATH containing `node` and `npm` and demonstrably nothing else. */
function sandboxPath() {
  const dir = scratch('bin');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));

  const npm = which('npm', process.env.PATH ?? '');
  if (npm === null) throw new Error('no npm on PATH; the probe cannot install anything');
  symlinkSync(npm, join(bin, 'npm'));

  // `sh` is here deliberately. npm runs install scripts through it, and a
  // sandbox without a shell would make every install script fail with
  // `spawn sh ENOENT` — which would let AC7's claim about upstream node-pty
  // pass for the wrong reason. A shell is not a toolchain.
  const sh = which('sh', process.env.PATH ?? '') ?? '/bin/sh';
  symlinkSync(sh, join(bin, 'sh'));
  return bin;
}

function which(name, path) {
  for (const dir of path.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function glibcVersion() {
  const version = process.report?.getReport()?.header?.glibcVersionRuntime;
  return typeof version === 'string' && version !== '' ? version : null;
}

function libc() {
  if (process.platform === 'darwin') return 'darwin';
  if (glibcVersion() !== null) return 'glibc';
  return existsSync('/lib/ld-musl-aarch64.so.1') || existsSync('/lib/ld-musl-x86_64.so.1')
    ? 'musl'
    : 'unknown';
}

function environment(path) {
  const compilersOnPath = {};
  for (const name of COMPILER_NAMES) compilersOnPath[name] = which(name, path);
  return {
    platform: process.platform,
    arch: process.arch,
    libc: libc(),
    glibcVersion: glibcVersion(),
    nodeVersion: process.version,
    path,
    compilersOnPath,
  };
}

/**
 * `npm i <spec>` into a fresh empty directory, with the sandbox PATH and no
 * inherited npm configuration. `--foreground-scripts` is on so that if an
 * install script ever did run, its output would land in the log rather than
 * being swallowed.
 */
function install(spec, path) {
  const dir = scratch('install');
  writeFileSync(join(dir, 'package.json'), '{"private":true,"name":"s5-probe","version":"0.0.0"}');

  const started = process.hrtime.bigint();
  const result = spawnSync(
    join(path, 'npm'),
    ['install', spec, '--no-audit', '--no-fund', '--foreground-scripts', '--loglevel=info'],
    {
      cwd: dir,
      encoding: 'utf8',
      // HOME is the real one on purpose: npm's cache is a property of the
      // machine a developer actually has, and pointing it at an empty temp
      // directory would measure the network rather than the toolchain. The
      // note records the cache state next to the number.
      env: { PATH: path, HOME: process.env.HOME ?? dir, npm_config_update_notifier: 'false' },
    },
  );
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  const name = spec.slice(0, spec.lastIndexOf('@'));
  const packageDir = join(dir, 'node_modules', name);
  const manifest = existsSync(join(packageDir, 'package.json'))
    ? JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
    : null;
  const scripts = manifest?.scripts ?? {};
  const prebuildsDir = join(packageDir, 'prebuilds');

  return {
    spec,
    dir,
    ok: result.status === 0,
    durationMs,
    log,
    compilationMarkers: COMPILATION_MARKERS.filter((marker) => log.toLowerCase().includes(marker)),
    installScripts: ['preinstall', 'install', 'postinstall'].filter(
      (hook) => typeof scripts[hook] === 'string',
    ),
    installScript: typeof scripts.install === 'string' ? scripts.install : null,
    gypfile: manifest === null ? null : manifest.gypfile === true,
    prebuilds: existsSync(prebuildsDir) ? readdirSync(prebuildsDir).sort() : [],
  };
}

/**
 * AC7 — upstream node-pty, installed in the same compiler-less sandbox.
 *
 * The interesting field is `prebuilds`: 1.1.0 ships prebuilt binaries for
 * darwin and win32 and **none for linux**, so whether the install survives is
 * entirely a function of which platform asks. `scripts/prebuild.js` finds a
 * prebuild and exits 0 on a Mac; on Linux it finds nothing, `||` hands over to
 * `node-gyp rebuild`, and the install compiles or dies. Recording only one of
 * the two would be recording the wrong half.
 */
function upstreamPtyProbe(path) {
  const attempt = install(UPSTREAM_PTY_SPEC, path);
  const prebuildsDir = join(attempt.dir, 'node_modules/node-pty/prebuilds');
  return {
    spec: UPSTREAM_PTY_SPEC,
    ok: attempt.ok,
    log: attempt.log,
    installScript: attempt.installScript,
    installScripts: attempt.installScripts,
    prebuilds: existsSync(prebuildsDir) ? readdirSync(prebuildsDir).sort() : [],
    prebuildForThisPlatform: existsSync(join(prebuildsDir, `${process.platform}-${process.arch}`)),
    // `gyp info`/`gyp ERR!` are printed by node-gyp itself, so they appear only
    // when the `||` fallback actually took over — unlike the echoed script line,
    // which npm prints whether or not it ran.
    nodeGypRan: /gyp (info|err)/i.test(attempt.log),
  };
}

function sqliteProbe(installDir) {
  const require = createRequire(join(installDir, 'probe.cjs'));
  const dataDir = scratch('db');
  let Database;
  let db;
  try {
    Database = require('better-sqlite3');
    db = new Database(join(dataDir, 'ledger.db'));
  } catch (error) {
    // A prebuild that installs and then refuses to dlopen is the failure mode
    // this whole story exists to find, so it is a recorded outcome rather than
    // a crashed probe.
    return { loaded: false, failure: String(error?.message ?? error).slice(0, 600) };
  }

  const [{ journal_mode: journalMode }] = db.pragma('journal_mode = WAL');
  const [{ fullfsync }] = db.pragma('fullfsync');
  const [{ synchronous }] = db.pragma('synchronous');
  const { v: version } = db.prepare('select sqlite_version() v').get();

  let created = false;
  const wholeTermMatches = {};
  const fragmentMatches = {};
  let bm25Order = [];
  try {
    db.exec(`create virtual table t using fts5(body, tokenize = "${FTS5_TOKENIZER}")`);
    created = true;
    const insert = db.prepare('insert into t(body) values (?)');
    insert.run('snake_case_name alpha'); // rowid 1
    insert.run('kebab-case-name beta'); // rowid 2
    insert.run('file.ext gamma'); // rowid 3
    // rowid 4: the same term three times in a longer document, so bm25 has a
    // reason to rank it above rowid 1 and insertion order does not.
    insert.run('snake_case_name snake_case_name snake_case_name delta epsilon zeta eta theta');

    const search = db.prepare('select rowid from t where t match ? order by bm25(t)');
    for (const term of WHOLE_TERMS) wholeTermMatches[term] = search.all(`"${term}"`).length;
    for (const fragment of FRAGMENTS)
      fragmentMatches[fragment] = search.all(`"${fragment}"`).length;
    bm25Order = search.all('"snake_case_name"').map((r) => r.rowid);
  } catch (error) {
    return { loaded: true, version, failure: String(error).slice(0, 600) };
  }

  const binding = (process.report.getReport().sharedObjects ?? []).find((object) =>
    object.includes('better-sqlite3'),
  );
  const loadExtension = typeof db.loadExtension === 'function';
  db.close();

  return {
    loaded: true,
    failure: null,
    version,
    binding: binding ?? null,
    loadExtension,
    journalMode,
    fullfsync,
    defaultSynchronous: synchronous,
    fts5: {
      created,
      tokenizer: FTS5_TOKENIZER,
      wholeTermMatches,
      fragmentMatches,
      bm25Order,
      // Insertion order would be [1, 4]; bm25 order is [4, 1].
      bm25Ranked: bm25Order.length === 2 && bm25Order[0] === 4 && bm25Order[1] === 1,
    },
  };
}

/**
 * Spawn `tty` inside a pty and read the device path it prints, then spawn `cat`
 * and check the line comes back — a terminal echoes by default and a pipe does
 * not, so the echo is what distinguishes a real pty from a clever pipe.
 */
async function ptyProbe(installDir) {
  const require = createRequire(join(installDir, 'probe.cjs'));
  let pty;
  try {
    pty = require('@lydell/node-pty');
  } catch (error) {
    return {
      allocated: false,
      device: null,
      echoed: false,
      platformPackage: platformPackageOf(installDir),
      failure: String(error?.message ?? error).slice(0, 600),
      // The package's own loader reports every failure as "Cannot find module",
      // which sends a reader looking for a missing file when the binary is
      // there and simply cannot be linked. dlopen it directly and record what
      // the dynamic linker actually said.
      dlopenFailure: dlopenDirectly(installDir),
    };
  }

  const platformPackage = platformPackageOf(installDir);
  let device = null;
  let echoed = false;
  let failure = null;

  try {
    device = (await runInPty(pty, '/bin/sh', ['-c', 'tty'])).trim().split('\n').pop() ?? null;
  } catch (error) {
    failure = String(error);
  }

  if (failure === null) {
    try {
      const echo = await runInPty(pty, '/bin/cat', [], 'deflow-pty-probe\n');
      echoed = echo.includes('deflow-pty-probe');
    } catch (error) {
      failure = String(error);
    }
  }

  const allocated = typeof device === 'string' && /^\/dev\/(pts\/\d+|ttys?\d+)$/.test(device);
  return {
    allocated,
    device,
    echoed,
    platformPackage,
    failure: allocated && echoed ? null : (failure ?? 'no device path came back from `tty`'),
  };
}

/** The dynamic linker's own account of why the platform binary will not load. */
function dlopenDirectly(installDir) {
  const packageName = platformPackageOf(installDir);
  if (packageName === null) return 'no @lydell/node-pty-* platform package was installed at all';
  const root = join(installDir, 'node_modules', packageName, 'prebuilds');
  if (!existsSync(root)) return `${packageName} ships no prebuilds/ directory`;
  for (const dir of readdirSync(root)) {
    const binary = join(root, dir, 'pty.node');
    if (!existsSync(binary)) continue;
    try {
      process.dlopen({ exports: {} }, binary);
      return `${dir}/pty.node loaded when dlopened directly`;
    } catch (error) {
      return `${dir}/pty.node: ${String(error?.message ?? error).slice(0, 300)}`;
    }
  }
  return `${packageName} ships prebuilds/ but no pty.node inside it`;
}

function platformPackageOf(installDir) {
  const scope = join(installDir, 'node_modules', '@lydell');
  if (!existsSync(scope)) return null;
  const found = readdirSync(scope).find((name) => name.startsWith('node-pty-'));
  return found === undefined ? null : `@lydell/${found}`;
}

function runInPty(pty, file, args, write) {
  return new Promise((resolve, reject) => {
    let output = '';
    let child;
    try {
      child = pty.spawn(file, args, { name: 'xterm-color', cols: 80, rows: 24, cwd: tmpdir() });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pty produced nothing in 10 s (output so far: ${JSON.stringify(output)})`));
    }, 10_000);

    child.onData((chunk) => {
      output += chunk;
      if (write !== undefined && output.includes(write.trim())) {
        clearTimeout(timer);
        child.kill();
        resolve(output);
      }
    });
    child.onExit(() => {
      clearTimeout(timer);
      resolve(output);
    });
    if (write !== undefined) child.write(write);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const cell = valueOf(argv, '--cell') ?? 'local';
  const keep = argv.includes('--keep');

  const path = sandboxPath();
  const report = { cell, environment: environment(path), installs: [] };

  const sqliteInstall = install(BETTER_SQLITE3_SPEC, path);
  report.installs.push(withoutDir(sqliteInstall));
  if (sqliteInstall.ok) report.sqlite = sqliteProbe(sqliteInstall.dir);

  const ptyInstall = install(LYDELL_PTY_SPEC, path);
  report.installs.push(withoutDir(ptyInstall));
  report.pty = ptyInstall.ok
    ? await ptyProbe(ptyInstall.dir)
    : {
        allocated: false,
        device: null,
        echoed: false,
        platformPackage: null,
        failure: `install failed: ${ptyInstall.log.slice(-500)}`,
      };

  report.upstreamPty = upstreamPtyProbe(path);

  process.stdout.write(`${REPORT_MARKER}\n${JSON.stringify(report, null, 2)}\n`);
  if (!keep) for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
}

function withoutDir(result) {
  const { dir: _dir, ...rest } = result;
  return rest;
}

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
