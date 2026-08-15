/**
 * KAR-18.1 — `deflow init`'s workspace bootstrap.
 *
 * Two halves of `.DeFlow/` are not interchangeable (docs/16-repo-layout.md
 * §7.1). `config.yaml`, `gates/`, `templates/`, `memory/` and
 * `.worktreeinclude` are **team artefacts**: this function writes them inside
 * the repository, and never overwrites one that already exists. `daemon.json`,
 * `wt/` and `runs/` are per-machine, so it appends them to the repository's
 * own `.gitignore` instead of creating them, and the global state directory
 * they would live under (`$XDG_DATA_HOME/DeFlow`, else `~/.DeFlow`) is created
 * outside the repository entirely. Provider detection runs here too (PRD
 * §6.3), and its result is written *only* to that global directory — a
 * committed capability list is exactly the hardcoded matrix AR-5 forbids.
 */
import type { Clock } from '@DeFlow/core';
import { mintRunId, ProviderIdSchema } from '@DeFlow/core';
import {
  openLedger,
  readEpoch,
  readProviderCapabilities,
  recordProviderCapabilities,
} from '@DeFlow/ledger';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { CONFIG_RELATIVE_PATH, writeWorkspaceConfig } from '../config/workspace-config.ts';
import { resolveDataDir } from '../data-dir.ts';
import { sqliteLedgerSink } from '../exec/ledger-sink.ts';
import { runGit } from '../git/run-git.ts';
import { detectProviders, type ProviderDetectionEntry } from '../providers/detect.ts';
import { WORKTREE_INCLUDE_FILE } from '../workspace/worktree-include.ts';
import {
  CONFIG_SCHEMA_FILE,
  configJsonSchema,
  validateAgainstConfigSchema,
} from './config-schema.ts';
import { GITIGNORE_ENTRIES, mergeGitignore } from './gitignore-merge.ts';

/** AC4 — the exit code `runInit` (packages/cli) maps both refusals to. */
export const INIT_EX_REFUSED = 5;

/**
 * KAR-22.1 AC1 — the refusal for a path that is not a git working tree, as
 * **one exported string**.
 *
 * `deflow init` throws it and `POST /api/projects` returns it. Two copies would
 * agree on the day they were written and disagree on the day one of them was
 * improved, and nothing would fail — each surface's own spec asserts its own
 * copy. `packages/daemon/src/init/not-a-git-working-tree.test.ts` is what says
 * they are the same string.
 *
 * One line, because it is rendered under a form field as well as printed to a
 * terminal.
 */
export const NOT_A_GIT_WORKING_TREE =
  "deflow init: not inside a git working tree (run 'git init' first)";

export class NotAGitWorkingTree extends Error {
  readonly cwd: string;

  constructor(cwd: string) {
    super(NOT_A_GIT_WORKING_TREE);
    this.name = 'NotAGitWorkingTree';
    this.cwd = cwd;
  }
}

export class DataDirUnwritable extends Error {
  readonly path: string;
  readonly code: string;

  constructor(path: string, code: string, cause: unknown) {
    super(
      `deflow init: could not create the global state directory at ${path} (${code}) — set ` +
        'XDG_DATA_HOME to a writable location, or fix the permissions on this one, and try again',
      { cause },
    );
    this.name = 'DataDirUnwritable';
    this.path = path;
    this.code = code;
  }
}

export type PathStatus = 'created' | 'unchanged' | 'updated' | 'kept (edited)';

export interface PathReport {
  /** Repo-relative, as it would appear in `git status`. */
  readonly relativePath: string;
  readonly status: PathStatus;
}

export interface InitPorts {
  /** Time enters here and nowhere else (NF9); also seeds the probe session id. */
  readonly clock: Clock;
  /** `PATH`, `XDG_DATA_HOME` / `DeFlow_DATA_DIR` all come from here. */
  readonly env: NodeJS.ProcessEnv;
}

export interface InitReport {
  /** The git working tree's top level — the directory `.DeFlow/` was written into. */
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly paths: readonly PathReport[];
  readonly providers: readonly ProviderDetectionEntry[];
}

const DEFAULT_WORKTREE_INCLUDE =
  '# DeFlow — Layer 1 gitignored-file copy into fresh worktrees (docs/09 §5.1).\n' +
  '# One gitignore-syntax pattern per line. A file is copied into a fresh\n' +
  '# worktree only when it matches a pattern here *and* is gitignored — add a\n' +
  '# pattern below for anything a node needs that git does not track.\n';

function ensureDir(path: string, relativePath: string): PathReport {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true });
  return { relativePath, status: existed ? 'unchanged' : 'created' };
}

function ensureFile(path: string, defaultContent: string, relativePath: string): PathReport {
  if (existsSync(path)) return { relativePath, status: 'unchanged' };
  writeFileSync(path, defaultContent);
  return { relativePath, status: 'created' };
}

/**
 * AC3 — `config.yaml` is never overwritten. `'kept (edited)'` when its bytes
 * differ from what a fresh `init` would generate; `'unchanged'` when they
 * still match — both are "we did not touch it", and the word only tells the
 * operator whether that is because they edited it.
 */
function ensureConfigYaml(repoRoot: string): PathReport {
  const path = join(repoRoot, CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) {
    writeWorkspaceConfig(repoRoot, {});
    return { relativePath: CONFIG_RELATIVE_PATH, status: 'created' };
  }
  const current = readFileSync(path, 'utf8');
  const fresh = stringifyYaml({});
  return {
    relativePath: CONFIG_RELATIVE_PATH,
    status: current === fresh ? 'unchanged' : 'kept (edited)',
  };
}

/** AC2 — the JSON Schema `config.yaml` validates against, inside the run
 * directory's own `.DeFlow/schemas/`. Deterministic, generated content: it is
 * (re)written whenever it differs, never treated as something an operator
 * edits by hand. */
function ensureConfigSchema(deflowDir: string): PathReport {
  const dir = join(deflowDir, 'schemas');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CONFIG_SCHEMA_FILE);
  const serialized = `${JSON.stringify(configJsonSchema(), null, 2)}\n`;
  const existed = existsSync(path);
  const unchanged = existed && readFileSync(path, 'utf8') === serialized;
  if (!unchanged) writeFileSync(path, serialized);
  return {
    relativePath: `.DeFlow/schemas/${CONFIG_SCHEMA_FILE}`,
    status: existed ? (unchanged ? 'unchanged' : 'updated') : 'created',
  };
}

function pathRoots(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter((entry) => entry !== '');
}

/**
 * `RunGitOptions.env` is `Record<string, string>` — no `undefined` — because
 * it is merged *over* `gitChildEnv()`'s own `process.env`-based default
 * (docs/09 §1.1's git wrapper). Stripping the absent keys here, rather than
 * passing `ports.env` straight through, is what lets a spec's `env` stand in
 * for `process.env` entirely instead of only contributing the keys it set.
 */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** The 6-lowercase-hex suffix `mintRunId` needs — same source `boot.ts` uses
 * for the same reason: unique, never reproducible. */
function randomRunIdSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** What `bootstrapWorkspace` writes: everything `initWorkspace` does except
 * the provider detection pass. */
export type WorkspaceBootstrap = Omit<InitReport, 'providers'>;

/**
 * The files half of `deflow init`: the committed half of `.DeFlow/`, the
 * `.gitignore` entries for the per-machine half, and the global state
 * directory.
 *
 * Split out of `initWorkspace` for KAR-22.1, which needs exactly this and
 * deliberately **not** the provider detection pass below it. A daemon is told
 * which machine it is on by its caller — `boot`'s `providerRoots`, omitted
 * meaning "do not search" — and a route that probed whatever `PATH` DeFlowd
 * inherited would be a second producer of provider state beside KAR-19.10's.
 * Three surfaces disagreeing about which providers work is the defect EPIC-19
 * shipped to end, and the cheapest way not to reintroduce it is not to write
 * the second producer.
 *
 * Throws `NotAGitWorkingTree` when `cwd` is not inside a git working tree —
 * **before anything is written** — and `DataDirUnwritable` when the global
 * state directory cannot be created.
 */
export async function bootstrapWorkspace(
  cwd: string,
  ports: InitPorts,
): Promise<WorkspaceBootstrap> {
  const check = await runGit(cwd, ['rev-parse', '--show-toplevel'], {
    env: definedEnv(ports.env),
  });
  if (check.exitCode !== 0) throw new NotAGitWorkingTree(cwd);
  const repoRoot = check.stdout.trim();

  const deflowDir = join(repoRoot, '.DeFlow');
  mkdirSync(deflowDir, { recursive: true });

  const paths: PathReport[] = [];
  paths.push(ensureConfigYaml(repoRoot));
  for (const name of ['gates', 'templates', 'memory'] as const) {
    paths.push(ensureDir(join(deflowDir, name), `.DeFlow/${name}/`));
  }
  paths.push(
    ensureFile(
      join(deflowDir, WORKTREE_INCLUDE_FILE),
      DEFAULT_WORKTREE_INCLUDE,
      `.DeFlow/${WORKTREE_INCLUDE_FILE}`,
    ),
  );
  paths.push(ensureConfigSchema(deflowDir));

  // AC2 — validated the run it was generated; an operator's own edit is
  // theirs to keep, not `init`'s to police on every re-run.
  const configReport = paths.find((entry) => entry.relativePath === CONFIG_RELATIVE_PATH);
  if (configReport?.status === 'created') {
    const validation = validateAgainstConfigSchema(configJsonSchema(), {});
    if (!validation.valid) {
      throw new Error(
        `deflow init: the config.yaml it just generated does not validate against ` +
          `.DeFlow/schemas/${CONFIG_SCHEMA_FILE}: ${JSON.stringify(validation.errors)}`,
      );
    }
  }

  // AC1, AC3 — the per-machine half, appended once and never duplicated.
  const gitignorePath = join(repoRoot, '.gitignore');
  const existingGitignore = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, 'utf8')
    : undefined;
  const merged = mergeGitignore(existingGitignore, GITIGNORE_ENTRIES);
  if (merged.added.length > 0) writeFileSync(gitignorePath, merged.content);
  paths.push({
    relativePath: '.gitignore',
    status:
      existingGitignore === undefined
        ? 'created'
        : merged.added.length > 0
          ? 'updated'
          : 'unchanged',
  });

  // AC5 — the global state directory.
  const dataDir = resolveDataDir(ports.env);
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new DataDirUnwritable(dataDir, code, error);
  }

  return { repoRoot, dataDir, paths };
}

/**
 * Bootstraps `cwd`'s repository — `bootstrapWorkspace` above — and then runs a
 * provider detection pass whose result is written only into the global state
 * directory (PRD §6.3; a committed capability list is the hardcoded matrix AR-5
 * forbids).
 *
 * This is `deflow init`'s entry point and the only caller that wants the probe:
 * it runs in the operator's own terminal, so the `PATH` it searches is the
 * operator's own.
 */
export async function initWorkspace(cwd: string, ports: InitPorts): Promise<InitReport> {
  const { repoRoot, dataDir, paths } = await bootstrapWorkspace(cwd, ports);

  // AC6 — provider detection, written only into `dataDir`.
  const db = openLedger(dataDir);
  let providers: readonly ProviderDetectionEntry[];
  try {
    const runId = mintRunId(ports.clock.now(), randomRunIdSuffix);
    const epoch = readEpoch(db);
    const scratchDir = join(dataDir, 'init-probe');
    providers = await detectProviders({
      roots: pathRoots(ports.env),
      clock: ports.clock,
      env: ports.env,
      capabilities: {
        record: (row) => recordProviderCapabilities(db, row),
        read: (provider) =>
          readProviderCapabilities(db, provider).map((row) => ({
            ...row,
            provider: ProviderIdSchema.parse(row.provider),
          })),
      },
      ledger: sqliteLedgerSink({ db, runId, epoch, dataDir }),
      scratchDir,
    });
    rmSync(scratchDir, { recursive: true, force: true });
  } finally {
    db.close();
  }

  return { repoRoot, dataDir, paths, providers };
}
