/**
 * KAR-22.1 — projects: create one against a git working tree, list them with
 * the truth about each path, rename one, remove one.
 *
 * The division of labour is the point of this file. `@DeFlow/ledger`'s
 * `./projects.ts` owns the row and performs no I/O; this module owns everything
 * that is a question about the **outside world** — is the path a git working
 * tree, is it still there, which run happened here last — and answers each of
 * them by looking, every time it is asked.
 *
 * **Health is derived, never stored.** A `health` column would be a cache of a
 * filesystem that changes while nobody is watching, and the failure it produces
 * is the worst kind: a list that is confidently wrong. One `stat` and one
 * `git rev-parse` per project per list is cheap at the cardinality a person's
 * machine actually has, and it is always true.
 *
 * **Removing a project touches one table.** There is no `rm` in this file and
 * there must not be one: the repository is the operator's, and KAR-22.1 AC6 is
 * the promise the confirmation dialog makes on this module's behalf.
 */
import type { Clock, Db, ProjectId, RunId, RunStatus } from '@DeFlow/core';
import { initialRunState, mintProjectId, ProjectIdSchema, runStatusLabel } from '@DeFlow/core';
import {
  forgetProject,
  insertProject,
  listProjects,
  type ProjectRecord,
  readProject,
  readProjectByPath,
  renameProject,
  runIdsForProject,
} from '@DeFlow/ledger';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR_ENV } from '../data-dir.ts';
import { runGit } from '../git/run-git.ts';
import type { LedgerView } from '../http/ledger-view.ts';
import {
  bootstrapWorkspace,
  DataDirUnwritable,
  NOT_A_GIT_WORKING_TREE,
  NotAGitWorkingTree,
  type PathReport,
} from '../init/workspace-init.ts';

/** How far back the "most recent run" lookup reads. One row is enough for AC4;
 * a small window costs nothing and leaves room for KAR-22.3's history. */
const LAST_RUN_WINDOW = 1;

/**
 * The three answers AC4 and AC5 need, and they are three rather than two on
 * purpose: "the folder is gone" sends an operator looking for a directory they
 * moved, and "the folder is there and `.git` is not" sends them to `git init`
 * — or to the realisation that they are looking at the wrong place.
 */
export type ProjectHealthState = 'ok' | 'missing' | 'not-a-git-repo';

export interface ProjectHealth {
  readonly state: ProjectHealthState;
  /** `null` only when the state is `ok`; a sentence naming the path otherwise. */
  readonly message: string | null;
}

export interface ProjectLastRun {
  readonly runId: string;
  readonly status: RunStatus;
  /** `runStatusLabel`'s string — the one every surface prints (KAR-19.1 AC6). */
  readonly label: string;
  readonly createdAt: string;
}

export interface ProjectView {
  readonly id: ProjectId;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: ProjectHealth;
  readonly lastRun: ProjectLastRun | null;
}

export interface ProjectPorts {
  readonly db: Db;
  /** The daemon's own data directory — where `bootstrapWorkspace` writes the
   * global half, so a project created through the API and one created by
   * `deflow init` cannot land in two different state directories. */
  readonly dataDir: string;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** The 6-lowercase-hex `ProjectId` suffix. Injected so a spec is reproducible. */
  readonly randomHex: () => string;
}

export type CreateProjectResult =
  | {
      readonly outcome: 'created';
      readonly project: ProjectRecord;
      readonly init: {
        readonly ran: boolean;
        readonly reason?: string;
        readonly paths: readonly PathReport[];
      };
    }
  | { readonly outcome: 'not-a-git-working-tree'; readonly message: string }
  | { readonly outcome: 'no-such-path'; readonly message: string }
  | { readonly outcome: 'exists'; readonly existing: ProjectId }
  | { readonly outcome: 'unwritable'; readonly message: string };

/**
 * The env `bootstrapWorkspace` runs under: **one variable, and no inheritance.**
 *
 * The bootstrap uses its `env` for exactly two things — `resolveDataDir(env)`
 * for the global half, and an override layered *over* `gitChildEnv()` for its
 * one `git rev-parse`. `gitChildEnv()` already supplies everything the child
 * needs to find and run `git`, so spreading `process.env` in here would add
 * nothing except a second place in this package that hands an ambient
 * environment to a child process — which
 * `packages/daemon/test/no-inline-child-env.test.ts` forbids, correctly.
 *
 * Pinning the data directory matters: a daemon started with `--data-dir` would
 * otherwise write a project's global half wherever `$XDG_DATA_HOME` happened to
 * point, which is a directory it never reads.
 */
function bootstrapEnv(dataDir: string): NodeJS.ProcessEnv {
  return { [DATA_DIR_ENV]: dataDir };
}

/** `path` as the store keys it: absolute, symlinks resolved. `null` when
 * nothing is there to resolve. */
async function resolved(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Creates a project against `path`.
 *
 * Order matters and is the same order `initWorkspace` uses: the git check comes
 * first and **nothing is written before it passes**, so a refused create leaves
 * no `.DeFlow/` in a directory that never became a project.
 */
export async function createProject(
  ports: ProjectPorts,
  input: { readonly name: string; readonly path: string },
): Promise<CreateProjectResult> {
  const path = await resolved(input.path);
  if (path === null) {
    return {
      outcome: 'no-such-path',
      message: `there is no directory at ${input.path}`,
    };
  }

  // AC — one directory, one project. Asked **before** anything is written, so
  // a second create against a path that already belongs to a project cannot
  // touch that project's `.DeFlow/` on its way to being refused. The insert's
  // own `ON CONFLICT` below is still what makes this safe against a race; this
  // read is what makes the common case cost nothing.
  const taken = readProjectByPath(ports.db, path);
  if (taken !== null) return { outcome: 'exists', existing: taken.id };

  // Asked before the bootstrap runs, because AC2's condition is "if `.DeFlow/`
  // is absent" and a re-run of `ensureConfigSchema` rewrites a tracked file the
  // operator did not ask to change while creating a project.
  const alreadyInitialised = existsSync(join(path, '.DeFlow'));

  let bootstrap: Awaited<ReturnType<typeof bootstrapWorkspace>> | null = null;
  if (alreadyInitialised) {
    // The git check is `bootstrapWorkspace`'s first act, and skipping the
    // bootstrap must not skip the check — a directory with a `.DeFlow/` in it
    // and no `.git` is still not a project.
    const check = await runGit(path, ['rev-parse', '--show-toplevel']);
    if (check.exitCode !== 0) {
      return { outcome: 'not-a-git-working-tree', message: NOT_A_GIT_WORKING_TREE };
    }
  } else {
    try {
      bootstrap = await bootstrapWorkspace(path, {
        clock: ports.clock,
        env: bootstrapEnv(ports.dataDir),
      });
    } catch (error) {
      if (error instanceof NotAGitWorkingTree) {
        return { outcome: 'not-a-git-working-tree', message: NOT_A_GIT_WORKING_TREE };
      }
      if (error instanceof DataDirUnwritable) {
        return { outcome: 'unwritable', message: error.message };
      }
      throw error;
    }
  }

  const now = ports.clock.now();
  const record: ProjectRecord = {
    id: mintProjectId(now, ports.randomHex),
    name: input.name,
    path,
    createdAt: now,
    updatedAt: now,
  };

  const stored = insertProject(ports.db, record);
  if (stored.outcome === 'exists') return { outcome: 'exists', existing: stored.existing };

  return {
    outcome: 'created',
    project: record,
    init:
      bootstrap === null
        ? { ran: false, reason: 'this repository was already initialised', paths: [] }
        : { ran: true, paths: bootstrap.paths },
  };
}

/** The health of `path`, asked of the filesystem and of git, right now. */
async function healthOf(path: string): Promise<ProjectHealth> {
  if (!existsSync(path)) {
    return {
      state: 'missing',
      message: `${path} is no longer there — it was moved, renamed or deleted`,
    };
  }
  const check = await runGit(path, ['rev-parse', '--show-toplevel']);
  if (check.exitCode !== 0) {
    return {
      state: 'not-a-git-repo',
      message: `${path} still exists but is no longer a git working tree`,
    };
  }
  return { state: 'ok', message: null };
}

/**
 * The most recent run submitted against `id`, or `null`.
 *
 * `label` is `runStatusLabel`'s and is not derived here: there is one producer
 * of a run's human-readable status, and a projects list that wrote its own
 * adjective would be a fourth surface describing one run in its own words.
 */
function lastRunOf(
  ports: ProjectPorts,
  view: LedgerView | null,
  id: ProjectId,
): ProjectLastRun | null {
  const [runId] = runIdsForProject(ports.db, id, LAST_RUN_WINDOW);
  if (runId === undefined || view === null) return null;

  // A cast rather than a parse: this id came out of the `event` table's own
  // `run_id` column, so it is a `RunId` by construction — and re-parsing it
  // would let a schema change turn a run that exists into a crash.
  const of = runId as RunId;
  const state = view.runState(of) ?? initialRunState();
  const first = view.tail(of, 0, 1)[0];
  return {
    runId,
    status: state.status,
    label: runStatusLabel(state),
    createdAt: new Date(first?.ts ?? 0).toISOString(),
  };
}

const toView = async (
  ports: ProjectPorts,
  view: LedgerView | null,
  record: ProjectRecord,
): Promise<ProjectView> => ({
  id: record.id,
  name: record.name,
  path: record.path,
  createdAt: new Date(record.createdAt).toISOString(),
  health: await healthOf(record.path),
  lastRun: lastRunOf(ports, view, record.id),
});

/**
 * Every project, with its health and its most recent run.
 *
 * Nothing is filtered. AC5's *"is not silently dropped"* is the whole shape of
 * this function: a list that hid unhealthy rows would answer "where did my
 * project go?" with silence, and the operator's next move — recreate it — mints
 * a second id and strands every run stamped with the first.
 */
export async function projectViews(
  ports: ProjectPorts,
  view: LedgerView | null,
): Promise<readonly ProjectView[]> {
  const records = listProjects(ports.db);
  return Promise.all(records.map((record) => toView(ports, view, record)));
}

export async function projectView(
  ports: ProjectPorts,
  view: LedgerView | null,
  id: ProjectId,
): Promise<ProjectView | null> {
  const record = readProject(ports.db, id);
  return record === null ? null : toView(ports, view, record);
}

/** Renames a project. `null` when this daemon holds no such project. */
export async function rename(
  ports: ProjectPorts,
  view: LedgerView | null,
  id: ProjectId,
  name: string,
): Promise<ProjectView | null> {
  if (!renameProject(ports.db, id, name, ports.clock.now())) return null;
  return projectView(ports, view, id);
}

/**
 * Removes a project's row — and only its row.
 *
 * The sentence is returned rather than left to the caller, so that the CLI, the
 * API and the browser all say the same thing about what a removal does and does
 * not do.
 */
export const REMOVAL_KEEPS_FILES =
  'the project was removed from DeFlow; no files on disk were deleted';

export function remove(
  ports: ProjectPorts,
  id: ProjectId,
): { readonly removed: boolean; readonly message: string } {
  return { removed: forgetProject(ports.db, id), message: REMOVAL_KEEPS_FILES };
}

/** `raw` as a `ProjectId`, or `null` for anything that is not one. */
export function asProjectId(raw: string): ProjectId | null {
  const parsed = ProjectIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** True when this daemon holds a project with `id`. */
export function projectExists(db: Db, id: ProjectId): boolean {
  return readProject(db, id) !== null;
}

/**
 * KAR-22.3 AC4 — why a run cannot be started in this project right now, or
 * `null` when it can.
 *
 * The sentence is `healthOf`'s, unmodified, and that is the point: the projects
 * list, the workspace header and this refusal all say the same thing about the
 * same directory because there is one place that describes it. A refusal that
 * wrote its own words would be a second description of one fact, and the two
 * would drift the first time either was edited.
 *
 * `null` for a project this daemon does not hold: that is a *different*
 * refusal, and intake already makes it (`no project '…' on this machine`).
 */
export async function projectPathProblem(db: Db, id: ProjectId): Promise<string | null> {
  const record = readProject(db, id);
  if (record === null) return null;
  return (await healthOf(record.path)).message;
}
