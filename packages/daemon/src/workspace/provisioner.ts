/**
 * KAR-07.5 — making a fresh worktree *work* before the agent's first turn
 * (docs/09-workspace-and-safety.md §5).
 *
 * Every worktree tool creates worktrees; almost none of them make the worktree
 * usable, and Claude Code's own docs concede the gap ("a worktree is a fresh
 * checkout, so initialize your development environment there: ask Claude to
 * install dependencies"). Asking the *agent* to do it costs a full turn of
 * paid quota to discover that `pnpm test` fails because `node_modules` does
 * not exist. This module spends a subprocess instead.
 *
 * Three layers, run in that order, on top of KAR-07.2's `WorkspaceManager`:
 *
 * 1. **Copy gitignored config** — `.worktreeinclude`, matched by real git.
 *    Each copy preserves its source's mode and produces a
 *    `workspace.included_file` event naming the *path only*.
 * 2. **Package-manager-native sharing** — the lockfile decides the command,
 *    and two lockfiles is a refusal rather than a precedence rule.
 * 3. **`workspace.setup`**, cached on the sha256 of its `setupCacheKey` files,
 *    with its output streamed to `io_chunk` against the node and a non-zero
 *    exit failing provisioning *before* an agent is spawned.
 *
 * Two ordering decisions carry the story:
 *
 * - **Setup failure removes the worktree by the ordinary clean-removal path.**
 *   Not by force: a worktree whose install failed has no agent work in it, so
 *   KAR-07.2's unlock-then-remove succeeds, and reaching for `--force` here
 *   would put the double form back on the completion path that
 *   test/double-force-reachability.test.ts exists to keep it off.
 * - **The success marker is written only after a zero exit**, so a failed
 *   install never teaches the next worktree to skip its own.
 *
 * A known consequence of AC5, recorded rather than papered over: on a
 * filesystem with no reflink, the second worktree on an unchanged lockfile
 * skips setup (EPIC-07-S21 is explicit that the shim records one invocation in
 * total) and therefore has no `node_modules` of its own. Where cloning works —
 * APFS, btrfs, XFS — the §5.2 fast path fills that in for free. Caching is
 * opt-in through `setupCacheKey` precisely so a project that cannot accept
 * that trade-off can decline it by leaving the key empty.
 *
 * Verifies: EPIC-07-S19, EPIC-07-S20, EPIC-07-S21, EPIC-07-S22 · AC1–AC7
 */
import type { Clock, Db, NodeId, RunId } from '@DeFlow/core';
import { appendEvents, appendIoChunk } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ProvisionRequest,
  ProvisionResult,
  WorkspaceGit,
  WorkspaceManager,
} from '../git/worktree-manager.ts';
import { detectPackageManager, type PackageManagerSetup } from './package-manager.ts';
import {
  assertNoSharedNodeModules,
  type IncludedFile,
  type ProvisionPlan,
  planWorktreeProvision,
} from './provision-plan.ts';
import { cloneTree, probeReflink, type ReflinkProbe } from './reflink.ts';
import { type SetupRunner, type SetupStream, setupChildEnv, spawnSetup } from './run-setup.ts';
import { type CacheKeyFile, markerFileName, setupCacheKey } from './setup-cache.ts';
import {
  GITIGNORED_AMONG_ARGS,
  INCLUDE_MATCH_ARGS_TRACKED,
  INCLUDE_MATCH_ARGS_UNTRACKED,
  type IncludeCandidate,
  includedFiles,
  splitNul,
  WORKTREE_INCLUDE_FILE,
} from './worktree-include.ts';

/** `DeFlow.config.ts`'s `workspace` block (§5.1). */
export interface WorkspaceConfig {
  /** The command run once per distinct dependency state. Falls back to the
   * lockfile's own install command when absent. */
  readonly setup?: string;
  /**
   * Repo-relative files whose contents key the success marker. Absent means
   * "the detected lockfile"; an **empty array** means no caching at all, and
   * setup runs for every worktree.
   */
  readonly setupCacheKey?: readonly string[];
  /** Overrides `.worktreeinclude`, for a repository that already uses that
   * filename for something else. */
  readonly worktreeInclude?: string;
}

export interface ProvisionerPorts {
  readonly git: WorkspaceGit;
  readonly db: Db;
  readonly clock: Clock;
  readonly epoch: number;
  /** KAR-07.2's lifecycle. This module adds to it; it does not replace it. */
  readonly manager: WorkspaceManager;
  /** The main checkout — the source of every copy and of the lockfile. */
  readonly repoRoot: string;
  readonly config: WorkspaceConfig;
  /** Where success markers live. Defaults to `<repoRoot>/.DeFlow/setup`. */
  readonly markerDir?: string;
  /** The environment the setup command inherits. Defaults to the daemon's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runSetup?: SetupRunner;
  readonly probeReflink?: ReflinkProbe;
}

/** What `provision` did beyond creating the worktree. */
export interface EnvironmentResult {
  /** Repo-relative paths copied by Layer 1, sorted. */
  readonly copied: readonly string[];
  /** The command Layer 2/3 chose, or `null` when nothing declared one. */
  readonly setupCommand: string | null;
  /** The marker key, or `null` when caching is off for this repository. */
  readonly cacheKey: string | null;
  readonly cacheHit: boolean;
  readonly reflinkSupported: boolean;
  readonly plan: ProvisionPlan;
}

export interface ProvisionedWorkspace extends ProvisionResult {
  readonly environment: EnvironmentResult;
}

export interface EnvironmentRequest {
  readonly runId: string;
  readonly nodeId: string;
  /** 1-based, matching `io_chunk.attempt`. */
  readonly attempt: number;
  readonly worktreePath: string;
}

export type ProvisionWorkspaceRequest = ProvisionRequest & { readonly attempt: number };

/** How much of the setup command's stderr the failure carries. Bounded: the
 * daemon supervises runs for days and an install can print megabytes. */
export const SETUP_STDERR_TAIL_BYTES = 8 * 1024;

/**
 * `workspace.setup` exited non-zero, so no agent was spawned (AC4).
 *
 * The exit code and the stderr tail are on the error because they are the only
 * two things that make this actionable — `ERR_PNPM_OUTDATED_LOCKFILE` names
 * the fix, and a failure that reached a human without it would send them to
 * read a transcript. The worktree is already gone by the time this is thrown.
 */
export class WorkspaceSetupFailed extends Error {
  readonly command: string;
  readonly exitCode: number;
  readonly stderrTail: string;
  readonly path: string;

  constructor(command: string, path: string, exitCode: number, stderrTail: string) {
    super(
      `The workspace setup command "${command}" exited ${exitCode} in "${path}", so provisioning ` +
        'failed before any agent was spawned — a node whose dependencies did not install would ' +
        `burn a whole turn discovering it. Its stderr ended: ${stderrTail.trim()}`,
    );
    this.name = 'WorkspaceSetupFailed';
    this.command = command;
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.path = path;
  }
}

const MODE_MASK = 0o777;

/** `'0600'` — four octal digits, the shape `WorkspaceIncludedFileSchema` pins. */
const octal = (mode: number): string => (mode & MODE_MASK).toString(8).padStart(4, '0');

export class WorkspaceProvisioner {
  readonly #ports: ProvisionerPorts;
  readonly #runSetup: SetupRunner;
  readonly #probe: ReflinkProbe;
  readonly #markerDir: string;

  constructor(ports: ProvisionerPorts) {
    this.#ports = ports;
    this.#runSetup = ports.runSetup ?? spawnSetup;
    this.#probe = ports.probeReflink ?? probeReflink;
    this.#markerDir = ports.markerDir ?? join(ports.repoRoot, '.DeFlow', 'setup');
  }

  /**
   * KAR-07.2's `provision`, then the three layers — and the worktree removed
   * again if any of them fails.
   *
   * The removal is the ordinary clean path, and it happens for *every* failure
   * here rather than only for a setup failure: an ambiguous lockfile leaves a
   * worktree behind just as surely, and a half-provisioned worktree that
   * nothing owns is exactly what the boot reaper is bad at.
   */
  async provision(request: ProvisionWorkspaceRequest): Promise<ProvisionedWorkspace> {
    const created = await this.#ports.manager.provision(request);

    try {
      const environment = await this.setUpEnvironment({
        runId: request.runId,
        nodeId: request.nodeId,
        attempt: request.attempt,
        worktreePath: request.path,
      });
      return { ...created, environment };
    } catch (error) {
      // The cleanup must not become the reported failure: a removal that also
      // fails leaves *two* problems, and the one worth telling the operator
      // about is still the lockfile or the install that started it.
      await this.#ports.manager
        .remove({
          runId: request.runId,
          nodeId: request.nodeId,
          path: request.path,
          ...(created.branch === null ? {} : { branch: created.branch }),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /** The three layers, over a worktree that already exists. */
  async setUpEnvironment(request: EnvironmentRequest): Promise<EnvironmentResult> {
    const includes = await this.#layer1();
    const detected = await this.#detectManager();
    const setupCommand = this.#ports.config.setup ?? detected?.command ?? null;

    const keyFiles = this.#cacheKeyFiles(detected);
    const cacheKey =
      keyFiles.length === 0 ? null : setupCacheKey(await this.#readKeyFiles(keyFiles));

    // §5.2's order, and it is the acceptance criterion rather than an
    // optimisation: the probe is only *reached* when there is a tree worth
    // cloning, and the clone only when the probe cloned a byte for real.
    const hasSourceNodeModules = await pathExists(join(this.#ports.repoRoot, 'node_modules'));
    const reflinkSupported = hasSourceNodeModules && (await this.#probe(request.worktreePath));
    const plan = planWorktreeProvision({
      repoRoot: this.#ports.repoRoot,
      worktreePath: request.worktreePath,
      includes,
      setupCommand,
      reflinkSupported,
      hasSourceNodeModules,
    });
    // §5.1's hard rule, checked before a single step runs rather than only in
    // ./provision-plan.test.ts.
    assertNoSharedNodeModules(plan);

    const cacheHit = cacheKey !== null && (await this.#markerExists(cacheKey));
    if (cacheHit) {
      this.#append(request, 'workspace.setup_cache_hit', {
        node: request.nodeId,
        key: cacheKey,
        files: keyFiles,
      });
    }

    for (const step of plan) {
      if (step.kind === 'copy') {
        await mkdir(dirname(step.to), { recursive: true });
        await writeFile(step.to, await readFile(step.from));
        // Written then chmod'ed rather than `copyFile`, whose destination mode
        // is the *source's* only when the destination did not already exist —
        // and a worktree checked out from a branch that tracks the file makes
        // it exist.
        await chmod(step.to, step.mode);
        this.#append(request, 'workspace.included_file', {
          node: request.nodeId,
          path: step.path,
          mode: octal(step.mode),
        });
      } else if (step.kind === 'clone') {
        await cloneTree(step.from, step.to);
      } else if (step.kind === 'run' && !cacheHit) {
        await this.#runSetupStep(request, step.command, step.cwd);
        if (cacheKey !== null) await this.#writeMarker(cacheKey);
      }
    }

    return {
      copied: includes.map((file) => file.path),
      setupCommand,
      cacheKey,
      cacheHit,
      reflinkSupported,
      plan,
    };
  }

  /**
   * Layer 1 — `.worktreeinclude`, decided by real git and copied by this
   * module (AC1, AC2).
   *
   * Three invocations, because the decision has three inputs and none of them
   * is inferable from another: which paths the patterns match while untracked,
   * which they match while *tracked* (listed only to be refused), and which of
   * the first set `.gitignore` actually ignores.
   */
  async #layer1(): Promise<IncludedFile[]> {
    const includePath = join(
      this.#ports.repoRoot,
      this.#ports.config.worktreeInclude ?? WORKTREE_INCLUDE_FILE,
    );
    if (!(await pathExists(includePath))) return [];

    const untracked = await this.#lines(INCLUDE_MATCH_ARGS_UNTRACKED(includePath));
    const tracked = await this.#lines(INCLUDE_MATCH_ARGS_TRACKED(includePath));
    const ignored =
      untracked.length === 0
        ? new Set<string>()
        : new Set(await this.#lines(GITIGNORED_AMONG_ARGS(untracked)));

    const candidates: IncludeCandidate[] = [
      ...untracked.map((path) => ({
        path,
        matchesPattern: true,
        gitignored: ignored.has(path),
        tracked: false,
      })),
      ...tracked.map((path) => ({
        path,
        matchesPattern: true,
        gitignored: true,
        tracked: true,
      })),
    ];

    const chosen = includedFiles(candidates);
    const files: IncludedFile[] = [];
    for (const path of chosen) {
      const info = await stat(join(this.#ports.repoRoot, path)).catch(() => null);
      // A file `ls-files` listed and `stat` cannot see was deleted between the
      // two calls. Skipping it is right: there is nothing to copy, and failing
      // provisioning over a file the user just removed would be absurd.
      if (info === null || !info.isFile()) continue;
      files.push({ path, mode: info.mode & MODE_MASK });
    }
    return files;
  }

  /** Layer 2 — the lockfile decides, and two lockfiles decide nothing (AC3). */
  async #detectManager(): Promise<PackageManagerSetup | null> {
    return detectPackageManager(await readdir(this.#ports.repoRoot).catch(() => []));
  }

  /** Absent means "the detected lockfile"; `[]` means no caching (S20). */
  #cacheKeyFiles(detected: PackageManagerSetup | null): string[] {
    const declared = this.#ports.config.setupCacheKey;
    if (declared !== undefined) return [...declared];
    return detected === null ? [] : [detected.lockfile];
  }

  async #readKeyFiles(paths: readonly string[]): Promise<CacheKeyFile[]> {
    const files: CacheKeyFile[] = [];
    for (const path of paths) {
      const bytes = await readFile(join(this.#ports.repoRoot, path)).catch(() => null);
      files.push({ path, bytes: bytes === null ? null : new Uint8Array(bytes) });
    }
    return files;
  }

  /** Layer 3's run, with the transcript in `io_chunk` and nowhere else (AC4). */
  async #runSetupStep(request: EnvironmentRequest, command: string, cwd: string): Promise<void> {
    let stderrTail = '';
    const outcome = await this.#runSetup({
      command,
      cwd,
      env: this.#ports.env ?? setupChildEnv(),
      onChunk: (stream: SetupStream, data: Uint8Array) => {
        appendIoChunk(this.#ports.db, {
          runId: request.runId as RunId,
          nodeId: request.nodeId as NodeId,
          attempt: request.attempt,
          stream,
          ts: this.#ports.clock.now(),
          data,
        });
        if (stream === 'stderr') {
          stderrTail = `${stderrTail}${Buffer.from(data).toString('utf8')}`.slice(
            -SETUP_STDERR_TAIL_BYTES,
          );
        }
      },
    });

    if (outcome.exitCode !== 0) {
      throw new WorkspaceSetupFailed(command, cwd, outcome.exitCode, stderrTail);
    }
  }

  async #markerExists(key: string): Promise<boolean> {
    return pathExists(join(this.#markerDir, markerFileName(key)));
  }

  /** Written only after a zero exit, so a failed install never teaches the
   * next worktree to skip its own. */
  async #writeMarker(key: string): Promise<void> {
    await mkdir(this.#markerDir, { recursive: true });
    await writeFile(join(this.#markerDir, markerFileName(key)), `${key}\n`);
  }

  /** One `-z` git read, in the repository root. */
  async #lines(args: readonly string[]): Promise<string[]> {
    const result = await this.#ports.git.run(args, { cwd: this.#ports.repoRoot });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0] ?? ''} exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
    return splitNul(result.stdout);
  }

  #append(request: EnvironmentRequest, kind: string, payload: unknown): void {
    appendEvents(this.#ports.db, [
      {
        runId: request.runId as RunId,
        ts: this.#ports.clock.now(),
        kind,
        v: 1,
        epoch: this.#ports.epoch,
        nodeId: request.nodeId as NodeId,
        payload,
      },
    ]);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
